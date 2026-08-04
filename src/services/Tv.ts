import { Console, Duration, Effect, Option, Queue, Schema, Scope, Stream } from "effect"
import WebSocket from "ws"
import {
  PairingFailed,
  SettingsUnreadable,
  SsapFailed,
  TvNotConfigured,
  TvUnreachable,
  UnexpectedResponse
} from "../domain/errors.js"
import { pairingManifest } from "../domain/pairing.js"
import { AnyPayload, IncomingFrame, PointerSocket, Uri } from "../domain/ssap.js"
import { Session } from "./Session.js"

/** What the message pump hands to whoever is waiting on a frame id. */
type Delivery =
  | { readonly _tag: "Frame"; readonly frame: IncomingFrame }
  | { readonly _tag: "Closed"; readonly reason: string }

type Listener = (delivery: Delivery) => void

const decodeFrame = Schema.decodeUnknownOption(IncomingFrame)

/** Opens a websocket and ties its lifetime to the current scope. */
const openSocket = (
  url: string,
  timeout: Duration.Duration
): Effect.Effect<WebSocket, TvUnreachable, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.async<WebSocket, TvUnreachable>((resume) => {
      const socket = new WebSocket(url, {
        // webOS presents a self-signed certificate on the secure port.
        rejectUnauthorized: false,
        handshakeTimeout: Duration.toMillis(timeout)
      })
      const detach = () => {
        socket.off("open", onOpen)
        socket.off("error", onError)
      }
      const onOpen = () => {
        detach()
        resume(Effect.succeed(socket))
      }
      const onError = (cause: Error) => {
        detach()
        socket.terminate()
        resume(Effect.fail(new TvUnreachable({ url, cause })))
      }
      socket.once("open", onOpen)
      socket.once("error", onError)
      return Effect.sync(() => {
        detach()
        socket.terminate()
      })
    }),
    (socket) =>
      Effect.sync(() => {
        socket.removeAllListeners()
        socket.close()
      })
  )

/** Demultiplexes incoming frames by their request id. */
const startPump = (socket: WebSocket) =>
  Effect.sync(() => {
    const listeners = new Map<string, Listener>()
    let closed: string | undefined

    const shutdown = (reason: string) => {
      if (closed !== undefined) return
      closed = reason
      for (const listener of [...listeners.values()]) {
        listener({ _tag: "Closed", reason })
      }
      listeners.clear()
    }

    socket.on("message", (raw) => {
      // This runs inside a `ws` event listener, so anything thrown here is an
      // uncaught exception. Junk on the wire must be dropped, not raised.
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        return
      }
      const frame = decodeFrame(parsed)
      if (Option.isNone(frame)) return
      const id = frame.value.id
      if (id === undefined) return
      listeners.get(id)?.({ _tag: "Frame", frame: frame.value })
    })
    socket.on("close", (code) => shutdown(`connection closed by the TV (code ${code})`))
    socket.on("error", (cause: Error) => shutdown(cause.message))

    return {
      isClosed: () => closed,
      register: (id: string, listener: Listener) => {
        if (closed !== undefined) {
          listener({ _tag: "Closed", reason: closed })
          return
        }
        listeners.set(id, listener)
      },
      unregister: (id: string) => listeners.delete(id)
    }
  })

type Pump = Effect.Effect.Success<ReturnType<typeof startPump>>

const sendText = (socket: WebSocket, url: string, data: string) =>
  Effect.async<void, TvUnreachable>((resume) => {
    // `ws` hands the stream's callback straight through, so success arrives as
    // `null` rather than `undefined`.
    socket.send(data, (cause) => {
      resume(
        cause === undefined || cause === null
          ? Effect.void
          : Effect.fail(new TvUnreachable({ url, cause }))
      )
    })
  })

/** A scoped mailbox for one request id. */
const mailbox = (pump: Pump, id: string) =>
  Effect.acquireRelease(
    Effect.map(Queue.unbounded<Delivery>(), (queue) => {
      pump.register(id, (delivery) => {
        queue.unsafeOffer(delivery)
      })
      return queue
    }),
    (queue) =>
      Effect.sync(() => pump.unregister(id)).pipe(Effect.zipRight(Queue.shutdown(queue)))
  )

const interpret = (
  url: string,
  uri: string,
  delivery: Delivery
): Effect.Effect<AnyPayload, SsapFailed | TvUnreachable> => {
  if (delivery._tag === "Closed") {
    return Effect.fail(new TvUnreachable({ url, cause: delivery.reason }))
  }
  const frame = delivery.frame
  if (frame.type === "error") {
    return Effect.fail(new SsapFailed({ uri, detail: frame.error ?? "unspecified error" }))
  }
  const payload = (frame.payload ?? {}) as Record<string, unknown>
  if (payload["returnValue"] === false) {
    const detail = payload["errorText"] ?? payload["errorCode"] ?? "the TV returned no reason"
    return Effect.fail(new SsapFailed({ uri, detail: String(detail) }))
  }
  return Effect.succeed(payload)
}

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
  readonly requestAs: <A, I>(
    uri: string,
    schema: Schema.Schema<A, I>,
    payload?: Record<string, unknown>
  ) => Effect.Effect<A, SsapFailed | TvUnreachable | UnexpectedResponse>
  readonly subscribe: (uri: string) => Stream.Stream<AnyPayload, SsapFailed | TvUnreachable>
  /** Opens the Magic-Remote input channel; scoped to the connection. */
  readonly pointer: Effect.Effect<
    PointerInput,
    SsapFailed | TvUnreachable | UnexpectedResponse,
    Scope.Scope
  >
}

