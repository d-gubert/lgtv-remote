import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { after, before, describe, it } from "node:test"
import { NodeContext } from "@effect/platform-node"
import { Effect, Either, Fiber, Layer, Option, Queue } from "effect"
import { runRepl } from "../src/commands/repl.js"
import { Uri } from "../src/sdk/index.js"
import { tokenize } from "../src/domain/tokenize.js"
import type { LineReader } from "../src/services/LineReader.js"
import { makeLineReader, makeScriptReader } from "../src/services/LineReader.js"
import * as Session from "../src/services/Session.js"
import { Settings } from "../src/services/Settings.js"
import { withTv } from "../src/services/Tv.js"
import { startFakeTv, type FakeTv } from "./fake-tv.js"

/** Every service `repl.ts`'s handlers can reach for — a superset of `Session`,
 * since `config`/`pair` read `Settings` directly once dispatched ambiently. */
type ReplContext = Effect.Effect.Context<ReturnType<typeof runRepl>>

const layers = (tv: FakeTv) => {
  const node = NodeContext.layer
  const settings = Settings.Default.pipe(Layer.provide(node))
  const session = Session.layer({
    host: Option.some(tv.host),
    port: Option.some(tv.port),
    ssl: Option.none(),
    timeout: 5,
    json: false
  }).pipe(Layer.provide(settings))
  return Layer.mergeAll(session, settings, node)
}

