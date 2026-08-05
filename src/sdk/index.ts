/**
 * An SSAP client for LG webOS TVs, with no dependency beyond `ws`.
 *
 *     import { connect, Uri, VolumeStatus } from "lgtv-remote/sdk"
 *
 *     const tv = await connect({ host: "192.168.0.230", clientKey: saved })
 *     const { volume } = await tv.requestAs(Uri.getVolume, VolumeStatus)
 *     await tv.close()
 *
 * The CLI in this repository is one consumer of it (`src/services/Tv.ts` binds
 * it to Effect); nothing here knows that, and nothing here imports `effect`.
 * Protocol details live in `docs/PROTOCOL.md`.
 */

export {
  connect,
  type CallOptions,
  type Connection,
  type ConnectOptions,
  type Payload,
  type Pointer,
  type Subscription,
  type SubscriptionListener,
  type Updates
} from "./client.js"

export {
  isSsapError,
  PairingFailed,
  SsapError,
  SsapFailed,
  TvUnreachable,
  UnexpectedResponse,
  type AnySsapError,
  type SsapErrorTag
} from "./errors.js"

export { pairingManifest } from "./pairing.js"
export { Uri } from "./uri.js"

export {
  array,
  boolean,
  number,
  optional,
  payload,
  record,
  string,
  struct,
  unknown,
  type DecodeResult,
  type Decoder,
  type Infer
} from "./decode.js"

export * from "./responses.js"