export type ConnectError =
  | TvUnreachable
  | PairingFailed
  | SsapFailed
  | UnexpectedResponse
  | TvNotConfigured
  | SettingsUnreadable

/**
 * Connects, completes the webOS handshake, and stores the client key the TV
 * hands back. `announce` is used to tell the user to look at the screen the
 * first time they pair.
 */
export const connect = (
  options: { readonly announcePairing?: boolean } = {}
): Effect.Effect<Tv, ConnectError, Session | Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* Session
    const host = yield* session.host
    const url = yield* session.wsUrl
    const storedKey = yield* session.clientKey

    const socket = yield* openSocket(url, session.timeout)
    const pump = yield* startPump(socket)

    let counter = 0
    const nextId = () => `lgtv-${++counter}`

    const sendJson = (frame: Record<string, unknown>) =>
      sendText(socket, url, JSON.stringify(frame))

    const request = (uri: string, payload?: Record<string, unknown>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const id = nextId()
          const queue = yield* mailbox(pump, id)
          yield* sendJson({
            id,
            type: "request",
            uri,
            ...(payload === undefined ? {} : { payload })
          })
          const delivery = yield* Queue.take(queue)
          return yield* interpret(url, uri, delivery)
        })
      ).pipe(
        Effect.timeoutFail({
          duration: session.timeout,
          onTimeout: () =>
            new SsapFailed({
              uri,
              detail: `no reply within ${Duration.toSeconds(session.timeout)}s`
            })
        })
      )

    const requestAs = <A, I>(
      uri: string,
      schema: Schema.Schema<A, I>,
      payload?: Record<string, unknown>
    ) =>
      Effect.flatMap(request(uri, payload), (result) =>
        Schema.decodeUnknown(schema)(result).pipe(
          Effect.mapError(
            (issue) => new UnexpectedResponse({ uri, detail: issue.message.split("\n")[0] ?? "" })
          )
        )
      )

    const subscribe = (uri: string) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const id = nextId()
          const queue = yield* mailbox(pump, id)
          yield* sendJson({ id, type: "subscribe", uri })
          return Stream.fromQueue(queue).pipe(
            Stream.mapEffect((delivery) => interpret(url, uri, delivery))
          )
        })
      )

    // ---- handshake ----------------------------------------------------------

    const registerId = "register_0"
    const clientKey = yield* Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* mailbox(pump, registerId)
        yield* sendJson({
          id: registerId,
          type: "register",
          payload: {
            ...pairingManifest,
            ...(Option.isSome(storedKey) ? { "client-key": storedKey.value } : {})
          }
        })

        let announced = false
        const awaitKey: Effect.Effect<string, PairingFailed | TvUnreachable> = Effect.gen(
          function* () {
            const delivery = yield* Queue.take(queue)
            if (delivery._tag === "Closed") {
              return yield* Effect.fail(new PairingFailed({ url, detail: delivery.reason }))
            }
            const frame = delivery.frame
            if (frame.type === "error") {
              return yield* Effect.fail(
                new PairingFailed({ url, detail: frame.error ?? "the TV rejected the handshake" })
              )
            }
            if (frame.type === "registered") {
              const key = (frame.payload as Record<string, unknown> | undefined)?.["client-key"]
              return typeof key === "string"
                ? key
                : yield* Effect.fail(
                    new PairingFailed({ url, detail: "the TV returned no client key" })
                  )
            }
            // A "response" frame here means the TV is showing the pairing dialog.
            if (!announced && options.announcePairing !== false) {
              announced = true
              yield* Console.error("→ Accept the pairing request on your TV screen…")
            }
            return yield* awaitKey
          }
        )

        // Pairing needs a human; give them appreciably longer than a command.
        return yield* awaitKey.pipe(
          Effect.timeoutFail({
            duration: Duration.max(session.timeout, Duration.seconds(60)),
            onTimeout: () => new PairingFailed({ url, detail: "timed out waiting for approval" })
          })
        )
      })
    )

    if (Option.getOrUndefined(storedKey) !== clientKey) {
      yield* session.rememberKey(host, clientKey)
    }

    // ---- Magic Remote channel ----------------------------------------------

    const pointer = Effect.gen(function* () {
      const { socketPath } = yield* requestAs(Uri.pointerSocket, PointerSocket)
      const input = yield* openSocket(socketPath, session.timeout)
      const write = (frame: string) => sendText(input, socketPath, frame)
      return {
        button: (name: string) => write(`type:button\nname:${name}\n\n`),
        click: write("type:click\n\n"),
        move: (dx: number, dy: number, drag: boolean) =>
          write(`type:move\ndx:${dx}\ndy:${dy}\ndown:${drag ? 1 : 0}\n\n`),
        scroll: (dx: number, dy: number) => write(`type:scroll\ndx:${dx}\ndy:${dy}\n\n`)
      } satisfies PointerInput
    })

    return { url, host, clientKey, request, requestAs, subscribe, pointer }
  })

/** Connect, run `use`, then close the socket — the shape most commands want. */
export const withTv = <A, E, R>(
  use: (tv: Tv) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | ConnectError, Session | Exclude<R, Scope.Scope>> =>
  Effect.scoped(Effect.flatMap(connect(), use)) as Effect.Effect<
    A,
    E | ConnectError,
    Session | Exclude<R, Scope.Scope>
  >
