#!/usr/bin/env node
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Cause, Console, Effect } from "effect";

import { run } from "./cli.js";
import { isLgTvError, render } from "./domain/errors.js";

// The Session layer is only built once parsing succeeds, so failures have to
// read the flag straight off argv.
const jsonMode = process.argv.includes("--json");

let exitCode = 0;

const main = run(process.argv).pipe(
  Effect.catchIf(isLgTvError, (error) =>
    Effect.zipRight(
      Console.error(render(error, { json: jsonMode })),
      Effect.sync(() => {
        exitCode = 1;
      }),
    ),
  ),
  // `lgtv run` stopping on a failed command. The failure itself was already
  // reported line-by-line, so this only has to be worth a non-zero exit.
  Effect.catchTag("ScriptAborted", () =>
    Effect.sync(() => {
      exitCode = 1;
    }),
  ),
  Effect.provide(NodeContext.layer),
);

NodeRuntime.runMain(main, {
  // Our own failures are already reported above; anything left is a real defect
  // and still gets the default pretty report.
  teardown: (exit, onExit) => {
    if (exit._tag === "Failure" && Cause.isInterruptedOnly(exit.cause)) {
      onExit(130);
      return;
    }
    onExit(exit._tag === "Success" ? exitCode : 1);
  },
});
