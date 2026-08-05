/**
 * Button names understood by the webOS "pointer input" socket — the same wire
 * events a physical Magic Remote sends. Grouped only to make `lgtv keys` read
 * nicely.
 */
export const buttonGroups = {
	navigation: ["UP", "DOWN", "LEFT", "RIGHT", "ENTER", "BACK", "EXIT", "HOME"],
	playback: ["PLAY", "PAUSE", "STOP", "REWIND", "FASTFORWARD", "RECORD"],
	volume: ["VOLUMEUP", "VOLUMEDOWN", "MUTE", "CHANNELUP", "CHANNELDOWN"],
	numbers: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "DASH"],
	colors: ["RED", "GREEN", "YELLOW", "BLUE"],
	menus: [
		"MENU",
		"INFO",
		"GUIDE",
		"QMENU",
		"ASTERISK",
		"CC",
		"LIVE_ZOOM",
		"AD",
		"SEARCH",
	],
	power: ["POWER"],
} as const;

export const allButtons: ReadonlyArray<string> =
	Object.values(buttonGroups).flat();

const lookup = new Map(allButtons.map((b) => [b.toLowerCase(), b]));

/**
 * Accepts the canonical name plus the aliases people actually type
 * (`ok`, `vol+`, `ch-`, `ff`, …).
 */
const aliases: Record<string, string> = {
	ok: "ENTER",
	select: "ENTER",
	return: "BACK",
	"vol+": "VOLUMEUP",
	"vol-": "VOLUMEDOWN",
	volup: "VOLUMEUP",
	voldown: "VOLUMEDOWN",
	"ch+": "CHANNELUP",
	"ch-": "CHANNELDOWN",
	chup: "CHANNELUP",
	chdown: "CHANNELDOWN",
	ff: "FASTFORWARD",
	forward: "FASTFORWARD",
	rew: "REWIND",
	settings: "MENU",
	dot: "DASH",
	star: "ASTERISK",
	subtitle: "CC",
};

export const resolveButton = (input: string): string | undefined => {
	const key = input.trim().toLowerCase();
	return lookup.get(key) ?? aliases[key];
};
