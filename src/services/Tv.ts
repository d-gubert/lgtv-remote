import { Console, Context, Duration, Effect, Option, Scope, Stream } from "effect"
import {
  PairingFailed,
  SettingsUnreadable,
  SsapFailed,
  TvNotConfigured,
  TvUnreachable,
  UnexpectedResponse
} from "../domain/errors.js"
import * as Ssap from "../sdk/index.js"
import { Session } from "./Session.js"

/**
 * The Effect binding for `src/sdk` — the protocol itself lives there, and
 * nothing in this file speaks websockets.
 *
 * What it adds is what Effect is here for: failures as typed values in the
 * error channel rather than rejections, sockets tied to a `Scope` so a Ctrl-C
 * mid-request still closes them, subscriptions as `Stream`s, and the client key
 * resolved through `Session` instead of passed in by hand.
 */

export type AnyPayload = Ssap.Payload

/** Anything the protocol itself can raise, once it is in the error channel. */
type ProtocolError = TvUnreachable | PairingFailed | SsapFailed | UnexpectedResponse

/** The SDK reports failure by rejecting; the CLI wants it in the error channel. */
const toDomainError = (error: Ssap.AnySsapError): ProtocolError => {
  switch (error._tag) {
    case "TvUnreachable":
      return new TvUnreachable({ url: error.url, cause: error.cause })
    case "PairingFailed":
      return new PairingFailed({ url: error.url, detail: error.detail })
    case "SsapFailed":
      return new SsapFailed({ uri: error.uri, detail: error.detail })
    case "UnexpectedResponse":
      return new UnexpectedResponse({ uri: error.uri, detail: error.detail })
  }
}

/**
 * Runs one SDK call. Anything that is not an `SsapError` is a bug rather than a
 * protocol outcome, so it dies instead of being folded into a typed failure —
 * mapping it would put a `TypeError` in front of the user dressed up as a TV
 * problem.
 */
const call = <A>(work: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, ProtocolError> =>
  Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
    Effect.catchAll((error) =>
      Ssap.isSsapError(error) ? Effect.fail(toDomainError(error)) : Effect.die(error)
    )
  )

export interface PointerInput {
  readonly button: (name: string) => Effect.Effect<void, TvUnreachable>
  readonly click: Effect.Effect<void, TvUnreachable>
  readonly move: (dx: number, dy: number, drag: boolean) => Effect.Effect<void, TvUnreachable>
  readonly scroll: (dx: number, dy: number) => Effect.Effect<void, TvUnreachable>
}

export interface Tv {
  readonly url: string
  readonly host: string
  readonly clientKey: string
  readonly request: (
    uri: string,
    payload?: Record<string, unknown>
  ) => Effect.Effect<AnyPayload, SsapFailed | TvUnreachable>
  readonly requestAs: <A>(
    uri: string,
    decoder: Ssap.Decoder<A>,
    payload?: Record<string, unknown>
  ) => Effect.Effect<A, SsapFailed | TvUnreachable | UnexpectedResponse>
  readonly subscribe: (uri: string) => Stream.Stream<AnyPayload, SsapFailed | TvUnreachable>
  /** The Magic-Remote input channel, opened once per connection and shared. */
  readonly pointer: Effect.Effect<PointerInput, SsapFailed | TvUnreachable | UnexpectedResponse>
  /** `some(reason)` once the socket has gone; every request will fail. */
  readonly closed: Effect.Effect<Option.Option<string>>
}

/**
 * Set by `lgtv repl` to the connection it is holding open. `withTv` uses it
 * instead of dialling, which is what lets 22 hand-written handlers share one
 * socket and one handshake without any of them knowing the repl exists.
 */
export class CurrentTv extends Context.Tag("lgtv/CurrentTv")<CurrentTv, Tv>() {}

/**
 * `requestAs` expressed in terms of a `request`. Shared so that anything
 * decorating `request` — `lgtv repl`'s reply echo, say — covers the decoded
 * calls too, instead of silently missing every `requestAs`.
 */
export const decodeRequest =
  (request: Tv["request"]): Tv["requestAs"] =>
  (uri, decoder, payload) =>
    Effect.flatMap(request(uri, payload), (result) => {
      const decoded = decoder.decode(result)
      return decoded.ok
        ? Effect.succeed(decoded.value)
        : Effect.fail(new UnexpectedResponse({ uri, detail: decoded.reason }))
    })

export type ConnectError =
  | TvUnreachable
  | PairingFailed
  | SsapFailed
  | UnexpectedResponse
  | TvNotConfigured
  | SettingsUnreadable

