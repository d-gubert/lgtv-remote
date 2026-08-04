import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Either, Option } from "effect"
import { allButtons, resolveButton } from "../src/domain/buttons.js"
import { macForActiveInterface } from "../src/domain/ssap.js"
import {
  contentTarget,
  launchPayload,
  parseYoutubeTarget,
  searchTarget
} from "../src/domain/youtube.js"
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

describe("parseYoutubeTarget", () => {
  const VIDEO = "dQw4w9WgXcQ"
  const LIST = "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"

  const target = (input: string) => {
    const parsed = parseYoutubeTarget(input)
    assert.equal(Either.isRight(parsed), true, `expected ${input} to parse`)
    return Either.getOrThrow(parsed)
  }

  it("finds the video id in every link shape people share", () => {
    for (
      const input of [
        VIDEO,
        `https://www.youtube.com/watch?v=${VIDEO}`,
        `https://m.youtube.com/watch?v=${VIDEO}&feature=share`,
        `https://music.youtube.com/watch?v=${VIDEO}`,
        `https://youtu.be/${VIDEO}`,
        `youtu.be/${VIDEO}`,
        `www.youtube.com/watch?v=${VIDEO}`,
        `https://www.youtube.com/shorts/${VIDEO}`,
        `https://www.youtube.com/embed/${VIDEO}`,
        `https://www.youtube.com/live/${VIDEO}`,
        `https://www.youtube-nocookie.com/embed/${VIDEO}`,
        `  https://www.youtube.com/watch?v=${VIDEO}  `
      ]
    ) {
      assert.deepEqual(target(input), { videoId: VIDEO }, input)
    }
  })

  it("keeps a playlist, with or without a video alongside it", () => {
    assert.deepEqual(target(`https://www.youtube.com/playlist?list=${LIST}`), { listId: LIST })
    assert.deepEqual(target(LIST), { listId: LIST })
    assert.deepEqual(target(`https://www.youtube.com/watch?v=${VIDEO}&list=${LIST}&index=2`), {
      videoId: VIDEO,
      listId: LIST
    })
  })

  it("reads the start time in the forms YouTube writes it", () => {
    const seconds = (input: string) => target(input).startSeconds
    assert.equal(seconds(`https://youtu.be/${VIDEO}?t=90`), 90)
    assert.equal(seconds(`https://www.youtube.com/watch?v=${VIDEO}&t=90s`), 90)
    assert.equal(seconds(`https://www.youtube.com/watch?v=${VIDEO}&t=1h2m3s`), 3723)
    assert.equal(seconds(`https://www.youtube.com/embed/${VIDEO}?start=45`), 45)
    assert.equal(seconds(`https://www.youtube.com/watch?v=${VIDEO}#t=30`), 30)
  })

  it("ignores a timestamp it cannot read rather than refusing the video", () => {
    assert.deepEqual(target(`https://www.youtube.com/watch?v=${VIDEO}&t=soon`), { videoId: VIDEO })
  })

  it("rejects anything that is not a YouTube target", () => {
    for (
      const input of [
        "",
        "   ",
        "not a video",
        "https://vimeo.com/12345",
        "https://www.youtube.com/",
        "https://www.youtube.com/watch?v=tooshort",
        `https://www.youtube.com/playlist?list=nonsense`,
        "https://www.youtube.com/results?search_query=cats"
      ]
    ) {
      assert.equal(Either.isLeft(parseYoutubeTarget(input)), true, `expected ${input} to be rejected`)
    }
  })
})

describe("contentTarget", () => {
  it("builds the deep link the leanback app reads", () => {
    assert.equal(
      contentTarget({ videoId: "dQw4w9WgXcQ" }),
      "https://www.youtube.com/tv?v=dQw4w9WgXcQ"
    )
    assert.equal(
      contentTarget({ videoId: "dQw4w9WgXcQ", listId: "PLabcdefghij", startSeconds: 42 }),
      "https://www.youtube.com/tv?v=dQw4w9WgXcQ&list=PLabcdefghij&t=42"
    )
  })

  it("leaves out a zero start time", () => {
    assert.equal(
      contentTarget({ videoId: "dQw4w9WgXcQ", startSeconds: 0 }),
      "https://www.youtube.com/tv?v=dQw4w9WgXcQ"
    )
  })

  it("spells spaces in a query as %20, the form the app was verified with", () => {
    assert.equal(
      contentTarget({ query: "cello suites" }),
      "https://www.youtube.com/tv?q=cello%20suites"
    )
  })

  it("escapes a query that looks like more parameters", () => {
    assert.equal(
      contentTarget({ query: "a&v=dQw4w9WgXcQ" }),
      "https://www.youtube.com/tv?q=a%26v%3DdQw4w9WgXcQ"
    )
  })
})

describe("searchTarget", () => {
  it("keeps the query, trimmed", () => {
    assert.deepEqual(searchTarget("  planet earth "), Either.right({ query: "planet earth" }))
  })

  it("refuses an empty query, which the app would silently drop", () => {
    for (const input of ["", "   ", "\t"]) {
      assert.equal(Either.isLeft(searchTarget(input)), true, `expected ${JSON.stringify(input)} to be rejected`)
    }
  })
})

describe("launchPayload", () => {
  it("sends the deep link both ways the firmware might read it", () => {
    const link = "https://www.youtube.com/tv?v=dQw4w9WgXcQ"
    assert.deepEqual(launchPayload({ videoId: "dQw4w9WgXcQ" }), {
      id: "youtube.leanback.v4",
      contentId: link,
      params: { contentTarget: link }
    })
  })

  it("honours an app id override", () => {
    assert.equal(launchPayload({ videoId: "dQw4w9WgXcQ" }, "youtube.leanback.v6")["id"], "youtube.leanback.v6")
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