const until = async (check: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A `LineReader` backed by a queue the test drives directly, never touching stdin. */
const makeStubReader = () => {
  const queue = Effect.runSync(Queue.unbounded<Option.Option<string>>())
  const reader: LineReader = {
    next: Queue.take(queue),
    foreground: (effect) => Effect.exit(effect)
  }
  return {
    reader,
    type: (line: string) => Effect.runPromise(Queue.offer(queue, Option.some(line))),
    end: () => Effect.runPromise(Queue.offer(queue, Option.none()))
  }
}

/** Fresh fake TV and config dir per test, so connection/handshake counts start at zero. */
const withFakeTv = async (
  body: (ctx: {
    readonly tv: FakeTv
    readonly run: <A, E>(effect: Effect.Effect<A, E, ReplContext>) => Promise<A>
    readonly runRepl: (reader: LineReader) => ReturnType<typeof Effect.runFork>
    readonly join: (fiber: ReturnType<typeof Effect.runFork>) => Promise<unknown>
  }) => Promise<void>
): Promise<void> => {
  const configDir = await mkdtemp(join(tmpdir(), "lgtv-repl-test-"))
  process.env["LGTV_CONFIG_DIR"] = configDir
  const tv = await startFakeTv()
  const runtime = layers(tv)

  const run = <A, E>(effect: Effect.Effect<A, E, ReplContext>) =>
    Effect.runPromise(Effect.provide(effect, runtime) as Effect.Effect<A, E, never>)

  const startRepl = (reader: LineReader) =>
    Effect.runFork(Effect.provide(runRepl(reader), runtime) as Effect.Effect<void, unknown, never>)

  const joinFiber = (fiber: ReturnType<typeof Effect.runFork>) =>
    Effect.runPromise(Fiber.join(fiber as Fiber.RuntimeFiber<unknown, unknown>))

  try {
    await body({ tv, run, runRepl: startRepl, join: joinFiber })
  } finally {
    await tv.close()
    await rm(configDir, { recursive: true, force: true })
  }
}

describe("repl", () => {
  it("keeps one connection and one handshake across many lines", async () => {
    await withFakeTv(async ({ tv, runRepl: start, join }) => {
      const { reader, type } = makeStubReader()
      const fiber = start(reader)

      await until(() => tv.openConnections() === 1)
      await type("status")
      await type("volume")
      await type("volume up")
      await type("info")
      await until(() => tv.requests.some((r) => r.uri === Uri.systemInfo))

      assert.equal(tv.openConnections(), 1)
      assert.equal(tv.registerPayloads.length, 1)
      assert.ok(tv.promptCount() <= 1, "only the first connect against a fresh config dir prompts")

      await type("exit")
      await join(fiber)
      // The client-side socket closes synchronously with the fiber's exit;
      // the server's own accounting lags a network round trip behind it.
      await until(() => tv.openConnections() === 0)
    })
  })

  it("keeps one pointer socket across several button/cursor commands", async () => {
    await withFakeTv(async ({ tv, runRepl: start, join }) => {
      const { reader, type } = makeStubReader()
      const fiber = start(reader)

      await until(() => tv.openConnections() === 1)
      await type("key HOME")
      await type("key BACK")
      await type("cursor click")
      await until(() => tv.pointerFrames.length === 3)

      assert.equal(tv.openPointerConnections(), 1)
      assert.deepEqual(tv.pointerFrames, [
        "type:button\nname:HOME\n\n",
        "type:button\nname:BACK\n\n",
        "type:click\n\n"
      ])

      await type("exit")
      await join(fiber)
    })
  })

  it("reconnects after the TV goes idle between lines", async () => {
    await withFakeTv(async ({ tv, runRepl: start, join }) => {
      const { reader, type } = makeStubReader()
      const fiber = start(reader)

      await until(() => tv.openConnections() === 1)
      await type("status")
      await until(() => tv.requests.some((r) => r.uri === Uri.powerState))

      tv.dropConnections()
      await until(() => tv.openConnections() === 0)

      await type("status")
      await until(() => tv.registerPayloads.length === 2)
      assert.equal(tv.registerPayloads.length, 2)

      await type("exit")
      await join(fiber)
    })
  })

  it("drops the connection when a command dies mid-flight, and reconnects on the next line", async () => {
    await withFakeTv(async ({ tv, runRepl: start, join }) => {
      tv.silence(Uri.getVolume)
      const { reader, type } = makeStubReader()
      const fiber = start(reader)

      await until(() => tv.openConnections() === 1)
      // `getAudioStatus` 404s immediately (unimplemented on the fake TV) and
      // `readStatus` falls back to `getVolume`, which is silenced — so this
      // line is guaranteed to still be in flight when we drop the socket.
      await type("volume")
      await until(() => tv.requests.some((r) => r.uri === Uri.getVolume))
      tv.dropConnections()

      // The line failed with `TvUnreachable`, which resets the link — the
      // loop is still alive (nothing has been sent to `exit` yet) and the
      // next line opens a fresh generation.
      await until(() => tv.openConnections() === 0)
      await type("status")
      await until(() => tv.registerPayloads.length === 2)
      assert.equal(tv.registerPayloads.length, 2)

      await type("exit")
      await join(fiber)
    })
  })

  it("keeps the prompt after bad input, without opening another connection", async () => {
    await withFakeTv(async ({ tv, runRepl: start, join }) => {
      const { reader, type } = makeStubReader()
      const fiber = start(reader)

      await until(() => tv.openConnections() === 1)
      await type("")
      await type("   ")
      await type("bogus")
      await type("--help")
      await type("status")
      await until(() => tv.requests.some((r) => r.uri === Uri.powerState))

      assert.equal(tv.openConnections(), 1, "bad or blank input must not open a second connection")
      assert.equal(tv.registerPayloads.length, 1, "bad or blank input must not trigger a re-handshake")

      await type("exit")
      await join(fiber)
    })
  })

  it("stops on exit before dispatching anything", async () => {
    await withFakeTv(async ({ tv, runRepl: start, join }) => {
      const { reader, type } = makeStubReader()
      const fiber = start(reader)

      await type("exit")
      await type("status")
      await join(fiber)

      assert.equal(
        tv.requests.some((r) => r.uri === Uri.powerState),
        false,
        "`status` after `exit` must never be dispatched"
      )
    })
  })

  it("baseline: withTv outside the repl opens one connection per call", async () => {
    await withFakeTv(async ({ tv, run }) => {
      for (let i = 0; i < 4; i += 1) {
        await run(withTv((t) => t.request(Uri.getVolume)))
      }
      assert.equal(tv.registerPayloads.length, 4)
      // Same server-side lag as above: the client has already closed by the
      // time `run` resolves, but the server's own socket count trails it.
      await until(() => tv.openConnections() === 0)
    })
  })
})

describe("makeLineReader", () => {
  it("delivers every line from one piped chunk, not just the first", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume() // drain, so writes to it never back up

    const program = Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* makeLineReader({ input, output, prompt: "lgtv> " })
        input.write("status\nvolume up\n")
        const first = yield* reader.next
        const second = yield* reader.next
        input.end()
        const third = yield* reader.next
        return [first, second, third] as const
      })
    )

    const [first, second, third] = await Effect.runPromise(program)
    assert.deepEqual(first, Option.some("status"))
    assert.deepEqual(second, Option.some("volume up"))
    assert.deepEqual(third, Option.none())
  })
})