/**
 * Connects, completes the webOS handshake, and stores the client key the TV
 * hands back. `announcePairing` is used to tell the user to look at the screen
 * the first time they pair.
 */
export const connect = (
  options: { readonly announcePairing?: boolean } = {}
): Effect.Effect<Tv, ConnectError, Session | Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* Session
    const host = yield* session.host
    const url = yield* session.wsUrl
    const storedKey = yield* session.clientKey

    const announce = () =>
      Effect.runSync(Console.error("→ Accept the pairing request on your TV screen…"))

    // Not `Effect.acquireRelease`, which would make the whole handshake
    // uninterruptible — pairing can wait a minute for someone to walk to the
    // TV, and Ctrl-C has to work during it. The mask keeps the dial itself
    // interruptible while guaranteeing the finalizer is registered for a
    // connection that did open.
    const connection = yield* Effect.uninterruptibleMask((restore) =>
      restore(
        call((signal) =>
          Ssap.connect({
            host,
            url,
            signal,
            timeoutMs: Duration.toMillis(session.timeout),
            ...(Option.isSome(storedKey) ? { clientKey: storedKey.value } : {}),
            ...(options.announcePairing === false ? {} : { onPairingPrompt: announce })
          })
        )
      ).pipe(
        Effect.tap((open) =>
          Effect.addFinalizer(() => Effect.promise(() => open.close()))
        )
      )
    )

    if (connection.keyChanged) {
      yield* session.rememberKey(host, connection.clientKey)
    }

    // `call` carries every protocol failure because `connect` can produce every
    // protocol failure. Sending a frame cannot: the handshake is long over, and
    // `request` decodes nothing. Saying so as a defect keeps those two out of
    // the error channel of all 22 command handlers.
    const impossible = { PairingFailed: Effect.die, UnexpectedResponse: Effect.die }

    const request: Tv["request"] = (uri, payload) =>
      call((signal) => connection.request(uri, payload, { signal })).pipe(
        Effect.catchTags(impossible)
      )

    const subscribe = (uri: string) =>
      Stream.asyncPush<AnyPayload, SsapFailed | TvUnreachable>(
        (emit) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              connection.subscribe(uri, {
                onUpdate: (payload) => {
                  emit.single(payload)
                },
                onError: (error) => {
                  // The SDK types this callback as the two a subscription can
                  // raise; `toDomainError` is written against the whole union
                  // and cannot say so on the way back out.
                  emit.fail(toDomainError(error) as SsapFailed | TvUnreachable)
                }
              })
            ),
            (subscription) => Effect.sync(() => subscription.close())
          ),
        { bufferSize: "unbounded" }
      )

    // The pointer channel is write-only, so the only thing a write can report
    // is that the socket has gone; anything else is a bug worth a defect.
    const write = (work: () => Promise<void>): Effect.Effect<void, TvUnreachable> =>
      Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
        Effect.catchAll((error) =>
          error instanceof Ssap.TvUnreachable
            ? Effect.fail(new TvUnreachable({ url: error.url, cause: error.cause }))
            : Effect.die(error)
        )
      )

    // No signal: the channel belongs to the connection, not to whichever
    // command happened to open it, so an interrupted `key` must not abort a
    // socket the next line is about to reuse.
    const pointer = Effect.map(
      call(() => connection.pointer()).pipe(Effect.catchTag("PairingFailed", Effect.die)),
      (input): PointerInput => ({
        button: (name) => write(() => input.button(name)),
        click: write(() => input.click()),
        move: (dx, dy, drag) => write(() => input.move(dx, dy, drag)),
        scroll: (dx, dy) => write(() => input.scroll(dx, dy))
      })
    )

    return {
      url: connection.url,
      host: connection.host,
      clientKey: connection.clientKey,
      request,
      requestAs: decodeRequest(request),
      subscribe,
      pointer,
      closed: Effect.sync(() => Option.fromNullable(connection.closed))
    }
  })

/**
 * Connect, run `use`, then close the socket — the shape most commands want.
 * When `lgtv repl` has a connection open (`CurrentTv`), reuses it instead of
 * dialling, so 22 hand-written handlers share one socket without any of them
 * knowing the repl exists.
 */
export const withTv = <A, E, R>(
  use: (tv: Tv) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | ConnectError, Session | Exclude<R, Scope.Scope>> =>
  Effect.flatMap(Effect.serviceOption(CurrentTv), (borrowed) =>
    Option.isSome(borrowed)
      ? Effect.scoped(use(borrowed.value))
      : Effect.scoped(Effect.flatMap(connect(), use))
  ) as Effect.Effect<A, E | ConnectError, Session | Exclude<R, Scope.Scope>>
