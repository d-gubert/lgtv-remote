import { FileSystem, Path } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { SettingsUnreadable } from "../domain/errors.js"

export const Device = Schema.Struct({
  name: Schema.optional(Schema.String),
  mac: Schema.optional(Schema.String),
  clientKey: Schema.optional(Schema.String),
  /** Whether this TV was paired over the secure port; used when no flag is given. */
  ssl: Schema.optional(Schema.Boolean)
})
export type Device = typeof Device.Type

export const SettingsFile = Schema.Struct({
  defaultHost: Schema.optional(Schema.String),
  devices: Schema.optional(Schema.Record({ key: Schema.String, value: Device }))
})
export type SettingsFile = typeof SettingsFile.Type

const empty: SettingsFile = {}

const decode = Schema.decodeUnknown(SettingsFile)

/**
 * Persisted state: which TV is the default, and the pairing key and transport
 * per TV.
 *
 * Kept deliberately forgiving — a corrupt or hand-edited file degrades to "no
 * settings" for reads, and only fails loudly when we are asked to write.
 */
export class Settings extends Effect.Service<Settings>()("lgtv/Settings", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const base =
      process.env["LGTV_CONFIG_DIR"] ??
      path.join(
        process.env["XDG_CONFIG_HOME"] ?? path.join(process.env["HOME"] ?? ".", ".config"),
        "lgtv-remote"
      )
    const file = path.join(base, "config.json")

    const read: Effect.Effect<SettingsFile, SettingsUnreadable> = Effect.gen(function* () {
      const exists = yield* fs
        .exists(file)
        .pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (!exists) return empty
      const text = yield* fs
        .readFileString(file)
        .pipe(
          Effect.mapError(
            (cause) => new SettingsUnreadable({ path: file, detail: cause.message })
          )
        )
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => new SettingsUnreadable({ path: file, detail: "not valid JSON" })
      })
      // Unknown or future keys shouldn't brick the CLI — fall back to empty.
      return yield* decode(parsed).pipe(Effect.orElseSucceed(() => empty))
    })

    const write = (next: SettingsFile): Effect.Effect<SettingsFile, SettingsUnreadable> =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(base, { recursive: true })
        yield* fs.writeFileString(file, `${JSON.stringify(next, null, 2)}\n`)
        // The client key is a credential — keep it owner-readable only.
        yield* fs.chmod(file, 0o600).pipe(Effect.ignore)
        return next
      }).pipe(
        Effect.mapError((cause) => new SettingsUnreadable({ path: file, detail: cause.message }))
      )

    const update = (f: (current: SettingsFile) => SettingsFile) =>
      Effect.flatMap(read, (current) => write(f(current)))

    const deviceFor = (host: string) =>
      Effect.map(read, (s) => Option.fromNullable(s.devices?.[host]))

    const rememberDevice = (host: string, patch: Device) =>
      update((s) => ({
        ...s,
        defaultHost: s.defaultHost ?? host,
        devices: {
          ...s.devices,
          [host]: { ...s.devices?.[host], ...patch }
        }
      }))

    const forget = (host: string) =>
      update((s) => {
        const { [host]: _removed, ...rest } = s.devices ?? {}
        const remaining = Object.keys(rest)
        const nextDefault = s.defaultHost === host ? remaining[0] : s.defaultHost
        return {
          devices: rest,
          ...(nextDefault === undefined ? {} : { defaultHost: nextDefault })
        }
      })

    return { file, read, write, update, deviceFor, rememberDevice, forget } as const
  })
}) {}
