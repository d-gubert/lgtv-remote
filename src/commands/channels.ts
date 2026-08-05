import { Args, Command, Options } from "@effect/cli";
import { Effect } from "effect";

import { BadInput } from "../domain/errors.js";
import { Channel, ChannelList, Uri } from "../sdk/index.js";
import { withTv } from "../services/Tv.js";
import { cyan, dim, emit, ok, table } from "../ui.js";

const channelCurrent = Command.make("current", {}, () =>
	withTv((tv) =>
		Effect.gen(function* () {
			const channel = yield* tv.requestAs(Uri.currentChannel, Channel);
			yield* emit(
				`${cyan(channel.channelNumber ?? "?")}  ${channel.channelName ?? dim("unnamed")}`,
				channel,
			);
		}),
	),
).pipe(Command.withDescription("Show the channel currently tuned"));

const filter = Options.text("filter").pipe(
	Options.withDescription("Only show channels whose name or number matches"),
	Options.withDefault(""),
);

const channelList = Command.make("list", { filter }, ({ filter }) =>
	withTv((tv) =>
		Effect.gen(function* () {
			const { channelList } = yield* tv.requestAs(Uri.channelList, ChannelList);
			const needle = filter.toLowerCase();
			const matching =
				needle === ""
					? channelList
					: channelList.filter((channel) =>
							`${channel.channelNumber ?? ""} ${channel.channelName ?? ""}`
								.toLowerCase()
								.includes(needle),
						);
			yield* emit(
				table(
					["NUMBER", "NAME", "TYPE"],
					matching.map((channel) => [
						channel.channelNumber ?? "—",
						channel.channelName ?? "—",
						channel.channelTypeName ?? "—",
					]),
				),
				matching,
			);
		}),
	),
).pipe(Command.withDescription("List tuned channels"));

const bump = (name: string, uri: string, label: string) =>
	Command.make(name, {}, () =>
		withTv((tv) => Effect.zipRight(tv.request(uri), ok(label))),
	);

const channelUp = bump("up", Uri.channelUp, "Channel up").pipe(
	Command.withDescription("Go to the next channel"),
);
const channelDown = bump("down", Uri.channelDown, "Channel down").pipe(
	Command.withDescription("Go to the previous channel"),
);

const number = Args.text({ name: "channel-number" }).pipe(
	Args.withDescription("Channel number as shown by `lgtv channel list`"),
);

const channelSet = Command.make("set", { number }, ({ number }) =>
	withTv((tv) =>
		Effect.zipRight(
			tv.request(Uri.openChannel, { channelNumber: number }),
			ok(`Tuned to ${cyan(number)}`),
		),
	),
).pipe(Command.withDescription("Tune to a channel number"));

export const channelCommand = Command.make("channel", {}, () =>
	Effect.fail(
		new BadInput({ detail: "Usage: lgtv channel <current|list|up|down|set>" }),
	),
).pipe(
	Command.withDescription("Browse and change channels"),
	Command.withSubcommands([
		channelCurrent,
		channelList,
		channelUp,
		channelDown,
		channelSet,
	]),
);
