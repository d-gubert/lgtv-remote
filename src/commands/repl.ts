import { Command } from "@effect/cli"
import * as Descriptor from "@effect/cli/CommandDescriptor"
import { isValidationError } from "@effect/cli/ValidationError"
import type { Completer } from "node:readline"
import { Cause, Console, Effect, Either, Exit, HashMap, HashSet, Option, Ref, Stream } from "effect"
import { isLgTvError, render } from "../domain/errors.js"
import { tokenize } from "../domain/tokenize.js"
import * as Link from "../services/Link.js"
import type { LineReader } from "../services/LineReader.js"
import { makeLineReader } from "../services/LineReader.js"
import { Session } from "../services/Session.js"
import type { ConnectError, Tv } from "../services/Tv.js"
import { CurrentTv, decodeRequest } from "../services/Tv.js"
import { cyan, dim, yellow } from "../ui.js"
import { subcommands, VERSION } from "./index.js"

const builtins = ["help", "exit", "quit"]

/**
 * `VERBOSE=true lgtv repl` turns on the reply echo below. Read once, at
 * import: it is a property of how the process was started, like `NO_COLOR`,
 * and nothing inside a session can change it.
 */
const verbose = ["1", "true", "yes", "on"].includes(
  (process.env["VERBOSE"] ?? "").trim().toLowerCase()
)

const replHelp = [
  'Type any lgtv command without the leading "lgtv", e.g. `status` or `volume up`.',
  "",
  "  help          show this text",
  "  exit, quit    leave the repl",
  "  Ctrl-C        cancel the running command",
  "  Ctrl-D        leave the repl",
  "",
  verbose
    ? "Echoing the TV's raw replies (VERBOSE is set)."
    : "Start with VERBOSE=true to echo the TV's raw replies."
].join("\n")

/** Tab completion derived from the command tree, not a hand-kept list. */
const completer: Completer = (line) => {
  const words = line.split(/\s+/)
  const partial = words.at(-1) ?? ""

  const candidates: ReadonlyArray<string> =
    words.length <= 1
      ? [
          ...builtins,
          ...subcommands.flatMap((command) => [...Descriptor.getNames(command.descriptor)])
        ]
      : (() => {
          const head = words[0] ?? ""
          const matched = subcommands.find((command) =>
            HashSet.has(Descriptor.getNames(command.descriptor), head)
          )
          return matched === undefined
            ? []
            : [...HashMap.keys(Descriptor.getSubcommands(matched.descriptor))]
        })()

  const hits = candidates.filter((name) => name.startsWith(partial))
  return [hits.length === 0 ? [...candidates] : hits, partial]
}

/**
 * Under `VERBOSE`, wraps the borrowed connection so every payload the TV sends
 * back is echoed as it arrives, under whatever the command chose to print.
 * `heard` is what lets the loop flag a line that went out and got nothing back.
 *
 * Echoes go to stderr, like the rest of the repl's chrome, so `lgtv --json
 * repl | jq` still sees only the commands' own output on stdout.
 */
const echoing = (tv: Tv, heard: Ref.Ref<boolean>): Tv => {
  const request: Tv["request"] = (uri, payload) =>
    Effect.tap(tv.request(uri, payload), (result) =>
      Effect.zipRight(
        Ref.set(heard, true),
        Console.error(`${dim(`← ${uri}`)} ${cyan(JSON.stringify(result))}`)
      )
    )
  return {
    ...tv,
    request,
    requestAs: decodeRequest(request),
    // `watch` prints every update itself, so echoing them here would double a
    // stream that can run for minutes. Marking them heard is enough to keep
    // `watch` out of the "no response" case.
    subscribe: (uri) => Stream.tap(tv.subscribe(uri), () => Ref.set(heard, true))
    // `pointer` is left alone deliberately: it resolves inside the SDK, off
    // the connection's own memoised channel rather than through the `request`
    // wrapped above, so the one-off `getPointerInputSocket` exchange stays out
    // of the echo — it is connection plumbing, not an answer to the line that
    // was typed. The input socket itself is write-only, so key/cursor lines
    // have no reply to show and are flagged accordingly.
  }
}

// A root with no global options: the outer `Command.provide` at
// `src/cli.ts:68-69` already put `Session`/`Settings` in scope for every
// subcommand, including `repl`'s own handler, and this inner `Command.run`
// provides nothing further — it just dispatches into that ambient context.
// `subcommands` excludes `replCommand` itself, so typing `repl` at the
// prompt is merely an unknown argument, not recursion.
const replRoot = Command.make("lgtv", {}, () => Console.log(replHelp)).pipe(
  Command.withSubcommands(subcommands)
)

const dispatch = Command.run(replRoot, { name: "lgtv", version: VERSION })

