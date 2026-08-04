import { Args, Command } from "@effect/cli"
import { Effect, Option } from "effect"
import { BadInput } from "../domain/errors.js"
import { AudioStatus, Uri } from "../domain/ssap.js"
import type { Tv } from "../services/Tv.js"
import { withTv } from "../services/Tv.js"
import { cyan, dim, emit, ok } from "../ui.js"

/** webOS reports volume at the top level on some models, nested on others. */
const flatten = (status: AudioStatus) => ({
  volume: status.volume ?? status.volumeStatus?.volume,
  muted: status.muted ?? status.mute ?? status.volumeStatus?.muteStatus,
  maxVolume: status.volumeStatus?.maxVolume,
  soundOutput: status.volumeStatus?.soundOutput
})

/**
 * `getStatus` is `getVolume` plus a flat `mute`, but not every model answers
 * it — fall back to `getVolume` (a subset of the same schema) rather than
 * fail a `volume`/`mute` command over a richer endpoint nobody asked for.
 */
const readStatus = (tv: Tv) =>
  tv
    .requestAs(Uri.getAudioStatus, AudioStatus)
    .pipe(Effect.catchTag("SsapFailed", () => tv.requestAs(Uri.getVolume, AudioStatus)))

const readVolume = Command.make("volume", {}, () =>
  withTv((tv) =>
    Effect.gen(function* () {
      const status = flatten(yield* readStatus(tv))
      yield* emit(
        `${cyan(String(status.volume ?? "?"))}${status.muted === true ? dim(" (muted)") : ""}${
          status.soundOutput === undefined ? "" : dim(` · out: ${status.soundOutput}`)
        }`,
        status
      )
    })
  )
).pipe(Command.withDescription("Show the current volume"))

const steps = Args.integer({ name: "steps" }).pipe(
  Args.withDefault(1),
  Args.withDescription("How many steps to move (default 1)")
)

const nudge = (name: string, uri: string, label: string) =>
  Command.make(name, { steps }, ({ steps }) =>
    Effect.gen(function* () {
      if (steps < 1) {
        return yield* Effect.fail(
          new BadInput({ detail: `Step count must be at least 1 (got ${steps}).` })
        )
      }
      yield* withTv((tv) =>
        Effect.zipRight(Effect.repeatN(tv.request(uri), steps - 1), ok(`${label} ×${steps}`))
      )
    })
  )

const volumeUp = nudge("up", Uri.volumeUp, "Volume up").pipe(
  Command.withDescription("Raise the volume")
)
const volumeDown = nudge("down", Uri.volumeDown, "Volume down").pipe(
  Command.withDescription("Lower the volume")
)

const level = Args.integer({ name: "level" }).pipe(Args.withDescription("Target volume, 0-100"))

const volumeSet = Command.make("set", { level }, ({ level }) =>
  Effect.gen(function* () {
    if (level < 0 || level > 100) {
      return yield* Effect.fail(
        new BadInput({ detail: `Volume must be between 0 and 100 (got ${level}).` })
      )
    }
    yield* withTv((tv) =>
      Effect.zipRight(tv.request(Uri.setVolume, { volume: level }), ok(`Volume set to ${level}`))
    )
  })
).pipe(Command.withDescription("Set an absolute volume level"))

export const volumeCommand = readVolume.pipe(
  Command.withSubcommands([volumeUp, volumeDown, volumeSet])
)

const muteChoices: ReadonlyArray<[string, "on" | "off" | "toggle"]> = [
  ["on", "on"],
  ["off", "off"],
  ["toggle", "toggle"]
]

const muteState = Args.choice(muteChoices, { name: "state" }).pipe(
  Args.optional,
  Args.withDescription("on, off, or toggle (default toggle)")
)

export const muteCommand = Command.make("mute", { state: muteState }, ({ state }) =>
  withTv((tv) =>
    Effect.gen(function* () {
      const requested = Option.getOrElse(state, () => "toggle" as const)
      const target =
        requested === "toggle"
          ? !(flatten(yield* readStatus(tv)).muted ?? false)
          : requested === "on"
      yield* tv.request(Uri.setMute, { mute: target })
      yield* ok(target ? "Muted" : "Unmuted")
    })
  )
).pipe(Command.withDescription("Mute, unmute, or toggle the sound"))
