import { appCommand, inputCommand } from "./apps.js";
import { muteCommand, volumeCommand } from "./audio.js";
import { channelCommand } from "./channels.js";
import { infoCommand, rawCommand, toastCommand, watchCommand } from "./misc.js";
import {
	offCommand,
	onCommand,
	screenCommand,
	statusCommand,
} from "./power.js";
import {
	cursorCommand,
	keyCommand,
	keysCommand,
	mediaCommand,
	typeCommand,
} from "./remote.js";
import { configCommand, discoverCommand, pairCommand } from "./setup.js";
import { youtubeCommand } from "./youtube.js";

/** Shared with `Command.run` in both `cli.ts` and `repl.ts`, so the two never drift. */
export const VERSION = "0.1.0";

/** Every command that works the same from the shell and from `lgtv repl`. */
export const subcommands = [
	discoverCommand,
	pairCommand,
	statusCommand,
	infoCommand,
	onCommand,
	offCommand,
	screenCommand,
	volumeCommand,
	muteCommand,
	appCommand,
	youtubeCommand,
	inputCommand,
	channelCommand,
	mediaCommand,
	keyCommand,
	keysCommand,
	cursorCommand,
	typeCommand,
	toastCommand,
	watchCommand,
	rawCommand,
	configCommand,
] as const;