describe("end to end", () => {
  let tv: FakeTv
  let configDir: string

  before(async () => {
    configDir = await mkdtemp(join(tmpdir(), "lgtv-repl-e2e-"))
    tv = await startFakeTv()
  })

  after(async () => {
    await tv.close()
    await rm(configDir, { recursive: true, force: true })
  })

  /** Runs a script through a spawned `lgtv repl`, keeping the two streams apart. */
  const pipeScript = async (script: string, env: NodeJS.ProcessEnv = {}) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src/bin.ts"),
        "--host",
        tv.host,
        "--port",
        String(tv.port),
        "repl"
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LGTV_CONFIG_DIR: configDir, ...env }
      }
    )

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdin.write(script)
    child.stdin.end()

    const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
    return { code, stdout, stderr }
  }

  it("exits 0 and pairs once when piped a script of commands", async () => {
    const { code, stdout } = await pipeScript("status\nvolume\nexit\n")

    assert.equal(code, 0)
    assert.equal(tv.registerPayloads.length, 1)
    assert.match(stdout, /power\s+unknown/)
  })

  it("says nothing about replies unless VERBOSE is set", async () => {
    const { code, stdout, stderr } = await pipeScript("volume\nkey HOME\nexit\n")

    assert.equal(code, 0)
    assert.doesNotMatch(stderr, /←/)
    assert.doesNotMatch(stdout, /←/)
  })

  it("echoes each reply the TV sends under VERBOSE, on stderr so stdout stays pipeable", async () => {
    const { code, stdout, stderr } = await pipeScript("volume\nexit\n", { VERBOSE: "true" })

    assert.equal(code, 0)
    assert.match(stderr, new RegExp(`← ${Uri.getVolume}\\s+\\{"returnValue":true,"volume":\\d+`))
    assert.doesNotMatch(stdout, /←/, "the echo belongs to the repl's chrome, not to the command")
  })

  it('flags a line the TV never answered with "no response"', async () => {
    // The Magic-Remote input socket is write-only: `key` sends a frame and the
    // TV says nothing back, which is exactly the case worth flagging.
    const { code, stderr } = await pipeScript("key HOME\nexit\n", { VERBOSE: "true" })

    assert.equal(code, 0)
    await until(() => tv.pointerFrames.includes("type:button\nname:HOME\n\n"))
    assert.match(stderr, /← no response/)
  })

  it('never says "no response" for a line that failed — the error already said it', async () => {
    const { stderr } = await pipeScript("raw ssap://nope/atAll\nexit\n", { VERBOSE: "true" })

    assert.match(stderr, /The TV refused ssap:\/\/nope\/atAll/)
    assert.doesNotMatch(stderr, /no response/)
  })

  it("carries on past a failed line and still exits 0 — stopping is `lgtv run`'s job", async () => {
    const { code, stdout, stderr } = await pipeScript("raw ssap://nope/atAll\nstatus\nexit\n")

    assert.equal(code, 0)
    assert.match(stderr, /The TV refused/)
    assert.match(stdout, /power\s+unknown/, "the line after the failure still runs")
  })
})

describe("makeScriptReader", () => {
  it("hands over every line once, then end of input", async () => {
    const program = Effect.gen(function* () {
      const reader = yield* makeScriptReader(["status", "volume up"])
      return [yield* reader.next, yield* reader.next, yield* reader.next] as const
    })

    const [first, second, third] = await Effect.runPromise(program)
    assert.deepEqual(first, Option.some("status"))
    assert.deepEqual(second, Option.some("volume up"))
    assert.deepEqual(third, Option.none(), "an exhausted script ends the loop, like Ctrl-D")
  })
})

