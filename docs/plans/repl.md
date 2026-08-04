# Plan — `lgtv repl`: many SSAP commands over one connection

Status: approved, not yet implemented.

## Context

Every command today opens its own websocket, runs the webOS `register` handshake, sends one or
two frames, and closes: each handler calls `withTv` (`src/services/Tv.ts:345`), which is
`Effect.scoped(Effect.flatMap(connect(), use))`. Driving the TV interactively therefore pays a
full connect + handshake per keystroke-sized action, and `lgtv key` re-opens the Magic Remote
pointer socket every time.

`lgtv repl` gives one long-lived connection: a single handshake, a single pointer socket, and a
prompt where you type the existing subcommands without the `lgtv ` prefix. It reuses the
`@effect/cli` tree as-is, so all 22 commands work on day one and stay in sync automatically.

Also in scope: make sure every endpoint in the `Uri` table is reachable from a subcommand — two
are currently orphaned.

## Design

Three pieces:

1. **`CurrentTv` seam** — an optional `Context.Tag` holding an already-open `Tv`. `withTv` uses it
   when present, otherwise dials as it does today. All existing handlers keep working unchanged
   and transparently reuse the repl's connection.
2. **Shared subcommand array** — the list inlined in `src/cli.ts:78-101` moves to its own module so
   both the real CLI root and the repl's parser can build from it (and so `repl` can exclude
   itself, avoiding recursion and an import cycle).
3. **The loop** — `node:readline` for the prompt, one `Command.run` per line against a root command
   with no global options, each line run as a forked fiber so Ctrl-C cancels the command rather
   than the repl.

### Verified facts this rests on

- `Command.run(cmd, cfg)` returns `(args: ReadonlyArray<string>) => Effect<void, E | ValidationError, R | CliApp.Environment>`
  (`node_modules/@effect/cli/dist/dts/Command.d.ts:353`). It **drops the first two argv entries
  unconditionally** (`splitExecutable`, `internal/cliApp.js:78`; passing `executable` does not
  change that), so a line is dispatched as `run(["", "", ...tokens])` — and without the root's own
  name, which `prefixCommand` adds itself.
- Parse failures **print the help doc to stderr and then fail** with `ValidationError`. Catch and
  swallow it, adding nothing, or the message appears twice. `--help`/`--version` are `BuiltIn`
  directives that print and **succeed**. `grep process.exit node_modules/@effect/cli/dist/esm` is
  empty — nothing can kill the loop.
- `CliApp.Environment = FileSystem | Path | Terminal` (`CliApp.d.ts:33`), all supplied by
  `NodeContext.layer` in `src/bin.ts:45`. No change to `bin.ts`'s provisioning is needed.
- `Command.provide` at the root (`src/cli.ts:102-103`) puts `Session` and `Settings` into every
  subcommand handler's context, including `repl`'s. The inner root carries no `Command.provide`,
  so the nested `Command.run` provides nothing and re-resolves nothing — it runs the matched
  handler in the ambient context, inheriting the outer `--host/--port/--ssl/--timeout/--json`.
- `Descriptor.getNames` / `Descriptor.getSubcommands`
  (`node_modules/@effect/cli/dist/dts/CommandDescriptor.d.ts:117,122`) let tab completion be
  derived from the command tree instead of hand-maintained.

## Files

### 1. `src/domain/errors.ts` — one shared renderer

`src/bin.ts:7-24` keeps its own copy of the tag list, which `docs/ARCHITECTURE.md` already flags as
a wart. Move it here and make drift a compile error:

