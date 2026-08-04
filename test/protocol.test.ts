import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { NodeContext } from "@effect/platform-node"
import { Chunk, Effect, Layer, Option, Stream } from "effect"
import { LaunchPoints, Uri, VolumeStatus } from "../src/domain/ssap.js"
import * as Session from "../src/services/Session.js"
import { Settings } from "../src/services/Settings.js"
import { connect, withTv } from "../src/services/Tv.js"
import { startFakeTv, type FakeTv } from "./fake-tv.js"

let tv: FakeTv
let configDir: string

const runtime = () =>
  Session.layer({
    host: Option.some(tv.host),
    port: Option.some(tv.port),
    ssl: Option.none(),
    timeout: 5,
    json: false
  }).pipe(Layer.provide(Settings.Default), Layer.provide(NodeContext.layer))

const run = <A, E>(effect: Effect.Effect<A, E, Session.Session>) =>
  Effect.runPromise(Effect.provide(effect, runtime()) as Effect.Effect<A, E, never>)

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "lgtv-test-"))
  process.env["LGTV_CONFIG_DIR"] = configDir
  tv = await startFakeTv()
})

after(async () => {
  await tv.close()
  await rm(configDir, { recursive: true, force: true })
})

describe("handshake", () => {
  it("pairs, and stores the key the TV hands back", async () => {
    const key = await run(Effect.scoped(Effect.map(connect(), (t) => t.clientKey)))
    assert.ok(key.startsWith("key-"), `expected a granted key, got ${key}`)
    assert.ok(tv.knownKeys.has(key))
  })

  it("reuses the stored key on the next connection", async () => {
    const first = await run(Effect.scoped(Effect.map(connect(), (t) => t.clientKey)))
    const second = await run(Effect.scoped(Effect.map(connect(), (t) => t.clientKey)))
    assert.equal(first, second, "the second connection should not re-pair")
  })
})

describe("requests", () => {
  it("reads the volume through the schema", async () => {
    const status = await run(withTv((t) => t.requestAs(Uri.getVolume, VolumeStatus)))
    assert.equal(status.volume, 12)
    assert.equal(status.volumeStatus?.soundOutput, "tv_speaker")
  })

  it("sends the payload the TV expects", async () => {
    await run(withTv((t) => t.request(Uri.setVolume, { volume: 33 })))
    const sent = tv.requests.filter((r) => r.uri === Uri.setVolume).at(-1)
    assert.deepEqual(sent?.payload, { volume: 33 })

    const status = await run(withTv((t) => t.requestAs(Uri.getVolume, VolumeStatus)))
    assert.equal(status.volume, 33)
  })

  it("decodes list responses", async () => {
    const { launchPoints } = await run(withTv((t) => t.requestAs(Uri.listApps, LaunchPoints)))
    assert.equal(launchPoints.length, 2)
    assert.equal(launchPoints[0]?.id, "netflix")
  })

  it("surfaces an error frame as SsapFailed", async () => {
    const result = await run(Effect.either(withTv((t) => t.request("ssap://does/not/exist"))))
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") {
      assert.equal(result.left._tag, "SsapFailed")
      assert.match(String(result.left.detail), /404/)
    }
  })

  it("treats returnValue:false as a failure and keeps the TV's reason", async () => {
    const result = await run(
      Effect.either(withTv((t) => t.request(Uri.openChannel, { channelNumber: "999" })))
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") {
      assert.equal(result.left._tag, "SsapFailed")
      assert.equal(result.left.detail, "Invalid channel")
    }
  })
})

describe("magic remote", () => {
  it("sends button frames on the pointer socket", async () => {
    await run(
      withTv((t) =>
        Effect.gen(function* () {
          const pointer = yield* t.pointer
          yield* pointer.button("HOME")
          yield* pointer.click
          yield* pointer.scroll(0, -3)
          yield* Effect.sleep("100 millis")
        })
      )
    )
    assert.ok(tv.pointerFrames.includes("type:button\nname:HOME\n\n"))
    assert.ok(tv.pointerFrames.includes("type:click\n\n"))
    assert.ok(tv.pointerFrames.includes("type:scroll\ndx:0\ndy:-3\n\n"))
  })
})