describe("lgtv run", () => {
  let tv: FakeTv
  let configDir: string

  before(async () => {
    configDir = await mkdtemp(join(tmpdir(), "lgtv-run-e2e-"))
    tv = await startFakeTv()
  })

  after(async () => {
    await tv.close()
    await rm(configDir, { recursive: true, force: true })
  })

  /** Spawns `lgtv run …` with **no** stdin at all — the point of the command. */
  const runScript = async (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src/bin.ts"),
        "--host",
        tv.host,
        "--port",
        String(tv.port),
        "run",
        ...args
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LGTV_CONFIG_DIR: configDir, ...env }
      }
    )

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
    return { code, stdout, stderr }
  }

  it("runs the whole sequence over one connection, with nothing on stdin", async () => {
    const before = tv.registerPayloads.length
    const { code, stdout, stderr } = await runScript(["status", "volume set 12", "volume"])

    assert.equal(code, 0)
    assert.equal(
      tv.registerPayloads.length - before,
      1,
      "three commands, one handshake — that is the whole point of sharing the loop"
    )
    assert.match(stdout, /power\s+unknown/)
    assert.match(stdout, /12/)
    assert.doesNotMatch(stderr, /Type a command/, "a script has no prompt to greet")
  })

  it("treats one argument holding several lines the same as several arguments", async () => {
    const { code, stdout } = await runScript(["status\nvolume"])

    assert.equal(code, 0)
    assert.match(stdout, /power\s+unknown/)
  })

  it("splits a command the way a shell would, so quoted arguments survive", async () => {
    const { code } = await runScript(['youtube --search "planet earth"'])

    assert.equal(code, 0)
    const launch = tv.requests.findLast((r) => r.uri === Uri.launch)
    assert.equal(
      launch?.payload?.["contentId"],
      "https://www.youtube.com/tv?q=planet%20earth",
      "the quotes group the words into one argument, exactly as at a prompt"
    )
  })

  it("stops at the first failing command and exits 1", async () => {
    const requestsBefore = tv.requests.length
    const { code, stderr } = await runScript(["raw ssap://nope/atAll", "volume set 3"])

    assert.equal(code, 1)
    assert.match(stderr, /The TV refused ssap:\/\/nope\/atAll/)
    assert.equal(
      tv.requests.slice(requestsBefore).some((r) => r.uri === Uri.setVolume),
      false,
      "the command after the failure must never run"
    )
  })

  it("stops on a line that is not a command at all, rather than skipping it", async () => {
    const requestsBefore = tv.requests.length
    const { code } = await runScript(["bogus", "status"])

    assert.equal(code, 1)
    assert.equal(
      tv.requests.slice(requestsBefore).some((r) => r.uri === Uri.powerState),
      false
    )
  })

  it("reports an unterminated quote and runs nothing after it", async () => {
    const requestsBefore = tv.requests.length
    const { code, stderr } = await runScript(['toast "unclosed', "status"])

    assert.equal(code, 1)
    assert.match(stderr, /Unterminated/)
    assert.equal(
      tv.requests.slice(requestsBefore).some((r) => r.uri === Uri.powerState),
      false
    )
  })

  it("asks for a command when given none", async () => {
    const { code, stderr } = await runScript([])

    assert.equal(code, 1)
    assert.match(stderr, /Give at least one command/)
  })

  it("renders a failure as JSON under --json, like every other command", async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src/bin.ts"),
        "--host",
        tv.host,
        "--port",
        String(tv.port),
        "--json",
        "run",
        "raw ssap://nope/atAll"
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LGTV_CONFIG_DIR: configDir } }
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve))

    assert.equal(code, 1)
    assert.equal(JSON.parse(stderr.trim())["error"], "SsapFailed")
  })
})

describe("tokenize (repl integration sanity)", () => {
  it("is what the repl loop uses to split a line before dispatch", () => {
    assert.deepEqual(tokenize("volume set 20"), Either.right(["volume", "set", "20"]))
  })
})
