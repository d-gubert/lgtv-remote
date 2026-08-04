import * as readline from "node:readline"
import { Effect, Exit, Fiber, Option, Queue, Scope } from "effect"

export interface LineReaderOptions {
  readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean }
  readonly output?: NodeJS.WritableStream
  readonly prompt?: string
  readonly historySize?: number
  readonly completer?: readline.Completer
}

export interface LineReader {
  /** The next line, or `none` at end of input (EOF, Ctrl-D, Ctrl-C at an empty prompt). */
  readonly next: Effect.Effect<Option.Option<string>>
  /**
   * Runs one command in the foreground. Ctrl-C interrupts *it* and hands
   * control back to the prompt rather than ending the session.
   */
  readonly foreground: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<Exit.Exit<A, E>, never, R>
}

/**
 * Wraps `node:readline` in the shape `lgtv repl` needs. Chosen over
 * `@effect/platform` `Terminal.readLine` and `@effect/cli` `Prompt.text`:
 * neither gives history, a completer, a `SIGINT` event, echo, and non-TTY
 * piped stdin from one API — `Terminal.readLine` in particular builds an
 * interface with no `output` and forces raw mode, so Ctrl-C there is an `rl`
 * `'SIGINT'` event with no `'line'`, and it hangs forever.
 */
export const makeLineReader = (
  options: LineReaderOptions
): Effect.Effect<LineReader, never, Scope.Scope> =>
  Effect.gen(function* () {
    // `'line'` fires as data arrives whether or not anything is waiting on
    // it, and with no listener the line is dropped — a question-per-line
    // loop would lose everything after the first when several lines arrive
    // in one piped chunk. The listener has to be persistent instead.
    const lines = yield* Queue.unbounded<Option.Option<string>>()
    const sigints = yield* Queue.unbounded<void>()
    let commandRunning = false

    const rl = readline.createInterface({
      input: options.input,
      ...(options.output === undefined ? {} : { output: options.output }),
      terminal: options.input.isTTY === true,
      ...(options.historySize === undefined ? {} : { historySize: options.historySize }),
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      ...(options.completer === undefined ? {} : { completer: options.completer })
    })

    rl.on("line", (line) => lines.unsafeOffer(Option.some(line)))
    rl.on("close", () => lines.unsafeOffer(Option.none()))
    rl.on("SIGINT", () => {
      if (commandRunning) {
        sigints.unsafeOffer(void 0)
      } else if (rl.line !== "") {
        rl.write(null, { ctrl: true, name: "u" })
        rl.prompt(true)
      } else {
        rl.close()
      }
    })

    // `runMain` skips `process.exit` on a clean 0, and an open interface
    // keeps stdin ref'd — without pausing it too, the process never exits.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rl.close()
        options.input.pause()
      })
    )

    const next: Effect.Effect<Option.Option<string>> = Effect.suspend(() => {
      rl.prompt()
      return Queue.take(lines)
    })

    // `Fiber.await` returns an `Exit` and never fails, so an ordinary Ctrl-C
    // stays contained here instead of surfacing as a real interruption of
    // the repl; and `Fiber.interrupt` waits for the loser's finalizers,
    // unlike `Effect.raceFirst`, which would tear a `watch` subscription
    // down in the background instead of before the next prompt.
    const foreground = <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<Exit.Exit<A, E>, never, R> =>
      Effect.gen(function* () {
        // Set before forking: a Ctrl-C landing in the gap would otherwise read
        // as "at an empty prompt" and end the session instead of the command.
        commandRunning = true
        const fiber = yield* Effect.fork(effect)
        const watcher = yield* Effect.fork(
          Effect.flatMap(Queue.take(sigints), () => Fiber.interrupt(fiber))
        )
        const exit = yield* Fiber.await(fiber)
        commandRunning = false
        yield* Fiber.interrupt(watcher)
        // An impatient second Ctrl-C would otherwise sit in the queue and kill
        // whatever the next line runs.
        yield* Queue.takeAll(sigints)
        return exit
      })

    return { next, foreground }
  })
