#!/usr/bin/env node
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Cause, Console, Effect } from "effect"
import { run } from "./cli.js"
import { explain, type LgTvError } from "./domain/errors.js"

const knownTags = new Set([
  "TvUnreachable",
  "PairingFailed",
  "NotPaired",
  "SsapFailed",
  "UnexpectedResponse",
  "TvNotConfigured",
  "SettingsUnreadable",
  "DiscoveryFailed",
  "WakeFailed",
  "BadInput"
])

const isLgTvError = <E>(error: E): error is E & LgTvError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  knownTags.has(String((error as { _tag: unknown })._tag))

// The Session layer is only built once parsing succeeds, so failures have to
// read the flag straight off argv.
const jsonMode = process.argv.includes("--json")

let exitCode = 0

const main = run(process.argv).pipe(
  Effect.catchIf(isLgTvError, (error) =>
    Effect.zipRight(
      Console.error(
        jsonMode
          ? JSON.stringify({ error: error._tag, message: explain(error), detail: error })
          : `\u001b[31m✗\u001b[0m ${explain(error)}`
      ),
      Effect.sync(() => {
        exitCode = 1
      })
    )
  ),
  Effect.provide(NodeContext.layer)
)

NodeRuntime.runMain(main, {
  // Our own failures are already reported above; anything left is a real defect
  // and still gets the default pretty report.
  teardown: (exit, onExit) => {
    if (exit._tag === "Failure" && Cause.isInterruptedOnly(exit.cause)) {
      onExit(130)
      return
    }
    onExit(exit._tag === "Success" ? exitCode : 1)
  }
})
