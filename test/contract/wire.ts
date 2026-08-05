import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, it } from "node:test"
import { pairingManifest } from "../../src/sdk/index.js"
import { startFakeTv, type FakeTv } from "../fake-tv.js"
import { delay, type Connection, type ContractClient } from "./client.js"

/**
 * Golden transcript: the exact bytes a client puts on the wire.
 *
 * The behavioural contract cannot catch these. The fake TV — like the real one,
 * for most of it — will happily accept a reordered pairing manifest, and every
 * behavioural test would still pass. The real TV verifies the signature block,
 * so a rewrite that re-serialises, reorders or "tidies" the manifest breaks
 * pairing on hardware and nowhere else. Hence a byte-level assertion.
 */

const URI = {
  getVolume: "ssap://audio/getVolume",
  setVolume: "ssap://audio/setVolume"
} as const

/**
 * The serialised manifest, frozen.
 *
 * Comparing the wire bytes against `pairingManifest` only proves the client
 * transmits faithfully — edit the manifest and both sides move together. The
 * TV verifies an RSA signature over these exact bytes, so the blob itself is
 * the thing under test. Changing this constant means you have a new signature
 * and have tested it against real hardware.
 */
const MANIFEST_SHA256 = "11b0461f56af10bb0604753993292f5978b55cb1a9940232a3a2b0db685918d6"
const MANIFEST_BYTES = 2238

type Frame = {
  readonly id?: string
  readonly type?: string
  readonly uri?: string
  readonly payload?: Record<string, unknown>
}

export const runWireTests = (client: ContractClient): void => {
  describe(`SSAP wire transcript [${client.name}]`, () => {
    let tv: FakeTv
    let opened: Array<Connection>

    beforeEach(async () => {
      tv = await startFakeTv()
      opened = []
    })

    afterEach(async () => {
      for (const connection of opened) await connection.close().catch(() => {})
      await tv.close()
    })

    const connect = async (clientKey?: string) => {
      const connection = await client.connect({
        host: tv.host,
        port: tv.port,
        timeoutMs: 1000,
        ...(clientKey === undefined ? {} : { clientKey })
      })
      opened.push(connection)
      return connection
    }

    const frames = (): ReadonlyArray<Frame> => tv.rawFrames.map((raw) => JSON.parse(raw) as Frame)
    const framesOfType = (type: string) => frames().filter((f) => f.type === type)

    it("puts the signed manifest on the wire unchanged", async () => {
      const serialised = JSON.stringify(pairingManifest.manifest)

      // 1. The blob itself is what the TV's signature covers.
      assert.equal(serialised.length, MANIFEST_BYTES, "the pairing manifest changed size")
      assert.equal(
        createHash("sha256").update(serialised).digest("hex"),
        MANIFEST_SHA256,
        "the pairing manifest changed — the TV verifies a signature over these exact bytes"
      )

      // 2. The client has to transmit it verbatim: substring rather than
      //    deepEqual, because key order survives here and would not there.
      await connect()
      const raw = tv.rawFrames[0]
      assert.ok(raw !== undefined, "the first frame should be the handshake")
      assert.ok(
        raw.includes(`"manifest":${serialised}`),
        "the manifest must reach the TV exactly as declared in src/sdk/pairing.ts"
      )
    })

    it("frames the handshake as a register with the literal id register_0", async () => {
      await connect()

      const register = framesOfType("register")
      assert.equal(register.length, 1)
      assert.equal(register[0]?.id, "register_0")
      assert.deepEqual(
        register[0]?.payload,
        pairingManifest,
        "an unpaired client sends the manifest and nothing else"
      )
    })

    it("offers a stored client key alongside the manifest", async () => {
      const first = await connect()
      await first.close()
      await connect(first.clientKey)

      const register = framesOfType("register").at(-1)
      assert.deepEqual(register?.payload, {
        ...pairingManifest,
        "client-key": first.clientKey
      })
    })

    it("numbers request ids from 1, per connection", async () => {
      const first = await connect()
      await first.request(URI.getVolume)
      await first.request(URI.setVolume, { volume: 20 })
      await first.close()

      const second = await connect(first.clientKey)
      await second.request(URI.getVolume)

      const ids = framesOfType("request").map((f) => f.id)
      assert.deepEqual(ids, ["lgtv-1", "lgtv-2", "lgtv-1"], "the counter is per connection")
    })

    it("frames a request as id, type, uri and an optional payload", async () => {
      const connection = await connect()
      await connection.request(URI.setVolume, { volume: 20 })
      await connection.request(URI.getVolume)

      const [withPayload, without] = framesOfType("request")
      assert.deepEqual(withPayload, {
        id: "lgtv-1",
        type: "request",
        uri: URI.setVolume,
        payload: { volume: 20 }
      })
      assert.deepEqual(
        without,
        { id: "lgtv-2", type: "request", uri: URI.getVolume },
        "no payload key at all when there is nothing to send"
      )
    })

    it("frames a subscribe with no payload, sharing the request counter", async () => {
      const connection = await connect()
      const pending = connection.subscribe(URI.getVolume, 1)
      await delay(50)
      await pending

      const subscribe = framesOfType("subscribe")
      assert.deepEqual(subscribe, [{ id: "lgtv-1", type: "subscribe", uri: URI.getVolume }])
    })
  })
}
