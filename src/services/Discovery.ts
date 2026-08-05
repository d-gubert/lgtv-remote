import dgram from "node:dgram";

import { Duration, Effect } from "effect";

import { DiscoveryFailed } from "../domain/errors.js";

export interface DiscoveredTv {
  readonly host: string;
  readonly name: string | undefined;
  readonly model: string | undefined;
  readonly location: string | undefined;
}

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;

/**
 * webOS answers its own service type; the generic ones are there to catch
 * models that only advertise as a plain UPnP device.
 */
const SEARCH_TARGETS = [
  "urn:lge-com:service:webos-second-screen:1",
  "urn:schemas-upnp-org:device:MediaRenderer:1",
  "ssdp:all",
];

const mSearch = (target: string) =>
  Buffer.from(
    [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      "MX: 2",
      `ST: ${target}`,
      "",
      "",
    ].join("\r\n"),
  );

const parseHeaders = (raw: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return headers;
};

const looksLikeLg = (headers: Record<string, string>): boolean =>
  Object.entries(headers).some(
    ([key, value]) =>
      (key === "st" ||
        key === "usn" ||
        key === "server" ||
        key === "location") &&
      /lge?[-_ ]?com|webos|lg electronics|lgsmarttv/i.test(value),
  );

const rawSearch = (timeout: Duration.Duration) =>
  Effect.async<Map<string, Record<string, string>>, DiscoveryFailed>(
    (resume) => {
      const found = new Map<string, Record<string, string>>();
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

      let settled = false;
      const finish = (
        result: Effect.Effect<
          Map<string, Record<string, string>>,
          DiscoveryFailed
        >,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // already closed
        }
        resume(result);
      };

      const timer = setTimeout(
        () => finish(Effect.succeed(found)),
        Duration.toMillis(timeout),
      );

      socket.on("message", (message, remote) => {
        const headers = parseHeaders(message.toString());
        if (!looksLikeLg(headers)) return;
        // Keep the richest response we saw for a given TV.
        const existing = found.get(remote.address);
        found.set(remote.address, { ...existing, ...headers });
      });

      socket.once("error", (cause) =>
        finish(Effect.fail(new DiscoveryFailed({ detail: cause.message }))),
      );

      socket.bind(() => {
        try {
          socket.setBroadcast(true);
        } catch {
          // not fatal — multicast still works on most stacks
        }
        for (const target of SEARCH_TARGETS) {
          socket.send(mSearch(target), SSDP_PORT, SSDP_ADDRESS);
        }
      });

      return Effect.sync(() => finish(Effect.succeed(found)));
    },
  );

interface Description {
  readonly name?: string | undefined;
  readonly model?: string | undefined;
}

/** Reads friendlyName/modelName out of the UPnP device description. */
const describe = (location: string | undefined): Effect.Effect<Description> =>
  location === undefined
    ? Effect.succeed<Description>({})
    : Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(location, { signal });
          const xml = await response.text();
          const pick = (tag: string) =>
            new RegExp(`<${tag}>([^<]+)</${tag}>`, "i").exec(xml)?.[1]?.trim();
          return { name: pick("friendlyName"), model: pick("modelName") };
        },
        catch: () =>
          new DiscoveryFailed({ detail: "could not read device description" }),
      }).pipe(
        Effect.timeout(Duration.seconds(3)),
        Effect.orElseSucceed((): Description => ({})),
      );

export const discover = (
  timeout: Duration.Duration = Duration.seconds(4),
): Effect.Effect<ReadonlyArray<DiscoveredTv>, DiscoveryFailed> =>
  Effect.gen(function* () {
    const responses = yield* rawSearch(timeout);
    return yield* Effect.forEach(
      [...responses.entries()],
      ([host, headers]) =>
        Effect.map(describe(headers.location), (info) => ({
          host,
          name: info.name,
          model: info.model,
          location: headers.location,
        })),
      { concurrency: 8 },
    );
  });
