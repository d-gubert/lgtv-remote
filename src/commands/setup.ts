import { Args, Command, Options } from "@effect/cli";
import { Console, Duration, Effect, Either } from "effect";

import type { BadInput } from "../domain/errors.js";
import { explain } from "../domain/errors.js";
import {
  ConnectionInfo,
  ConnectionStatus,
  macForActiveInterface,
  SoftwareInfo,
  Uri,
} from "../sdk/index.js";
import { discover } from "../services/Discovery.js";
import { Session } from "../services/Session.js";
import { Settings } from "../services/Settings.js";
import { connect } from "../services/Tv.js";
import { parseMac } from "../services/Wol.js";
import { bold, cyan, dim, emit, keyValue, ok, table, yellow } from "../ui.js";

const seconds = Options.integer("for").pipe(
  Options.withDescription("How long to listen for replies, in seconds"),
  Options.withDefault(4),
);

export const discoverCommand = Command.make(
  "discover",
  { seconds },
  ({ seconds }) =>
    Effect.gen(function* () {
      yield* Console.error(dim(`Searching for LG TVs for ${seconds}s…`));
      const found = yield* discover(Duration.seconds(seconds));
      yield* emit(
        found.length === 0
          ? `No LG TVs answered.\n${dim("The TV must be powered on and on this network. Some models only respond when the screen is on.")}`
          : `${table(
              ["HOST", "NAME", "MODEL"],
              found.map((tv) => [tv.host, tv.name ?? "—", tv.model ?? "—"]),
            )}\n\n${dim(`Next: lgtv --host ${found[0]?.host} pair`)}`,
        found,
      );
    }),
).pipe(
  Command.withDescription("Find LG webOS TVs on the local network (SSDP)"),
);

export const pairCommand = Command.make("pair", {}, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* Settings;
      const session = yield* Session;
      const tv = yield* connect();
      // Remembered with the device: pairing is per-transport on the TV side, so
      // later commands have to reach it the same way.
      const ssl = yield* session.ssl;

      // While we are connected, learn the MAC so `lgtv on` works later. It
      // takes both endpoints: `getinfo` has the MACs, `getstatus` says which
      // interface is actually carrying traffic.
      const network = yield* Effect.either(
        Effect.all({
          info: tv.requestAs(Uri.connectionInfo, ConnectionInfo),
          status: tv
            .requestAs(Uri.connectionStatus, ConnectionStatus)
            .pipe(Effect.orElseSucceed(() => ({}) as ConnectionStatus)),
        }),
      );
      const mac = Either.match(network, {
        onLeft: () => undefined,
        onRight: ({ info, status }) => macForActiveInterface(info, status),
      });

      // A TV that won't say is one thing; a bug on our side is another. Say
      // which, rather than reporting the MAC as merely "unknown".
      const warnings: Array<string> = [];
      if (Either.isLeft(network)) {
        warnings.push(`No MAC saved — ${explain(network.left)}`);
      } else if (
        network.right.status.wifi?.state === "connected" &&
        network.right.status.wifi.isWakeOnWifiEnabled === false
      ) {
        warnings.push(
          `This TV is on Wi-Fi and its "Wake on Wi-Fi" setting is off, so \`lgtv on\` cannot wake it.
  Turn on Settings → General → Devices → External Devices → Mobile TV On.`,
        );
      }

      const software = yield* tv
        .requestAs(Uri.softwareInfo, SoftwareInfo)
        .pipe(Effect.orElseSucceed(() => ({}) as SoftwareInfo));

      yield* settings.rememberDevice(tv.host, {
        clientKey: tv.clientKey,
        ssl,
        ...(mac === undefined ? {} : { mac }),
        ...(software.model_name === undefined
          ? {}
          : { name: software.model_name }),
      });

      yield* emit(
        [
          `${bold("Paired with")} ${cyan(tv.host)}`,
          keyValue([
            ["model", software.model_name ?? "unknown"],
            ["mac", mac ?? "unknown (set it with `lgtv config set-mac`)"],
            ["ssl", ssl ? "on — used by default from now on" : "off"],
            ["key saved to", settings.file],
          ]),
          ...warnings.map((warning) => `\n${yellow("!")} ${warning}`),
        ].join("\n"),
        {
          host: tv.host,
          model: software.model_name,
          mac,
          ssl,
          warnings,
          settingsFile: settings.file,
        },
      );
    }),
  ),
).pipe(Command.withDescription("Pair with the TV and remember its client key"));