type DispatchEffect = ReturnType<typeof dispatch>
type DispatchError = Effect.Effect.Error<DispatchEffect>
type DispatchContext = Effect.Effect.Context<DispatchEffect>

/** Everything one dispatched line can fail with: dialling, or running. */
type LineError = ConnectError | DispatchError

export interface ReplOptions {
  /**
   * Stop at the first line that fails instead of carrying on to the next.
   * `lgtv run` sets this; the prompt and piped stdin never do, since a typo
   * at a prompt should cost you the line, not the session.
   */
  readonly stopOnError?: boolean
  /** Announce the connection before the first line. Off for a scripted run. */
  readonly banner?: boolean
}

/**
 * The loop itself, taking a `LineReader` rather than opening one over
 * `process.stdin` directly — this is what lets tests drive it with a stub
 * and never touch real stdin, and `lgtv run` feed it a fixed script.
 *
 * Answers "did every line succeed?", which only a `stopOnError` caller has
 * any use for: without it the loop runs to the end regardless and always
 * says `true`.
 */
export const runRepl = (
  reader: LineReader,
  options: ReplOptions = {}
): Effect.Effect<boolean, ConnectError, DispatchContext | Session> =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session
      const link = yield* Link.make
      const stopOnError = options.stopOnError === true
      const banner = options.banner !== false

      /** Reports the outcome, and says whether the line was clean. */
      const classify = (outcome: Exit.Exit<void, LineError>): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (Exit.isSuccess(outcome)) return true
          if (Cause.isInterruptedOnly(outcome.cause)) {
            yield* Console.error("^C")
            return false
          }
          const failure = Cause.failureOption(outcome.cause)
          if (Option.isNone(failure)) {
            // A defect: something none of the handlers anticipated.
            yield* Console.error(Cause.pretty(outcome.cause))
            return false
          }
          const error = failure.value
          // @effect/cli already printed the help doc for a parse failure.
          if (isValidationError(error)) return false
          if (isLgTvError(error)) {
            yield* Console.error(render(error, { json: session.json }))
            // "Did the frame reach the TV before the socket died?" is
            // unknowable, so the line is never retried — only dropped.
            if (error._tag === "TvUnreachable") yield* link.reset
            return false
          }
          yield* Console.error(Cause.pretty(outcome.cause))
          return false
        })

      // Fail fast, before the first prompt: pairing happens up front, and an
      // unreachable TV exits with the normal `✗ Could not reach…` instead of
      // a prompt that would fail on every line.
      const tv = yield* link.tv
      if (banner) yield* Console.error(`Connected to ${tv.host}. Type a command, or "help".`)

      const step: Effect.Effect<boolean, never, DispatchContext | Session> = Effect.gen(
        function* () {
          const line = yield* reader.next
          if (Option.isNone(line)) return true

          const trimmed = line.value.trim()
          if (trimmed === "") return yield* step
          if (trimmed === "help") {
            yield* Console.log(replHelp)
            return yield* step
          }
          if (trimmed === "exit" || trimmed === "quit") return true

          const tokens = tokenize(trimmed)
          if (Either.isLeft(tokens)) {
            yield* Console.error(render(tokens.left, { json: session.json }))
            if (stopOnError) return false
            return yield* step
          }
          if (tokens.right.length === 0) return yield* step

          const heard = yield* Ref.make(false)
          const outcome = yield* reader.foreground(
            Effect.flatMap(link.tv, (connected) =>
              dispatch(["", "", ...tokens.right]).pipe(
                Effect.provideService(
                  CurrentTv,
                  verbose ? echoing(connected, heard) : connected
                )
              )
            )
          )
          const ok = yield* classify(outcome)
          // Only after a line that worked: a failure has already said what
          // happened, and "no response" underneath it would just be noise.
          if (verbose && Exit.isSuccess(outcome) && !(yield* Ref.get(heard))) {
            yield* Console.error(`${dim("←")} ${yellow("no response")}`)
          }
          if (!ok && stopOnError) return false
          return yield* step
        }
      )

      return yield* step
    })
  )

export const replCommand = Command.make("repl", {}, () =>
  Effect.scoped(
    Effect.gen(function* () {
      // `--json` piping needs stdout to stay clean, so the prompt (and the
      // rest of the interactive chrome) moves to stderr when it is not a TTY.
      const isTty = process.stdout.isTTY === true
      const reader = yield* makeLineReader({
        input: process.stdin,
        output: isTty ? process.stdout : process.stderr,
        prompt: "lgtv> ",
        historySize: 200,
        completer
      })
      yield* runRepl(reader)
    })
  )
).pipe(Command.withDescription("Drive many commands over one long-lived connection"))
