import { Data } from "effect"

/**
 * Every failure the CLI can produce, as data. `explain` at the bottom of this
 * file is the only place that turns one into prose; `bin.ts` calls it for both
 * the human and the `--json` rendering.
 */

export class TvUnreachable extends Data.TaggedError("TvUnreachable")<{
  readonly url: string
  readonly cause: unknown
}> {}

export class PairingFailed extends Data.TaggedError("PairingFailed")<{
  readonly url: string
  readonly detail: string
}> {}

/** We have a host but no stored client key for it. */
export class NotPaired extends Data.TaggedError("NotPaired")<{
  readonly host: string
}> {}

/** The TV answered, but the answer was a refusal. */
export class SsapFailed extends Data.TaggedError("SsapFailed")<{
  readonly uri: string
  readonly detail: string
}> {}

/** A response did not match the shape we expected. */
export class UnexpectedResponse extends Data.TaggedError("UnexpectedResponse")<{
  readonly uri: string
  readonly detail: string
}> {}

/** No `--host`, no `LGTV_HOST`, and nothing saved. */
export class TvNotConfigured extends Data.TaggedError("TvNotConfigured")<{
  readonly missing: "host" | "mac"
}> {}

export class SettingsUnreadable extends Data.TaggedError("SettingsUnreadable")<{
  readonly path: string
  readonly detail: string
}> {}

export class DiscoveryFailed extends Data.TaggedError("DiscoveryFailed")<{
  readonly detail: string
}> {}

export class WakeFailed extends Data.TaggedError("WakeFailed")<{
  readonly detail: string
}> {}

export class BadInput extends Data.TaggedError("BadInput")<{
  readonly detail: string
}> {}

export type LgTvError =
  | TvUnreachable
  | PairingFailed
  | NotPaired
  | SsapFailed
  | UnexpectedResponse
  | TvNotConfigured
  | SettingsUnreadable
  | DiscoveryFailed
  | WakeFailed
  | BadInput

const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** A one-line explanation plus, where useful, the next thing to try. */
export const explain = (error: LgTvError): string => {
  switch (error._tag) {
    case "TvUnreachable":
      return `Could not reach the TV at ${error.url} (${causeText(error.cause)}).
  • Is the TV on and on the same network?
  • Try \`lgtv on\` first if it is in standby, then retry.
  ${
    error.url.startsWith("wss://")
      ? "• If this model does not use the secure port, add `--no-ssl`."
      : "• Some 2023+ models only accept the secure port: add `--ssl`."
  }`
    case "PairingFailed":
      return `Pairing with ${error.url} failed: ${error.detail}.
  • Accept the prompt on the TV screen within the timeout.
  • Check Settings → General → External Devices → "LG Connect Apps" is on.`
    case "NotPaired":
      return `No stored client key for ${error.host}. Run \`lgtv pair\` first.`
    case "SsapFailed":
      return `The TV refused ${error.uri}: ${error.detail}`
    case "UnexpectedResponse":
      return `The TV's reply to ${error.uri} was not in the expected shape: ${error.detail}`
    case "TvNotConfigured":
      return error.missing === "host"
        ? `No TV configured. Run \`lgtv discover\`, then \`lgtv config set-host <ip>\` (or pass --host / set LGTV_HOST).`
        : `No MAC address known for this TV, so Wake-on-LAN cannot be sent. Run \`lgtv pair\` while the TV is on, or \`lgtv config set-mac <mac>\`.`
    case "SettingsUnreadable":
      return `Could not use the settings file at ${error.path}: ${error.detail}`
    case "DiscoveryFailed":
      return `Discovery failed: ${error.detail}`
    case "WakeFailed":
      return `Wake-on-LAN failed: ${error.detail}`
    case "BadInput":
      return error.detail
  }
}
