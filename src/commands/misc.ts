import { Args, Command, Options } from "@effect/cli";
import { Console, Effect, Option, Stream } from "effect";

import { BadInput } from "../domain/errors.js";
import { SoftwareInfo, SystemInfo, Uri } from "../sdk/index.js";
import { Session } from "../services/Session.js";
import { withTv } from "../services/Tv.js";
import { cyan, dim, emit, keyValue, ok } from "../ui.js";

const message = Args.text({ name: "message" }).pipe(
	Args.withDescription("Text to show in the corner of the screen"),
);

export const toastCommand = Command.make("toast", { message }, ({ message }) =>
	withTv((tv) =>
		Effect.zipRight(
			tv.request(Uri.createToast, { message }),
			ok("Notification shown"),
		),
	),
).pipe(Command.withDescription("Show a notification on the TV"));

export const infoCommand = Command.make("info", {}, () =>
	withTv((tv) =>
		Effect.gen(function* () {
			const software = yield* tv.requestAs(Uri.softwareInfo, SoftwareInfo);
			const version = [software.major_ver, software.minor_ver]
				.filter(Boolean)
				.join(".");
			// Not every model answers this one; the rest of `info` still works without it.
			const system = yield* Effect.option(
				tv.requestAs(Uri.systemInfo, SystemInfo),
			);
			const systemLines: ReadonlyArray<readonly [string, string]> =
				Option.isSome(system)
					? [
							["serial", system.value.serialNumber ?? "unknown"],
							["receiver", system.value.receiverType ?? "unknown"],
						]
					: [];
			yield* emit(
				keyValue([
					["host", tv.host],
					["url", tv.url],
					["model", software.model_name ?? "unknown"],
					["product", software.product_name ?? "unknown"],
					["firmware", version === "" ? "unknown" : version],
					["device id", software.device_id ?? "unknown"],
					...systemLines,
				]),
				{
					host: tv.host,
					url: tv.url,
					...software,
					...(Option.isSome(system) ? system.value : {}),
				},
			);
		}),
	),
).pipe(Command.withDescription("Show model and firmware information"));

// ---- raw ------------------------------------------------------------------

const uri = Args.text({ name: "ssap-uri" }).pipe(
	Args.withDescription("Endpoint, e.g. ssap://audio/getVolume"),
);

const payload = Options.text("payload").pipe(
	Options.withDescription("JSON object sent with the request"),
	Options.optional,
);

export const rawCommand = Command.make(
	"raw",
	{ uri, payload },
	({ uri, payload }) =>
		Effect.gen(function* () {
			const body = yield* Option.match(payload, {
				onNone: () => Effect.succeed(undefined),
				onSome: (text) =>
					Effect.try({
						try: () => JSON.parse(text) as Record<string, unknown>,
						catch: () =>
							new BadInput({ detail: `--payload is not valid JSON: ${text}` }),
					}),
			});
			const normalised = uri.startsWith("ssap://") ? uri : `ssap://${uri}`;
			yield* withTv((tv) =>
				Effect.flatMap(tv.request(normalised, body), (result) =>
					Console.log(JSON.stringify(result, null, 2)),
				),
			);
		}),
).pipe(
	Command.withDescription(
		"Send an arbitrary ssap:// request and print the reply",
	),
);

// ---- watch ----------------------------------------------------------------

const topics: ReadonlyArray<
	[string, { readonly name: string; readonly uri: string }]
> = [
	["volume", { name: "volume", uri: Uri.getVolume }],
	["app", { name: "app", uri: Uri.foregroundApp }],
	["channel", { name: "channel", uri: Uri.currentChannel }],
	["power", { name: "power", uri: Uri.powerState }],
];

const topic = Args.choice(topics, { name: "topic" }).pipe(
	Args.withDescription("volume, app, channel, or power"),
);

export const watchCommand = Command.make("watch", { topic }, ({ topic }) =>
	withTv((tv) =>
		Effect.gen(function* () {
			const session = yield* Session;
			yield* Console.error(
				dim(`Watching ${topic.name} — press Ctrl-C to stop.`),
			);
			yield* Stream.runForEach(tv.subscribe(topic.uri), (update) =>
				Console.log(
					session.json
						? JSON.stringify(update)
						: `${dim(new Date().toISOString().slice(11, 19))} ${cyan(
								JSON.stringify(update, (key, value) =>
									key === "subscribed" ? undefined : value,
								),
							)}`,
				),
			);
		}),
	),
).pipe(Command.withDescription("Stream state changes until interrupted"));