// ---- config ---------------------------------------------------------------

const sslLabel = (ssl: boolean | undefined): string => {
  if (ssl === undefined) return "—";
  return ssl ? "on" : "off";
};

const showConfig = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const stored = yield* settings.read;
    const devices = Object.entries(stored.devices ?? {});
    yield* emit(
      [
        keyValue([
          ["file", settings.file],
          ["default host", stored.defaultHost ?? "—"],
        ]),
        "",
        table(
          ["HOST", "NAME", "MAC", "PAIRED", "SSL"],
          devices.map(([host, device]) => [
            host,
            device.name ?? "—",
            device.mac ?? "—",
            device.clientKey === undefined ? "no" : "yes",
            sslLabel(device.ssl),
          ]),
        ),
      ].join("\n"),
      { file: settings.file, ...stored },
    );
  }),
).pipe(Command.withDescription("Show the saved configuration"));

const setHost = Command.make(
  "set-host",
  { host: Args.text({ name: "ip-or-hostname" }) },
  ({ host }) =>
    Effect.gen(function* () {
      const settings = yield* Settings;
      yield* settings.update((current) => ({
        ...current,
        defaultHost: host,
        devices: { ...current.devices, [host]: { ...current.devices?.[host] } },
      }));
      yield* ok(`Default TV set to ${cyan(host)}`);
    }),
).pipe(Command.withDescription("Set the default TV address"));

const setMac = Command.make(
  "set-mac",
  { mac: Args.text({ name: "mac-address" }) },
  ({ mac }) =>
    Effect.gen(function* () {
      const settings = yield* Settings;
      const session = yield* Session;
      const host = yield* session.host;
      const normalised = yield* Either.match(parseMac(mac), {
        onLeft: (error: BadInput) => Effect.fail(error),
        onRight: (value: string) => Effect.succeed(value),
      });
      yield* settings.rememberDevice(host, { mac: normalised });
      yield* ok(`MAC for ${cyan(host)} set to ${normalised}`);
    }),
).pipe(Command.withDescription("Set the MAC address used for Wake-on-LAN"));

const setSsl = Command.make(
  "set-ssl",
  {
    ssl: Args.choice(
      [
        ["on", true],
        ["off", false],
      ],
      { name: "on-or-off" },
    ),
  },
  ({ ssl }) =>
    Effect.gen(function* () {
      const settings = yield* Settings;
      const session = yield* Session;
      const host = yield* session.host;
      yield* settings.rememberDevice(host, { ssl });
      yield* ok(
        `${cyan(host)} will use the ${ssl ? "secure" : "plain"} port by default`,
      );
    }),
).pipe(
  Command.withDescription(
    "Choose the transport used for a TV when no flag is given",
  ),
);

const forget = Command.make("forget", {}, () =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const session = yield* Session;
    const host = yield* session.host;
    yield* settings.forget(host);
    yield* ok(`Forgot ${cyan(host)}`);
  }),
).pipe(Command.withDescription("Remove the current TV and its client key"));

export const configCommand = Command.make("config", {}, () =>
  Effect.flatMap(Settings, (settings) =>
    Console.log(
      `Usage: lgtv config <show|set-host|set-mac|set-ssl|forget>\n${dim(`settings file: ${settings.file}`)}`,
    ),
  ),
).pipe(
  Command.withDescription("Inspect and edit saved settings"),
  Command.withSubcommands([showConfig, setHost, setMac, setSsl, forget]),
);