describe("subscriptions", () => {
  it("streams updates until the caller stops taking them", async () => {
    const updates = await run(
      withTv((t) =>
        Effect.gen(function* () {
          const collected = yield* Effect.fork(
            Stream.runCollect(Stream.take(t.subscribe(Uri.getVolume), 3))
          )
          yield* Effect.sleep("80 millis")
          yield* Effect.sync(() => tv.pushVolume(40))
          yield* Effect.sleep("40 millis")
          yield* Effect.sync(() => tv.pushVolume(41))
          return yield* collected.await
        })
      )
    )
    assert.equal(updates._tag, "Success")
    if (updates._tag === "Success") {
      const values = Chunk.toReadonlyArray(updates.value).map((p) => p["volume"])
      assert.deepEqual(values, [33, 40, 41])
    }
  })
})

describe("malformed traffic", () => {
  it("drops frames that are not JSON instead of crashing the listener", async () => {
    const updates = await run(
      withTv((t) =>
        Effect.gen(function* () {
          const collected = yield* Effect.fork(
            Stream.runCollect(Stream.take(t.subscribe(Uri.getVolume), 2))
          )
          yield* Effect.sleep("80 millis")
          yield* Effect.sync(() => tv.pushGarbage())
          yield* Effect.sleep("40 millis")
          yield* Effect.sync(() => tv.pushVolume(55))
          return yield* collected.await
        })
      )
    )
    assert.equal(updates._tag, "Success")
    if (updates._tag === "Success") {
      const values = Chunk.toReadonlyArray(updates.value).map((p) => p["volume"])
      assert.deepEqual(values, [41, 55], "the garbage frame should be skipped, not fatal")
    }
  })
})

describe("transport resolution", () => {
  // A host of its own, so pairing in the tests above cannot colour these.
  const host = "10.0.0.7"

  const withSession = <A, E>(
    ssl: Option.Option<boolean>,
    use: (session: Session.SessionApi) => Effect.Effect<A, E>
  ) =>
    Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Session.Session, use),
        Session.layer({
          host: Option.some(host),
          port: Option.none(),
          ssl,
          timeout: 5,
          json: false
        }).pipe(Layer.provide(Settings.Default), Layer.provide(NodeContext.layer))
      ) as Effect.Effect<A, E, never>
    )

  it("uses the transport the TV was paired over when no flag is given", async () => {
    await withSession(Option.some(true), (session) => session.rememberKey(host, "key-secure"))
    assert.equal(
      await withSession(Option.none(), (session) => session.wsUrl),
      `wss://${host}:3001`
    )
  })

  it("lets --no-ssl override what was remembered", async () => {
    assert.equal(
      await withSession(Option.some(false), (session) => session.wsUrl),
      `ws://${host}:3000`
    )
  })

  it("forgets ssl when the TV is paired again over the plain port", async () => {
    await withSession(Option.some(false), (session) => session.rememberKey(host, "key-plain"))
    assert.equal(
      await withSession(Option.none(), (session) => session.wsUrl),
      `ws://${host}:3000`
    )
  })
})

describe("connection failures", () => {
  it("reports an unreachable TV rather than hanging", async () => {
    // Port 1 is reserved; nothing is listening, so the connect is refused.
    const isolated = Session.layer({
      host: Option.some("127.0.0.1"),
      port: Option.some(1),
      ssl: Option.none(),
      timeout: 3,
      json: false
    }).pipe(Layer.provide(Settings.Default), Layer.provide(NodeContext.layer))

    const result = await Effect.runPromise(
      Effect.provide(Effect.either(Effect.scoped(connect({ announcePairing: false }))), isolated)
    )

    assert.equal(result._tag, "Left")
    if (result._tag === "Left") {
      assert.equal(result.left._tag, "TvUnreachable")
    }
  })
})
