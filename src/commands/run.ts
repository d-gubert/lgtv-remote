import { Args, Command } from "@effect/cli";
import { Data, Effect } from "effect";

import { runRepl } from "./repl.js";
import { BadInput } from "../domain/errors.js";
import { makeScriptReader } from "../services/LineReader.js";

/**
 * Deliberately not an `LgTvError`: the line that failed has already been
 * reported by the loop, so there is nothing left to explain. This exists only
 * to carry "a command failed" out to `bin.ts`, which turns it into exit 1 and
 * prints nothing further.
 */
export class ScriptAborted extends Data.TaggedError("ScriptAborted")<{}> {}

const commands = Args.text({ name: "command" }).pipe(
  Args.withDescription(
    'One lgtv command without the leading "lgtv", e.g. "volume set 12"',
  ),
  Args.repeated,
);

export const runCommand = Command.make("run", { commands }, ({ commands }) =>
  Effect.gen(function* () {
    // A single argument may hold several lines, so a here-doc or `$'a\nb'`
    // reads the same as one argument per command.
    const lines = commands.flatMap((command) => command.split("\n"));
    if (lines.every((line) => line.trim() === "")) {
      return yield* Effect.fail(
        new BadInput({
          detail: `Give at least one command, e.g. lgtv run "volume set 12".`,
        }),
      );
    }

    const reader = yield* makeScriptReader(lines);
    // Unlike the prompt, a script that keeps going after a failure would hide
    // it behind whatever the later lines print — and `lgtv a && lgtv b` is the
    // thing this replaces, so it has to stop where that would stop.
    const clean = yield* runRepl(reader, { stopOnError: true, banner: false });
    if (!clean) return yield* Effect.fail(new ScriptAborted());
  }),
).pipe(
  Command.withDescription(
    "Run a sequence of commands over one connection, stopping at the first failure",
  ),
);
