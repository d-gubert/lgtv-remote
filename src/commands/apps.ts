import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { BadInput } from "../domain/errors.js";
import {
	ExternalInputList,
	ForegroundApp,
	LaunchPoints,
	Uri,
} from "../sdk/index.js";
import { withTv } from "../services/Tv.js";
import { cyan, dim, emit, ok, table } from "../ui.js";

const includeSystem = Options.boolean("all").pipe(
	Options.withDescription(
		"Include system apps, not just the ones on the launcher",
	),
);

const appList = Command.make("list", { includeSystem }, ({ includeSystem }) =>
	withTv((tv) =>
		Effect.gen(function* () {
			const { launchPoints } = yield* tv.requestAs(Uri.listApps, LaunchPoints);
			const visible = includeSystem
				? launchPoints
				: launchPoints.filter((app) => app.systemApp !== true);
			const label = (app: {
				readonly id: string;
				readonly title?: string | undefined;
			}) => (app.title ?? app.id).toLowerCase();
			const sorted = [...visible].sort((a, b) =>
				label(a).localeCompare(label(b)),
			);
			yield* emit(
				table(
					["ID", "TITLE"],
					sorted.map((app) => [app.id, app.title ?? "—"]),
				),
				sorted,
			);
		}),
	),
).pipe(Command.withDescription("List the apps installed on the TV"));

const appCurrent = Command.make("current", {}, () =>
	withTv((tv) =>
		Effect.gen(function* () {
			const app = yield* tv.requestAs(Uri.foregroundApp, ForegroundApp);
			yield* emit(
				app.appId === undefined ? dim("nothing running") : cyan(app.appId),
				app,
			);
		}),
	),
).pipe(Command.withDescription("Show the app currently in the foreground"));

const appId = Args.text({ name: "app-id" }).pipe(
	Args.withDescription("Application id, e.g. netflix or youtube.leanback.v4"),
);

const contentId = Options.text("content-id").pipe(
	Options.withDescription("Deep-link payload passed to the app"),
	Options.optional,
);

const appLaunch = Command.make(
	"launch",
	{ appId, contentId },
	({ appId, contentId }) =>
		withTv((tv) =>
			Effect.zipRight(
				tv.request(Uri.launch, {
					id: appId,
					...(Option.isSome(contentId) ? { contentId: contentId.value } : {}),
				}),
				ok(`Launched ${cyan(appId)}`),
			),
		),
).pipe(Command.withDescription("Launch an app by id"));

const appClose = Command.make("close", { appId }, ({ appId }) =>
	withTv((tv) =>
		Effect.zipRight(
			tv.request(Uri.closeApp, { id: appId }),
			ok(`Closed ${appId}`),
		),
	),
).pipe(Command.withDescription("Close a running app"));

export const appCommand = Command.make("app", {}, () =>
	Effect.fail(
		new BadInput({ detail: "Usage: lgtv app <list|current|launch|close>" }),
	),
).pipe(
	Command.withDescription("List, launch, and close apps"),
	Command.withSubcommands([appList, appCurrent, appLaunch, appClose]),
);

// ---- inputs ---------------------------------------------------------------

const inputList = Command.make("list", {}, () =>
	withTv((tv) =>
		Effect.gen(function* () {
			const { devices } = yield* tv.requestAs(
				Uri.listInputs,
				ExternalInputList,
			);
			yield* emit(
				table(
					["ID", "LABEL", "CONNECTED"],
					devices.map((device) => [
						device.id,
						device.label ?? "—",
						device.connected === true ? "yes" : "no",
					]),
				),
				devices,
			);
		}),
	),
).pipe(Command.withDescription("List HDMI and other external inputs"));

const inputId = Args.text({ name: "input-id" }).pipe(
	Args.withDescription("Input id from `lgtv input list`, e.g. HDMI_1"),
);

const inputSet = Command.make("set", { inputId }, ({ inputId }) =>
	withTv((tv) =>
		Effect.zipRight(
			tv.request(Uri.switchInput, { inputId }),
			ok(`Switched to ${cyan(inputId)}`),
		),
	),
).pipe(Command.withDescription("Switch to an input"));

export const inputCommand = Command.make("input", {}, () =>
	Effect.fail(new BadInput({ detail: "Usage: lgtv input <list|set>" })),
).pipe(
	Command.withDescription("List and switch external inputs"),
	Command.withSubcommands([inputList, inputSet]),
);
