import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { startFakeTv, type FakeTv } from "../fake-tv.js";
import {
	delay,
	eventually,
	failsWith,
	type ConnectOptions,
	type Connection,
	type ContractClient,
} from "./client.js";

/**
 * Everything an SSAP client must do, stated without reference to how it does it.
 *
 * Run against every implementation: `runContractTests(effectClient)` today,
 * plus `runContractTests(plainClient)` for the Effect-free SDK. A behaviour
 * that only one of them has does not belong here.
 *
 * The uris are spelled out rather than imported from `src/` on purpose — they
 * are part of the wire contract, so a rewrite that changes one should fail
 * here rather than quietly agree with itself.
 */

const URI = {
	getVolume: "ssap://audio/getVolume",
	setVolume: "ssap://audio/setVolume",
	listApps: "ssap://com.webos.applicationManager/listLaunchPoints",
	openChannel: "ssap://tv/openChannel",
	unknown: "ssap://does/not/exist",
} as const;

export const runContractTests = (client: ContractClient): void => {
	describe(`SSAP client contract [${client.name}]`, () => {
		let tv: FakeTv;
		let opened: Array<Connection>;

		beforeEach(async () => {
			tv = await startFakeTv();
			opened = [];
		});

		afterEach(async () => {
			for (const connection of opened) {
				await connection.close().catch(() => {
					// teardown is best-effort; a connection may already be gone
				});
			}
			await tv.close();
		});

		/** Connects to the per-test TV and registers the connection for teardown. */
		const connect = async (overrides: Partial<ConnectOptions> = {}) => {
			const connection = await client.connect({
				host: tv.host,
				port: tv.port,
				timeoutMs: 1000,
				...overrides,
			});
			opened.push(connection);
			return connection;
		};

		// ---- handshake --------------------------------------------------------

		describe("handshake", () => {
			it("pairs with a TV that has never seen us, and reports the key it was granted", async () => {
				const granted: Array<string> = [];
				const connection = await connect({
					onClientKey: (key) => granted.push(key),
				});

				assert.match(connection.clientKey, /^key-/);
				assert.ok(
					tv.knownKeys.has(connection.clientKey),
					"the TV should consider the key paired",
				);
				assert.equal(
					tv.promptCount(),
					1,
					"the user should have been prompted exactly once",
				);
				assert.deepEqual(
					granted,
					[connection.clientKey],
					"the key must be handed back to be stored",
				);
			});

			it("reuses a key the TV already trusts, without prompting again", async () => {
				const first = await connect();
				await first.close();

				const granted: Array<string> = [];
				const second = await connect({
					clientKey: first.clientKey,
					onClientKey: (key) => granted.push(key),
				});

				assert.equal(second.clientKey, first.clientKey);
				assert.equal(
					tv.promptCount(),
					1,
					"a known key must not raise a second prompt",
				);
				assert.equal(
					tv.registerPayloads.at(-1)?.["client-key"],
					first.clientKey,
					"the stored key has to be offered in the register frame",
				);
				assert.deepEqual(
					granted,
					[],
					"an unchanged key should not be written back",
				);
			});

			it("fails when the TV rejects the pairing", async () => {
				tv.setPairing("reject");
				const error = await failsWith("PairingFailed", () => connect());
				assert.match(error.detail, /403|denied/);
			});

			it("fails when the TV registers without handing back a key", async () => {
				tv.setPairing("grant-without-key");
				await failsWith("PairingFailed", () => connect());
			});

			it("fails when the connection drops during the handshake", async () => {
				tv.setPairing("never-answer");
				const pending = failsWith("PairingFailed", () => connect());
				await delay(100);
				tv.dropConnections();
				await pending;
			});

			it("closes the socket when the handshake fails", async () => {
				tv.setPairing("reject");
				await failsWith("PairingFailed", () => connect());
				await eventually(
					() => tv.openConnections() === 0,
					"the failed connection to be closed",
				);
			});

			it("reports an unreachable TV rather than hanging", async () => {
				// Port 1 is reserved; nothing is listening, so the connect is refused.
				await failsWith("TvUnreachable", () =>
					client.connect({ host: "127.0.0.1", port: 1, timeoutMs: 1000 }),
				);
			});

			it("waits longer for the pairing prompt than it does for a request", async () => {
				// A human has to walk to the TV, so the request timeout must not apply
				// to the handshake. 400ms of prompt against a 150ms request timeout.
				const slow = await startFakeTv({ promptDelayMs: 400 });
				try {
					const connection = await client.connect({
						host: slow.host,
						port: slow.port,
						timeoutMs: 150,
					});
					assert.match(connection.clientKey, /^key-/);
					await connection.close();
				} finally {
					await slow.close();
				}
			});
		});

		// ---- requests ---------------------------------------------------------

		describe("requests", () => {
			it("sends the payload the TV expects and reads the result back", async () => {
				const connection = await connect();
				await connection.request(URI.setVolume, { volume: 33 });

				const sent = tv.requests.filter((r) => r.uri === URI.setVolume).at(-1);
				assert.deepEqual(sent?.payload, { volume: 33 });

				const status = await connection.request(URI.getVolume);
				assert.equal(status.volume, 33);
			});

			it("omits the payload key entirely when there is nothing to send", async () => {
				const connection = await connect();
				await connection.request(URI.getVolume);
				const sent = tv.requests.filter((r) => r.uri === URI.getVolume).at(-1);
				assert.equal(sent?.payload, undefined);
			});

			it("surfaces an error frame as a refusal", async () => {
				const connection = await connect();
				const error = await failsWith("SsapFailed", () =>
					connection.request(URI.unknown),
				);
				assert.match(error.detail, /404/);
			});

			it("treats returnValue:false as a refusal and keeps the TV's reason", async () => {
				const connection = await connect();
				const error = await failsWith("SsapFailed", () =>
					connection.request(URI.openChannel, { channelNumber: "999" }),
				);
				assert.equal(error.detail, "Invalid channel");
			});

			it("gives up on a request the TV never answers", async () => {
				tv.silence(URI.getVolume);
				const connection = await connect({ timeoutMs: 300 });

				const started = Date.now();
				const error = await failsWith("SsapFailed", () =>
					connection.request(URI.getVolume),
				);
				assert.match(error.detail, /no reply/);
				assert.ok(
					Date.now() - started < 2000,
					"the timeout should fire promptly",
				);
			});

			it("fails a request in flight when the socket drops, rather than hanging", async () => {
				tv.silence(URI.getVolume);
				// Long enough that the request timeout cannot be what fails this, short
				// enough that a client which *does* wait for it fails the suite quickly.
				const connection = await connect({ timeoutMs: 5000 });

				const started = Date.now();
				const pending = failsWith("TvUnreachable", () =>
					connection.request(URI.getVolume),
				);
				await delay(50);
				tv.dropConnections();
				await pending;
				assert.ok(
					Date.now() - started < 2000,
					"a dropped socket must fail waiters immediately",
				);
			});

			it("routes concurrent replies to the caller that asked, even out of order", async () => {
				tv.delayReply(URI.listApps, 150);
				const connection = await connect();

				const finished: Array<string> = [];
				const apps = connection.request(URI.listApps).then((r) => {
					finished.push("apps");
					return r;
				});
				const volume = connection.request(URI.getVolume).then((r) => {
					finished.push("volume");
					return r;
				});
				const [appsResult, volumeResult] = await Promise.all([apps, volume]);

				assert.deepEqual(
					finished,
					["volume", "apps"],
					"the replies should arrive out of order",
				);
				assert.ok(
					"launchPoints" in appsResult,
					"the apps reply went to the wrong caller",
				);
				assert.equal(
					volumeResult.volume,
					12,
					"the volume reply went to the wrong caller",
				);
			});

			it("fails rather than hangs once the connection is closed", async () => {
				const connection = await connect();
				await connection.close();
				await failsWith("TvUnreachable", () =>
					connection.request(URI.getVolume),
				);
			});
		});

		// ---- decoding ---------------------------------------------------------

		describe("decoding", () => {
			it("decodes a reply into the shape the caller asked for", async () => {
				const connection = await connect();

				const status = await connection.requestAs(
					URI.getVolume,
					"VolumeStatus",
				);
				assert.equal(status.volume, 12);

				const apps = await connection.requestAs(URI.listApps, "LaunchPoints");
				const launchPoints = apps.launchPoints as ReadonlyArray<{
					id: string;
				}>;
				assert.equal(launchPoints.length, 2);
				assert.equal(launchPoints[0]?.id, "netflix");
			});

			it("rejects a reply that does not match the shape", async () => {
				const connection = await connect();
				// A volume payload has no `socketPath`, so this must not slip through.
				await failsWith("UnexpectedResponse", () =>
					connection.requestAs(URI.getVolume, "PointerSocket"),
				);
			});
		});

		// ---- subscriptions ----------------------------------------------------

		describe("subscriptions", () => {
			it("delivers the immediate reply and then every push", async () => {
				const connection = await connect();

				const pending = connection.subscribe(URI.getVolume, 3);
				await delay(80);
				tv.pushVolume(40);
				await delay(40);
				tv.pushVolume(41);

				const updates = await pending;
				assert.deepEqual(
					updates.map((u) => u.volume),
					[12, 40, 41],
				);
			});

			it("leaves the connection usable after a subscription ends", async () => {
				const connection = await connect();
				await connection.subscribe(URI.getVolume, 1);

				const status = await connection.request(URI.getVolume);
				assert.equal(
					status.volume,
					12,
					"ending a subscription must not close the connection",
				);
			});

			it("keeps two subscriptions on one connection apart", async () => {
				const connection = await connect();

				const first = connection.subscribe(URI.getVolume, 2);
				await delay(50);
				const second = connection.subscribe(URI.getVolume, 2);
				await delay(50);
				tv.pushVolume(77);

				const [a, b] = await Promise.all([first, second]);
				assert.equal(
					tv.subscriptionCount(),
					2,
					"each subscribe needs its own id",
				);
				assert.equal(a.at(-1)?.volume, 77);
				assert.equal(b.at(-1)?.volume, 77);
			});

			it("ignores pushes for a subscription that has already ended", async () => {
				const connection = await connect();
				await connection.subscribe(URI.getVolume, 1);

				// A real TV keeps pushing; the client must have unregistered the mailbox.
				tv.pushVolume(99);
				await delay(50);

				const status = await connection.request(URI.getVolume);
				assert.equal(
					status.volume,
					99,
					"the connection should still be healthy",
				);
			});

			it("drops junk frames instead of crashing the connection", async () => {
				const connection = await connect();

				const pending = connection.subscribe(URI.getVolume, 2);
				await delay(80);
				tv.pushGarbage(); // not JSON at all
				tv.pushWrongShape(); // valid JSON, not a frame
				tv.pushWithoutId(); // a frame nobody can be waiting on
				tv.pushUnknownId(); // a frame for a request that does not exist
				await delay(40);
				tv.pushVolume(55);

				const updates = await pending;
				assert.deepEqual(
					updates.map((u) => u.volume),
					[12, 55],
					"every junk frame should be skipped, none of them fatal",
				);
			});
		});

		// ---- Magic Remote -----------------------------------------------------

		describe("pointer input", () => {
			it("sends the Magic Remote frames verbatim", async () => {
				const connection = await connect();
				const pointer = await connection.pointer();

				await pointer.button("HOME");
				await pointer.click();
				await pointer.move(40, -10, false);
				await pointer.scroll(0, -3);
				await eventually(
					() => tv.pointerFrames.length === 4,
					"all four pointer frames to arrive",
				);

				assert.deepEqual(tv.pointerFrames, [
					"type:button\nname:HOME\n\n",
					"type:click\n\n",
					"type:move\ndx:40\ndy:-10\ndown:0\n\n",
					"type:scroll\ndx:0\ndy:-3\n\n",
				]);
			});

			it("marks a drag with down:1", async () => {
				const connection = await connect();
				const pointer = await connection.pointer();
				await pointer.move(5, 5, true);
				await eventually(
					() => tv.pointerFrames.length === 1,
					"the move frame to arrive",
				);
				assert.equal(tv.pointerFrames[0], "type:move\ndx:5\ndy:5\ndown:1\n\n");
			});

			it("closes the pointer channel along with the connection", async () => {
				const connection = await connect();
				await connection.pointer();
				await eventually(
					() => tv.openPointerConnections() === 1,
					"the pointer socket to open",
				);

				await connection.close();
				await eventually(
					() => tv.openPointerConnections() === 0,
					"the pointer socket to close",
				);
			});
		});

		// ---- lifetime ---------------------------------------------------------

		describe("lifetime", () => {
			it("closes the socket when the connection is closed", async () => {
				const connection = await connect();
				assert.equal(tv.openConnections(), 1);

				await connection.close();
				await eventually(
					() => tv.openConnections() === 0,
					"the socket to be closed",
				);
			});

			it("closes cleanly even with a request still in flight", async () => {
				tv.silence(URI.getVolume);
				const connection = await connect({ timeoutMs: 5000 });

				void connection.request(URI.getVolume).catch(() => {
					// the in-flight request is expected to fail once we close below
				});
				await delay(50);
				await connection.close();
				await eventually(
					() => tv.openConnections() === 0,
					"the socket to be closed",
				);
			});
		});
	});
};
