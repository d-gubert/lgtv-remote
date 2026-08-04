import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Either, Option } from "effect"
import { allButtons, resolveButton } from "../src/domain/buttons.js"
import { macForActiveInterface } from "../src/domain/ssap.js"
import { parseMac } from "../src/services/Wol.js"

const WIRED = "74:C1:7E:3E:A4:E3"
const WIFI = "74:C1:7E:76:2B:E6"
const bothMacs = { wiredInfo: { macAddress: WIRED }, wifiInfo: { macAddress: WIFI } }

describe("parseMac", () => {
  it("accepts the formats people actually paste", () => {
    for (const input of ["a1:b2:c3:d4:e5:f6", "A1-B2-C3-D4-E5-F6", "a1b2c3d4e5f6"]) {
      assert.deepEqual(parseMac(input), Either.right("A1:B2:C3:D4:E5:F6"), input)
    }
  })

  it("rejects anything that is not six hex pairs", () => {
    for (const input of ["", "nonsense", "a1:b2:c3:d4:e5", "a1:b2:c3:d4:e5:f6:07", "zz:b2:c3:d4:e5:f6"]) {
      assert.equal(Either.isLeft(parseMac(input)), true, `expected ${input} to be rejected`)
    }
  })
})

describe("macForActiveInterface", () => {
  it("picks the interface the TV reports as connected, not the first one listed", () => {
    // `getinfo` lists both MACs even though only the Wi-Fi NIC has a link.
    assert.deepEqual(
      macForActiveInterface(bothMacs, {
        wired: { state: "disconnected" },
        wifi: { state: "connected" }
      }),
      Option.some(WIFI)
    )
    assert.deepEqual(
      macForActiveInterface(bothMacs, {
        wired: { state: "connected" },
        wifi: { state: "disconnected" }
      }),
      Option.some(WIRED)
    )
  })

  it("falls back to any MAC when no interface claims to be connected", () => {
    assert.deepEqual(macForActiveInterface(bothMacs, {}), Option.some(WIRED))
    assert.deepEqual(macForActiveInterface(bothMacs), Option.some(WIRED))
    assert.deepEqual(
      macForActiveInterface({ wifiInfo: { macAddress: WIFI } }, { wifi: { state: "unknown" } }),
      Option.some(WIFI)
    )
  })

  it("skips a connected interface that reports no MAC", () => {
    assert.deepEqual(
      macForActiveInterface(
        { wiredInfo: {}, wifiInfo: { macAddress: WIFI } },
        { wired: { state: "connected" }, wifi: { state: "connected" } }
      ),
      Option.some(WIFI)
    )
  })

  it("is none when the TV lists no MACs at all", () => {
    assert.deepEqual(macForActiveInterface({}, { wifi: { state: "connected" } }), Option.none())
  })
})

describe("resolveButton", () => {
  it("passes canonical names through", () => {
    for (const button of allButtons) {
      assert.equal(resolveButton(button), button)
    }
  })

  it("is case-insensitive and understands aliases", () => {
    assert.equal(resolveButton("home"), "HOME")
    assert.equal(resolveButton(" Ok "), "ENTER")
    assert.equal(resolveButton("vol+"), "VOLUMEUP")
    assert.equal(resolveButton("ch-"), "CHANNELDOWN")
    assert.equal(resolveButton("ff"), "FASTFORWARD")
  })

  it("returns undefined for unknown names", () => {
    assert.equal(resolveButton("teleport"), undefined)
  })
})
