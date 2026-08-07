import { Context, Duration, Effect, Layer, Option } from "effect";

import { Settings } from "./Settings.js";
import type { SettingsUnreadable } from "../domain/errors.js";
import { TvNotConfigured } from "../domain/errors.js";

/** The global flags every command shares. */
export interface GlobalOptions {
	readonly host: Option.Option<string>;
	readonly port: Option.Option<number>;
	/** `--ssl` / `--no-ssl`; `none` means "whatever this TV was paired with". */
	readonly ssl: Option.Option<boolean>;
	readonly timeout: number;
	readonly json: boolean;
}

export interface SessionApi {
	readonly json: boolean;
	readonly timeout: Duration.Duration;
	/** Resolved from --host, then $LGTV_HOST, then the saved default. */
	readonly host: Effect.Effect<string, TvNotConfigured | SettingsUnreadable>;
	/** Resolved from --ssl/--no-ssl, then $LGTV_SSL, then the saved device. */
	readonly ssl: Effect.Effect<boolean, TvNotConfigured | SettingsUnreadable>;
	readonly wsUrl: Effect.Effect<string, TvNotConfigured | SettingsUnreadable>;
	readonly clientKey: Effect.Effect<
		Option.Option<string>,
		TvNotConfigured | SettingsUnreadable
	>;
	readonly mac: Effect.Effect<string, TvNotConfigured | SettingsUnreadable>;
	/** Stores the key *and* the transport it was granted over, so later runs match. */
	readonly rememberKey: (
		host: string,
		clientKey: string,
	) => Effect.Effect<void, SettingsUnreadable>;
}

export class Session extends Context.Tag("lgtv/Session")<
	Session,
	SessionApi
>() {}

const envOption = (name: string) =>
	Option.fromNullable(process.env[name]).pipe(
		Option.filter((value) => value.trim().length > 0),
	);

export const layer = (
	options: GlobalOptions,
): Layer.Layer<Session, never, Settings> =>
	Layer.effect(
		Session,
		Effect.gen(function* () {
			const settings = yield* Settings;

			const host = Effect.gen(function* () {
				const explicit = Option.orElse(options.host, () =>
					envOption("LGTV_HOST"),
				);
				if (Option.isSome(explicit)) return explicit.value;
				const stored = yield* settings.read;
				if (stored.defaultHost !== undefined) return stored.defaultHost;
				// A single saved TV is unambiguous even without an explicit default.
				const only = Object.keys(stored.devices ?? {});
				if (only.length === 1 && only[0] !== undefined) return only[0];
				return yield* Effect.fail(new TvNotConfigured({ missing: "host" }));
			});

			const port = Option.orElse(options.port, () =>
				envOption("LGTV_PORT").pipe(
					Option.map(Number),
					Option.filter((n) => Number.isInteger(n) && n > 0),
				),
			);
			/**
			 * The flag wins, then the environment, then whatever transport this TV was
			 * last paired over — so `lgtv --ssl pair` makes every later command secure
			 * without repeating the flag.
			 */
			const sslFor = (
				h: string,
			): Effect.Effect<boolean, SettingsUnreadable> => {
				if (Option.isSome(options.ssl))
					return Effect.succeed(options.ssl.value);
				if (Option.isSome(envOption("LGTV_SSL"))) return Effect.succeed(true);
				return Effect.map(settings.deviceFor(h), (device) =>
					Option.getOrElse(
						Option.flatMap(device, (d) => Option.fromNullable(d.ssl)),
						() => false,
					),
				);
			};

			const ssl = Effect.flatMap(host, sslFor);

			const wsUrl = Effect.gen(function* () {
				const h = yield* host;
				const secure = yield* sslFor(h);
				const resolvedPort = Option.getOrElse(port, () =>
					secure ? 3001 : 3000,
				);
				return `${secure ? "wss" : "ws"}://${h}:${resolvedPort}`;
			});

			const clientKey = Effect.flatMap(host, (h) =>
				Effect.map(
					settings.deviceFor(h),
					Option.flatMap((d) => Option.fromNullable(d.clientKey)),
				),
			);

			const mac = Effect.gen(function* () {
				const fromFlag = envOption("LGTV_MAC");
				if (Option.isSome(fromFlag)) return fromFlag.value;
				const h = yield* host;
				const device = yield* settings.deviceFor(h);
				const stored = Option.flatMap(device, (d) =>
					Option.fromNullable(d.mac),
				);
				if (Option.isSome(stored)) return stored.value;
				return yield* Effect.fail(new TvNotConfigured({ missing: "mac" }));
			});

			const rememberKey = (h: string, key: string) =>
				Effect.flatMap(sslFor(h), (secure) =>
					Effect.asVoid(
						settings.rememberDevice(h, { clientKey: key, ssl: secure }),
					),
				);

			return {
				json: options.json,
				timeout: Duration.seconds(options.timeout),
				host,
				ssl,
				wsUrl,
				clientKey,
				mac,
				rememberKey,
			};
		}),
	);