```ts
const tags = {
  TvUnreachable: true, PairingFailed: true, NotPaired: true, SsapFailed: true,
  UnexpectedResponse: true, TvNotConfigured: true, SettingsUnreadable: true,
  DiscoveryFailed: true, WakeFailed: true, BadInput: true
} satisfies Record<LgTvError["_tag"], true>

export const isLgTvError = <E>(error: E): error is E & LgTvError => /* hasOwn(tags, _tag) */

/** The one line the CLI prints for a failure, in whichever mode is active. */
export const render = (error: LgTvError, options: { readonly json: boolean }): string =>
  options.json
    ? JSON.stringify({ error: error._tag, message: explain(error), detail: error })
    : `[31m✗[0m ${explain(error)}`
```

`bin.ts` then drops `knownTags` and its local `isLgTvError` and calls
`render(error, { json: jsonMode })`; the repl calls it with `session.json`. Its `teardown` block
stays untouched.

### 2. `src/services/Tv.ts` — the `CurrentTv` seam and a liveness flag

```ts
/**
 * Set by `lgtv repl` to the connection it is holding open. `withTv` uses it
 * instead of dialling, which is what lets 22 hand-written handlers share one
 * socket and one handshake without any of them knowing the repl exists.
 */
export class CurrentTv extends Context.Tag("lgtv/CurrentTv")<CurrentTv, Tv>() {}

export const withTv = <A, E, R>(
  use: (tv: Tv) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | ConnectError, Session | Exclude<R, Scope.Scope>> =>
  Effect.flatMap(Effect.serviceOption(CurrentTv), (borrowed) =>
    Option.isSome(borrowed)
      ? Effect.scoped(use(borrowed.value))
      : Effect.scoped(Effect.flatMap(connect(), use))
  ) as Effect.Effect<A, E | ConnectError, Session | Exclude<R, Scope.Scope>>
```

`Effect.serviceOption` has `R = never`, so the public signature is unchanged and **no handler needs
editing**. The inner `Effect.scoped` stays on both branches — it is what satisfies `use`'s `Scope`
requirement (`tv.pointer`) and preserves `Exclude<R, Scope>`.

Plus one additive field on the `Tv` interface, so the repl can tell a dead connection *before*
sending into it — the pump already tracks this (`Tv.ts:97`), it just isn't exposed:

```ts
/** `some(reason)` once the socket has gone; every request will fail. */
readonly closed: Effect.Effect<Option.Option<string>>
// in connect(): const closed = Effect.sync(() => Option.fromNullable(pump.isClosed()))
```

This matters because of `Tv.ts:93-102`: once the pump closes, *every* later request fails instantly
with `TvUnreachable`. Without the pre-flight check, the first command after the TV goes to standby
always fails even though a reconnect would have worked.

The two commands that call `connect()` directly (`pair`, `src/commands/setup.ts:40`; `on --wait`,
`src/commands/power.ts:35`) are left alone — both deliberately want a fresh connection. Consequence
to document: run inside the repl they open a second socket and re-handshake.

### 3. `src/commands/index.ts` (new)

The array now inlined at `src/cli.ts:78-101`:

```ts
/** Every command that works the same from the shell and from `lgtv repl`. */
export const subcommands = [discoverCommand, pairCommand, /* … */ configCommand] as const
```

`as const` is required: `withSubcommands` wants a non-empty **tuple**, and a plain array infers
`Array<…>` and will not match. A separate module because `src/cli.ts` imports `replCommand` while
`src/commands/repl.ts` imports the array — routing through this file breaks the cycle, and it is
also the whole recursion guard: `subcommands` does not contain `replCommand`, so `repl` typed at
the prompt is just an unknown argument.

### 4. `src/services/LineReader.ts` (new)

`node:readline` (callback flavour), chosen over `@effect/platform` `Terminal.readLine` and
`@effect/cli` `Prompt.text`: it is the only one that gives history, a completer, a `SIGINT` event,
echo, and non-TTY piped stdin from one API. `Terminal.readLine` builds an interface with **no
`output`** and forces raw mode — no echo, no prompt, no history — and in raw mode Ctrl-C becomes an
`rl` `'SIGINT'` event with no `'line'`, so it hangs forever.

**Use a persistent `'line'` listener feeding a `Queue`, not `rl.question`.** Node emits `'line'` as
data arrives whether or not a question is pending, and with no listener the line is **dropped** —
`printf 'status\nvolume up\n' | lgtv repl` arrives as one chunk, so a question-per-line loop loses
everything after the first. (`readline/promises`' `question` also never settles if the interface
closes underneath it.)

```ts
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
```

- `Queue.unbounded<Option<string>>` with a `none` sentinel rather than `effect/Mailbox`, which is
  still marked `@experimental`.
- `createInterface({ input, output?, terminal: input.isTTY === true, historySize, prompt, completer })`,
  with the repo's conditional-spread idiom for `output` (`exactOptionalPropertyTypes`).
- SIGINT handler, three states: command running → offer to a `sigints` queue that interrupts the
  fiber; prompt with text → `rl.write(null, { ctrl: true, name: "u" })` and re-prompt; empty
  prompt → offer `none` and end the loop.
- **Do not `rl.pause()` while a command runs** — a paused interface stops processing keypresses, so
  Ctrl-C would be lost. Keystrokes typed during a long command buffer up, exactly as in a shell.
- The release finalizer must `rl.close()` **and** `input.pause()`. `runMain` skips `process.exit`
  on a clean 0, and an open interface keeps stdin ref'd — this is the single most likely
  "works but never quits" bug in the feature.

`foreground` is `Effect.fork` + `Fiber.await` + `Fiber.interrupt`, not `Effect.raceFirst`:
`Fiber.await` returns an `Exit` and never fails, so the interrupt is *contained* and
`Cause.isInterruptedOnly` at `src/bin.ts:52` never fires on an ordinary Ctrl-C; and
`Fiber.interrupt` awaits the loser's finalizers, so a `watch` subscription is unregistered before
the next prompt (`raceFirst` disconnects both sides and cleans up in the background —
non-deterministic for tests).

### 5. `src/services/Link.ts` (new) — one live connection, replaced on demand

```ts
export interface Link {
  /** The live connection, opening (or re-opening) one if needed. */
  readonly tv: Effect.Effect<Tv, ConnectError, Session>
  /** Forget the current connection; the next `tv` opens a fresh one. */
  readonly reset: Effect.Effect<void>
}
```

A `Ref<Option<{ tv, scope }>>` of connection generations. Each generation gets its own
`Scope.make()`, with `Scope.extend(connect(), scope)` to bind the socket without closing the scope,
and `Effect.onError(cause => Scope.close(scope, Exit.failCause(cause)))` because `Scope.extend`
does **not** close on failure — otherwise a failed `connect()` strands a half-open socket.

**Pointer socket: lazy, memoised on success only**, via `Ref<Option<PointerInput>>` inside the
generation:

- not eager, because it opens a second websocket most sessions never need and 404s on some models —
  failing `lgtv repl` at startup over a channel you weren't going to use is wrong;
- **not `Effect.cached`/`cachedWithTTL`**: `Effect.cached` is `effect.memoize`, built on
  `intoDeferred`, which stores the whole `Exit` — **failures are cached permanently**, so one
  transient refusal of `getPointerInputSocket` would break every `key`/`cursor` for the session.
- A plain `Ref` (not `SynchronizedRef`) is safe because the loop awaits each line before reading the
  next — worth a comment, since that invariant could silently break later.
- The memoised `pointer` has `R = never`, which is assignable to `Tv["pointer"]`'s
  `Effect<…, Scope>` (`R` is covariant), so no cast is needed. It rebuilds on reconnect for free:
  it lives in the generation, and `reset` discards the generation wholesale.

**Death is detected twice, because neither signal alone is enough:** pre-flight via the new
`tv.closed` (idle death, TV went to standby between lines), and post-flight by running `link.reset`
whenever a line failed with `TvUnreachable`.

**No automatic retry of the failed line.** "The socket was already dead so the frame never left" is
indistinguishable from "the frame arrived and then the socket died" — `off` succeeds and *then*
drops the socket. Silently re-sending `volume up` or `key POWER` is worse than a visible error;
print it, drop the connection, let the user press ↑.

### 6. `src/domain/tokenize.ts` (new)

`tokenize(line): Either.Either<ReadonlyArray<string>, BadInput>`, matching `parseMac`'s convention
(`src/services/Wol.ts:8`). Whitespace split honouring `'…'`, `"…"` and `\` escapes so
`toast "Dinner is ready"` and `type "planet earth" --enter` behave as in a shell; unterminated
quote → `BadInput`. Pure, unit-tested. Mind `noUncheckedIndexedAccess`: `line[i]` is
`string | undefined`.

### 7. `src/commands/repl.ts` (new)

```ts
const replRoot = Command.make("lgtv", {}, () => Console.log(replHelp)).pipe(
  Command.withSubcommands(subcommands)
)
const dispatch = Command.run(replRoot, { name: "lgtv", version: VERSION })
// one line becomes: dispatch(["", "", ...tokens]).pipe(Effect.provideService(CurrentTv, tv))
```

Per line: `tokenize` → `link.tv` → `dispatch` under `CurrentTv`, run through `reader.foreground`,
then classify the `Exit`:

| outcome | action |
| --- | --- |
| success | — |
| `Exit.isInterrupted` | print `^C`, keep the prompt |
| `ValidationError` | nothing — `@effect/cli` already printed the help doc |
| `isLgTvError` | `render(error, { json: session.json })`; `link.reset` if `TvUnreachable` |
| anything else (defect) | `Cause.pretty`, keep the session |

Builtins handled before dispatch: blank line, `help`, `exit`/`quit`. The loop is a recursive
`step` effect and **needs an explicit type annotation** or TS reports "implicitly has type 'any' …
referenced in its own initializer" — `Tv.ts:275` (`awaitKey`) already uses this pattern.

The loop must always end by **returning normally**, never by self-interrupting, or the teardown at
`src/bin.ts:51-57` reports 130 instead of 0.

**Eager first connect**: force `link.tv` before the first prompt, so pairing happens up front and an
unreachable TV fails `lgtv repl` with the normal `✗ Could not reach…` and exit 1 rather than
dropping you into a prompt that fails on every line. Cost: you can't use the repl purely for
`config show`. Reversible in one line.

Prompt and banner go to **stderr** when stdout is not a TTY, so `--json` piping stays clean.

**Completion** is derived from the tree, not a hand-kept list: first token against
`Descriptor.getNames` of each entry in `subcommands` plus the builtins, second token against
`Descriptor.getSubcommands` of the matched command.

### 8. `src/cli.ts`

Import `subcommands` and `replCommand`; the list becomes `[...subcommands, replCommand]`. Add a
`lgtv repl` line to the `quickStart` blurb. Nothing else changes.

### 9. Endpoint coverage — the two orphans in `Uri`

Everything in `src/domain/ssap.ts:4-57` is wired to a subcommand except:

- `Uri.getAudioStatus` (`ssap://audio/getStatus`) — richer than `getVolume` (adds a flat `mute`).
  Wire it into `volume`/`mute`: read `getAudioStatus`, fall back to `getVolume` on `SsapFailed`,
  extending `flatten` (`src/commands/audio.ts:9-14`) to accept the extra shape.
- `Uri.systemInfo` (`ssap://system/getSystemInfo`) — `{ modelName, serialNumber, receiverType,
  features, programMode }` per `docs/PROTOCOL.md:432`. Fold into `info`
  (`src/commands/misc.ts:19-37`) alongside the firmware block, softened with `Effect.option` so an
  older model that 404s still prints the rest. Needs a `SystemInfo` schema in `src/domain/ssap.ts`.

Anything outside the `Uri` table stays reachable with `raw <uri> --payload '{…}'`, which now runs on
the repl's connection too.

### 10. Docs

- `README.md`: a `lgtv repl` entry in the command block (§ Commands, line 36) and a short section
  showing the prompt and the piped form.
- `docs/ARCHITECTURE.md`: a repl section; the `CurrentTv` seam in *Request lifecycle* (§ line 59) —
  the invariant that a command never dials when a connection is already in scope; delete the
  "adding an error type means editing both files" note, which the shared renderer fixes; note that
  repeated `watch` in one session leaves subscriptions live TV-side (we never send `unsubscribe`;
  the mailbox unregisters, so there is no leak our side).

## Tests

The loop takes a `LineReader`, so tests hand it a stub and never touch `process.stdin`. Reuse the
`runtime()`/`run()` harness from `test/protocol.test.ts:18-39` (`Session.layer` + `Settings.Default`
+ `NodeContext.layer`, `LGTV_CONFIG_DIR` in a `mkdtemp`).

`test/repl.test.ts`:

- **one connection, one handshake**: `["status", "volume", "volume up", "info"]` →
  `fake.openConnections() === 1` during the run and `fake.registerPayloads.length === 1`. Assert
  `promptCount() <= 1`, not `=== 1`: only the first connect against a fresh config dir prompts.
- **one pointer socket**: `["key HOME", "key BACK", "cursor click"]` →
  `fake.openPointerConnections() === 1`, `fake.pointerFrames.length === 3`.
- **reconnect**: one command, `fake.dropConnections()`, poll until `openConnections() === 0`, then
  another line → succeeds, `registerPayloads.length === 2`. Exercises the `tv.closed` pre-flight.
- **post-flight reset**: drop mid-command → the line fails with `TvUnreachable`, the loop survives,
  the next line reconnects.
- **bad input keeps the prompt**: `["bogus", "status"]`, and `["--help", "status"]`, and
  `["", "   ", "status"]` (no extra connection).
- **`exit` stops the loop**: `["exit", "status"]` → `fake.requests` has no `powerState`.
- **baseline contrast**: 4 × `withTv` without the repl → 4 connections. Makes the point of the
  feature testable.
- **`makeLineReader` against a `PassThrough`**: write `"status\nvolume up\n"` in a **single**
  `write()` and assert both lines arrive — the typeahead regression `rl.question` would fail. Then
  `end()` and assert `next` yields `none`.
- **end-to-end exit code**: spawn `tsx src/bin.ts --host … --port … repl` with `LGTV_CONFIG_DIR`
  set, pipe `"status\nvolume\n"`, assert exit 0 and one handshake. The only tier that proves the
  process actually *exits* (the `input.pause()` finalizer) and that non-TTY mode works.
- Tokenizer cases into `test/units.test.ts`: quotes, embedded spaces, escapes, unterminated quote.
- Do **not** run `pair` inside a repl test and assert one handshake — it dials its own connection
  by design.
- The existing contract suite needs no change: `CurrentTv` is absent there, so `withTv` keeps its
  current behaviour.

Use a small `until(() => …)` poll helper rather than fixed sleeps; `node:test` has no fake timers
here.

## Verification

```bash
npm run typecheck && npm test
npm run build
printf 'status\nvolume up\nvolume\n' | node dist/bin.js --host 192.168.0.230 repl   # one handshake
node dist/bin.js --host 192.168.0.230 repl                                          # interactive
```

Interactive checks by hand: tab completion on `vol<TAB>`, ↑ history, `key HOME` twice (the second
is visibly faster — no second pointer socket), `watch volume` then Ctrl-C returns to the prompt
rather than exiting, Ctrl-D exits and `echo $?` is 0 (and the process really does exit), and `off`
followed by another command reports the drop and attempts a reconnect.

SSDP discovery does not work on this development network, so `discover` inside the repl is not a
useful smoke test — use `--host` directly.

## Known limitations to document, not fix

1. **Global flags are not parseable per line.** `lgtv> --json status` fails; `lgtv --json repl` sets
   the whole session. A later phase could add `:json on` / `:host <ip>` meta-commands by holding a
   `Ref<SessionApi>` and using `Effect.provideServiceEffect(dispatch(…), Session, Ref.get(ref))`
   inside the inner run to override the ambient `Session`.
2. **`pair` and `on --wait` open their own socket** inside the repl (`setup.ts:44`, `power.ts:35`).
   Arguably correct for `pair`, whose whole job is a fresh handshake.
3. **Subscriptions are never cancelled TV-side.** Repeated `watch` leaves N subscriptions pushing
   frames the pump then drops. A real fix needs an `unsubscribe` frame.
4. **`--wizard` inside the repl** would build a second readline over the same stdin and flip raw
   mode — undefined behaviour. Cheapest fix if it ever matters: reject it in the tokenizer.
5. **Piped mode always exits 0**, even if lines failed. Left as-is deliberately; a `Ref<number>` of
   failures could drive a non-zero exit when `!isTTY` if scripting ever needs it.
6. Naming the inner root `"lgtv"` collides on the `@effect/cli/Command/(lgtv)` tag *key* with the
   outer root. Verified harmless — nothing reads the root command's parsed-args service, and
   `registeredDescriptors` is a `WeakMap` on distinct objects — but it is a latent surprise.
