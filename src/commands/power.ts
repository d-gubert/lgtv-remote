import { Command, Options } from "@effect/cli"
import { Console, Duration, Effect, Either, Option, Schedule } from "effect"
import { Uri } from "../domain/ssap.js"
import { Session } from "../services/Session.js"
import { connect, withTv } from "../services/Tv.js"
import { parseMac, wake } from "../services/Wol.js"
import { cyan, dim, emit, ok } from "../ui.js"

const waitFor = Options.integer("wait").pipe(
  Options.withDescription("Seconds to wait for the TV to come back before giving up"),
  Options.withDefault(0)
)

export const onCommand = Command.make("on", { waitFor }, ({ waitFor }) =>
  Effect.gen(function* () {
    const session = yield* Session
    const host = yield* session.host
    const rawMac = yield* session.mac
    const mac = yield* Either.match(parseMac(rawMac), {
      onLeft: Effect.fail,
      onRight: Effect.succeed
    })

    yield* wake(mac, { host })

    if (waitFor <= 0) {
      yield* emit(
        `${cyan("⏻")} Magic packet sent to ${mac}\n${dim("Use --wait <seconds> to block until the TV answers.")}`,
        { sent: true, mac, host }
      )
      return
    }

    yield* Console.error(dim(`Waiting up to ${waitFor}s for ${host} to come online…`))
    const online = yield* Effect.scoped(connect({ announcePairing: false })).pipe(
      Effect.as(true),
      Effect.retry(
        Schedule.spaced(Duration.seconds(2)).pipe(
          Schedule.compose(Schedule.recurUpTo(Duration.seconds(waitFor)))
        )
      ),
      Effect.orElseSucceed(() => false)
    )

    yield* online
      ? emit(`${cyan("⏻")} ${host} is awake`, { sent: true, mac, host, online: true })
      : emit(
          `${cyan("⏻")} Magic packet sent to ${mac}, but ${host} did not answer within ${waitFor}s.\n${dim("Enable Settings → General → Devices → TV Management → Mobile TV On (or 'LG Connect Apps') so the TV listens while in standby.")}`,
          { sent: true, mac, host, online: false }
        )
  })
).pipe(Command.withDescription("Power the TV on with a Wake-on-LAN magic packet"))

export const offCommand = Command.make("off", {}, () =>
  withTv((tv) =>
    Effect.zipRight(
      tv.request(Uri.turnOff),
      ok(`${tv.host} going to standby`)
    )
  )
).pipe(Command.withDescription("Put the TV into standby"))

const screenTarget = Options.choice("state", ["on", "off"]).pipe(
  Options.withDescription("Turn the panel on or off while audio keeps playing")
)

export const screenCommand = Command.make("screen", { state: screenTarget }, ({ state }) =>
  withTv((tv) =>
    Effect.zipRight(
      tv.request(state === "off" ? Uri.screenOff : Uri.screenOn),
      ok(`Screen ${state}`)
    )
  )
).pipe(Command.withDescription("Blank or restore the panel (audio keeps playing)"))

export const statusCommand = Command.make("status", {}, () =>
  withTv((tv) =>
    Effect.gen(function* () {
      const soften = <A>(effect: Effect.Effect<A, unknown>) =>
        Effect.option(effect) as Effect.Effect<Option.Option<A>>

      const power = yield* soften(tv.request(Uri.powerState))
      const app = yield* soften(tv.request(Uri.foregroundApp))
      const volume = yield* soften(tv.request(Uri.getVolume))
      const channel = yield* soften(tv.request(Uri.currentChannel))

      const get = <A>(source: Option.Option<Record<string, unknown>>, key: string): A | undefined =>
        Option.isSome(source) ? (source.value[key] as A | undefined) : undefined

      const volumeStatus = get<Record<string, unknown>>(volume, "volumeStatus") ?? {}
      const level = get<number>(volume, "volume") ?? (volumeStatus["volume"] as number | undefined)
      const muted = get<boolean>(volume, "muted") ?? (volumeStatus["muteStatus"] as boolean | undefined)

      const data = {
        host: tv.host,
        power: get<string>(power, "state") ?? "unknown",
        app: get<string>(app, "appId") ?? null,
        volume: level ?? null,
        muted: muted ?? null,
        channel: get<string>(channel, "channelName") ?? null,
        channelNumber: get<string>(channel, "channelNumber") ?? null
      }

      const channelLine =
        data.channel === null ? [] : [`channel   ${data.channelNumber ?? "?"} ${data.channel}`]

      yield* emit(
        [
          `${cyan(tv.host)}`,
          `power     ${data.power}`,
          `app       ${data.app ?? dim("—")}`,
          `volume    ${data.volume ?? dim("—")}${data.muted === true ? " (muted)" : ""}`,
          ...channelLine
        ].join("\n"),
        data
      )
    })
  )
).pipe(Command.withDescription("Show power state, current app, volume and channel"))
