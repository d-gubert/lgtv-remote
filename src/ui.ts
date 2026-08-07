import { Console, Effect } from "effect";

import { Session } from "./services/Session.js";

const colorEnabled =
	process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

const wrap = (code: string) => (text: string) =>
	colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;

export const bold = wrap("1");
export const dim = wrap("2");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

/**
 * Prints the human rendering, or the structured payload when `--json` is set.
 * Every command goes through here so scripting stays a first-class mode.
 */
export const emit = (
	human: string,
	data: unknown,
): Effect.Effect<void, never, Session> =>
	Effect.flatMap(Session, (session) =>
		Console.log(session.json ? JSON.stringify(data, null, 2) : human),
	);

/** Confirmation lines that carry no data of their own. */
export const ok = (message: string): Effect.Effect<void, never, Session> =>
	emit(`${green("✓")} ${message}`, { ok: true, message });

export const table = (
	headers: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
	if (rows.length === 0) return dim("(nothing to show)");
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
	);
	const line = (cells: ReadonlyArray<string>) =>
		cells
			.map((cell, column) => cell.padEnd(widths[column] ?? 0))
			.join("  ")
			.trimEnd();
	return [bold(line(headers)), ...rows.map(line)].join("\n");
};

export const keyValue = (
	pairs: ReadonlyArray<readonly [string, string]>,
): string => {
	const width = Math.max(...pairs.map(([label]) => label.length));
	return pairs
		.map(([label, value]) => `${dim(`${label}:`.padEnd(width + 1))} ${value}`)
		.join("\n");
};
