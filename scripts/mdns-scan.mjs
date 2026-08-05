#!/usr/bin/env node
/**
 * Ad-hoc mDNS / DNS-SD scanner — a diagnostic, not part of the CLI.
 *
 * Written to answer "does the TV advertise anything over Bonjour?", since
 * `lgtv discover` only speaks SSDP. It enumerates service types via
 * `_services._dns-sd._udp.local`, then asks for the instances of each and
 * prints their SRV/TXT/A records.
 *
 *   node scripts/mdns-scan.mjs                       # all interfaces, port 5353
 *   MDNS_IFACE=192.168.0.29 node scripts/mdns-scan.mjs
 *   MDNS_QU=1 MDNS_IFACE=192.168.0.29 node scripts/mdns-scan.mjs
 *
 * Two gotchas this script exists to work around:
 *
 * 1. A host running avahi-daemon already holds port 5353. Linux hands each
 *    incoming multicast datagram to only one socket in the SO_REUSEPORT group,
 *    so binding 5353 alongside avahi can silently receive nothing. MDNS_QU=1
 *    binds an ephemeral port instead and sets the unicast-response (QU) bit,
 *    which asks responders to reply straight to us.
 * 2. On a machine with docker bridges the default multicast route often is not
 *    the LAN. MDNS_IFACE pins the membership and outgoing interface to the
 *    address you actually want to scan from.
 *
 * No output at all — not even a printer — usually means the AP is filtering
 * multicast or isolating clients, rather than "nothing advertises".
 */
import dgram from "node:dgram";

const MCAST = "224.0.0.251";
const PORT = 5353;

const RECORD_TYPE_LABELS = { 1: "A", 33: "SRV" };
const recordTypeLabel = (type) => RECORD_TYPE_LABELS[type] ?? "TXT";
const IFACE = process.env.MDNS_IFACE ?? "0.0.0.0";
const UNICAST_REPLY = process.env.MDNS_QU === "1";
const PINNED = IFACE !== "0.0.0.0";

const encodeName = (name) =>
	Buffer.concat([
		...name
			.split(".")
			.filter(Boolean)
			.map((part) => {
				const label = Buffer.from(part, "utf8");
				return Buffer.concat([Buffer.from([label.length]), label]);
			}),
		Buffer.from([0]),
	]);

const query = (names) => {
	const header = Buffer.alloc(12);
	header.writeUInt16BE(names.length, 4); // QDCOUNT; id/flags stay 0 for mDNS
	const questions = names.map((name) => {
		const tail = Buffer.alloc(4);
		tail.writeUInt16BE(12, 0); // PTR
		tail.writeUInt16BE(UNICAST_REPLY ? 0x8001 : 1, 2); // class IN, high bit = QU
		return Buffer.concat([encodeName(name), tail]);
	});
	return Buffer.concat([header, ...questions]);
};

/** Reads a possibly compressed name; returns [name, offset after the field]. */
const readName = (buf, offset) => {
	const labels = [];
	let next = offset;
	let jumped = false;
	for (let guard = 0; guard < 128; guard++) {
		const len = buf[offset];
		if (len === undefined || len === 0) {
			if (!jumped) next = offset + 1;
			break;
		}
		if ((len & 0xc0) === 0xc0) {
			const pointer = ((len & 0x3f) << 8) | buf[offset + 1];
			if (!jumped) next = offset + 2;
			jumped = true;
			offset = pointer;
			continue;
		}
		labels.push(buf.subarray(offset + 1, offset + 1 + len).toString("utf8"));
		offset += 1 + len;
	}
	return [labels.join("."), next];
};

const readTxt = (buf, start, length) => {
	const strings = [];
	let p = start;
	while (p < start + length) {
		const len = buf[p];
		strings.push(buf.subarray(p + 1, p + 1 + len).toString("utf8"));
		p += 1 + len;
	}
	return strings.join(" | ");
};

const parse = (buf) => {
	const counts = [4, 6, 8, 10].map((at) => buf.readUInt16BE(at));
	let offset = 12;
	for (let i = 0; i < counts[0]; i++) offset = readName(buf, offset)[1] + 4; // skip questions

	const records = [];
	for (let i = 0; i < counts[1] + counts[2] + counts[3]; i++) {
		const [name, afterName] = readName(buf, offset);
		const type = buf.readUInt16BE(afterName);
		const rdlength = buf.readUInt16BE(afterName + 8);
		const rdata = afterName + 10;

		let value;
		if (type === 12)
			value = readName(buf, rdata)[0]; // PTR
		else if (type === 1)
			value = Array.from(buf.subarray(rdata, rdata + 4)).join("."); // A
		else if (type === 33)
			value = `${readName(buf, rdata + 6)[0]}:${buf.readUInt16BE(rdata + 4)}`; // SRV
		else if (type === 16) value = readTxt(buf, rdata, rdlength); // TXT

		if (value !== undefined) records.push({ name, type, value });
		offset = rdata + rdlength;
	}
	return records;
};

const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
const serviceTypes = new Set();
const instances = new Map(); // service type -> instance names
const rdata = new Map(); // instance name -> ["SRV host:port", "TXT ...", "A 1.2.3.4"]

const remember = (map, key, value) => {
	const list = map.get(key) ?? new Set();
	list.add(value);
	map.set(key, list);
};

socket.on("error", (error) => {
	console.error(`socket error: ${error.message}`);
	socket.close();
});

socket.on("message", (message) => {
	let records;
	try {
		records = parse(message);
	} catch {
		return; // truncated or malformed; nothing useful to salvage
	}
	for (const { name, type, value } of records) {
		if (type === 12 && name === "_services._dns-sd._udp.local")
			serviceTypes.add(value);
		else if (type === 12) remember(instances, name, value);
		else remember(rdata, name, `${recordTypeLabel(type)} ${value}`);
	}
});

const report = () => {
	console.log(`=== service types advertised (${serviceTypes.size}) ===`);
	for (const type of [...serviceTypes].sort()) console.log(`  ${type}`);

	console.log(`\n=== instances (${instances.size} types resolved) ===`);
	for (const [type, names] of [...instances].sort()) {
		for (const name of names) {
			console.log(`  ${type}`);
			console.log(`    ${name}`);
			for (const record of rdata.get(name) ?? [])
				console.log(`      ${record}`);
		}
	}

	if (serviceTypes.size === 0 && instances.size === 0) {
		console.log(
			"\nNothing answered. Check MDNS_IFACE, try MDNS_QU=1, or suspect",
		);
		console.log("multicast filtering / client isolation on the access point.");
	}
};

socket.bind(
	UNICAST_REPLY ? 0 : PORT,
	PINNED && UNICAST_REPLY ? IFACE : undefined,
	() => {
		socket.addMembership(MCAST, PINNED ? IFACE : undefined);
		socket.setMulticastTTL(255);
		if (PINNED) socket.setMulticastInterface(IFACE);

		socket.send(query(["_services._dns-sd._udp.local"]), PORT, MCAST);

		// Give responders a moment, then ask each advertised type for its instances.
		setTimeout(() => {
			if (serviceTypes.size > 0)
				socket.send(query([...serviceTypes]), PORT, MCAST);
		}, 2500);

		setTimeout(() => {
			report();
			socket.close();
		}, 7000);
	},
);
