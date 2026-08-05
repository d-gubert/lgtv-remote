import dgram from "node:dgram";

import { Effect, Either } from "effect";

import { BadInput, WakeFailed } from "../domain/errors.js";

const HEX_PAIR = /^[0-9a-f]{2}$/i;

/** Normalises `aa-bb-cc-dd-ee-ff`, `aabbccddeeff`, `AA:BB:…` to `AA:BB:…`. */
export const parseMac = (raw: string): Either.Either<string, BadInput> => {
  const compact = raw.trim().replace(/[:.-]/g, "");
  if (compact.length !== 12 || !/^[0-9a-f]{12}$/i.test(compact)) {
    return Either.left(
      new BadInput({
        detail: `"${raw}" is not a MAC address (expected 6 hex pairs).`,
      }),
    );
  }
  const pairs = compact.match(/.{2}/g) ?? [];
  if (!pairs.every((p) => HEX_PAIR.test(p))) {
    return Either.left(
      new BadInput({ detail: `"${raw}" is not a MAC address.` }),
    );
  }
  return Either.right(pairs.map((p) => p.toUpperCase()).join(":"));
};

const magicPacket = (mac: string): Buffer => {
  const bytes = Buffer.from(mac.replace(/[:.-]/g, ""), "hex");
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i += 1) {
    bytes.copy(packet, 6 + i * 6);
  }
  return packet;
};

/**
 * The directed broadcast for the TV's /24, which many routers forward when
 * they drop 255.255.255.255.
 */
const subnetBroadcast = (host: string | undefined): string | undefined => {
  if (host === undefined) return undefined;
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o)))
    return undefined;
  return `${octets[0]}.${octets[1]}.${octets[2]}.255`;
};

/**
 * Broadcasts a Wake-on-LAN magic packet. Sent to both the global and the
 * TV-subnet broadcast address, on ports 9 and 7, because which combination
 * works depends entirely on the router.
 */
export const wake = (
  mac: string,
  options: {
    readonly host?: string | undefined;
    readonly repeat?: number;
  } = {},
): Effect.Effect<ReadonlyArray<string>, WakeFailed> =>
  Effect.async<ReadonlyArray<string>, WakeFailed>((resume) => {
    const packet = magicPacket(mac);
    const addresses = ["255.255.255.255", subnetBroadcast(options.host)].filter(
      (a): a is string => a !== undefined,
    );
    const ports = [9, 7];
    const repeat = options.repeat ?? 3;
    const socket = dgram.createSocket("udp4");

    let settled = false;
    const finish = (
      result: Effect.Effect<ReadonlyArray<string>, WakeFailed>,
    ) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resume(result);
    };

    socket.once("error", (cause) =>
      finish(Effect.fail(new WakeFailed({ detail: cause.message }))),
    );

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (cause) {
        finish(
          Effect.fail(
            new WakeFailed({
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
        );
        return;
      }

      const total = addresses.length * ports.length * repeat;
      let done = 0;
      let lastError: string | undefined;

      // Defined once, not per iteration: every send shares the same `done`
      // counter and reports completion when the last datagram has gone out.
      const onSent = (cause: Error | null) => {
        if (cause) lastError = cause.message;
        done += 1;
        if (done === total) {
          finish(
            lastError === undefined
              ? Effect.succeed(addresses)
              : Effect.fail(new WakeFailed({ detail: lastError })),
          );
        }
      };

      for (let attempt = 0; attempt < repeat; attempt += 1) {
        for (const address of addresses) {
          for (const port of ports) {
            socket.send(packet, 0, packet.length, port, address, onSent);
          }
        }
      }
    });

    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
    });
  });
