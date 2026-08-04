import { WebSocketServer, type WebSocket } from "ws"

/**
 * A stand-in for a webOS TV: enough of the SSAP protocol to exercise the
 * handshake, request/response, error frames, subscriptions and the Magic
 * Remote input socket without touching real hardware.
 *
 * It is deliberately *adversarial* as well as cooperative — it can refuse to
 * pair, hand back a registration with no key, answer out of order, go silent,
 * drop the connection mid-request and push junk down a subscription. Those are
 * the paths a client gets wrong, so they have to be reachable from a test.
 */

/** How the TV answers a `register` frame from a client it does not know. */
export type PairingBehaviour =
  /** The realistic default: show the prompt, then grant a key. */
  | "prompt-then-grant"
  /** Grant without a prompt, as if the key were already trusted. */
  | "grant-immediately"
  /** The user pressed "no", or LG Connect Apps is off. */
  | "reject"
  /** A `registered` frame with the key missing — seen on some firmware. */
  | "grant-without-key"
  /** Never answer the handshake at all. */
  | "never-answer"

export interface FakeTvOptions {
  readonly promptDelayMs?: number
  readonly pairing?: PairingBehaviour
}

export interface FakeTv {
  readonly host: string
  readonly port: number
  /** Text frames received on the pointer input socket. */
  readonly pointerFrames: ReadonlyArray<string>
  /** Payloads of every `request` frame, keyed by uri, in arrival order. */
  readonly requests: ReadonlyArray<{ uri: string; payload: Record<string, unknown> | undefined }>
  /** Every frame received on the main socket, exactly as it arrived on the wire. */
  readonly rawFrames: ReadonlyArray<string>
  /** The payload of every `register` frame, for asserting the pairing manifest. */
  readonly registerPayloads: ReadonlyArray<Record<string, unknown>>
  /** Client keys the TV considers already paired. */
  readonly knownKeys: Set<string>
  /** How many times the TV has put the pairing prompt on screen. */
  readonly promptCount: () => number
  readonly openConnections: () => number
  readonly openPointerConnections: () => number
  readonly subscriptionCount: () => number

  // ---- adversarial controls ------------------------------------------------
  readonly setPairing: (behaviour: PairingBehaviour) => void
  /** Accept requests for `uri` but never answer them. */
  readonly silence: (uri: string) => void
  /** Answer `uri` late, so replies can arrive out of the order they were sent. */
  readonly delayReply: (uri: string, ms: number) => void
  /** Terminate every open connection without a close handshake. */
  readonly dropConnections: () => void

  // ---- unsolicited traffic -------------------------------------------------
  readonly pushVolume: (volume: number) => void
  /** A frame that is not JSON at all. */
  readonly pushGarbage: () => void
  /** Valid JSON that does not decode as a frame. */
  readonly pushWrongShape: () => void
  /** A well-formed frame carrying no id. */
  readonly pushWithoutId: () => void
  /** A well-formed frame addressed to a request nobody is waiting on. */
  readonly pushUnknownId: () => void

  readonly close: () => Promise<void>
}

const send = (socket: WebSocket, frame: Record<string, unknown>) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
}

export const startFakeTv = async (options: FakeTvOptions = {}): Promise<FakeTv> => {
  const pointerFrames: Array<string> = []
  const requests: Array<{ uri: string; payload: Record<string, unknown> | undefined }> = []
  const rawFrames: Array<string> = []
  const registerPayloads: Array<Record<string, unknown>> = []
  const knownKeys = new Set<string>()
  const subscriptions: Array<{ uri: string; id: string; socket: WebSocket }> = []
  const silenced = new Set<string>()
  const delays = new Map<string, number>()
  const timers = new Set<NodeJS.Timeout>()

  let pairing: PairingBehaviour = options.pairing ?? "prompt-then-grant"
  let prompts = 0
  let volume = 12
  let muted = false

  /** Every deferred reply goes through here so `close` can cancel it. */
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
  }

  const pointerServer = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  pointerServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      pointerFrames.push(String(raw))
    })
  })
  await new Promise<void>((resolve) => pointerServer.on("listening", resolve))
  const pointerPort = (pointerServer.address() as { port: number }).port

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const text = String(raw)
      rawFrames.push(text)
      const frame = JSON.parse(text) as {
        id: string
        type: string
        uri?: string
        payload?: Record<string, unknown>
      }

      if (frame.type === "register") {
        registerPayloads.push(frame.payload ?? {})
        const offered = frame.payload?.["client-key"]
        const alreadyPaired = typeof offered === "string" && knownKeys.has(offered)

        const grant = () => {
          const key = alreadyPaired
            ? (offered as string)
            : `key-${Math.random().toString(16).slice(2)}`
          knownKeys.add(key)
          send(socket, { type: "registered", id: frame.id, payload: { "client-key": key } })
        }

        if (alreadyPaired) {
          grant()
          return
        }

        switch (pairing) {
          case "grant-immediately":
            grant()
            return
          case "reject":
            send(socket, { type: "error", id: frame.id, error: "403 user denied the request" })
            return
          case "grant-without-key":
            send(socket, { type: "registered", id: frame.id, payload: {} })
            return
          case "never-answer":
            return
          case "prompt-then-grant":
            prompts += 1
            // Unpaired clients see the on-screen prompt first.
            send(socket, {
              type: "response",
              id: frame.id,
              payload: { pairingType: "PROMPT", returnValue: true }
            })
            later(options.promptDelayMs ?? 20, grant)
            return
        }
      }

      const uri = frame.uri ?? ""

      if (frame.type === "subscribe") {
        subscriptions.push({ uri, id: frame.id, socket })
        send(socket, {
          type: "response",
          id: frame.id,
          payload: { returnValue: true, subscribed: true, volume, muted }
        })
        return
      }

      requests.push({ uri, payload: frame.payload })

      if (silenced.has(uri)) return

      const answer = (payload: Record<string, unknown>) =>
        send(socket, { type: "response", id: frame.id, payload })
      const reply = (payload: Record<string, unknown>) => answer({ returnValue: true, ...payload })

      const respond = () => {
        switch (uri) {
          case "ssap://audio/getVolume":
            reply({
              volume,
              muted,
              volumeStatus: { volume, muteStatus: muted, soundOutput: "tv_speaker" }
            })
            return
          case "ssap://audio/setVolume":
            volume = Number(frame.payload?.["volume"] ?? volume)
            reply({})
            return
          case "ssap://audio/volumeUp":
            volume += 1
            reply({})
            return
          case "ssap://audio/setMute":
            muted = Boolean(frame.payload?.["mute"])
            reply({})
            return
          case "ssap://com.webos.applicationManager/listLaunchPoints":
            reply({
              launchPoints: [
                { id: "netflix", title: "Netflix" },
                { id: "com.webos.app.hdmi1", title: "HDMI 1", systemApp: true }
              ]
            })
            return
          case "ssap://system.launcher/launch":
            // The real TV answers a launch with a session id alongside returnValue.
            reply({ sessionId: "com.webos.applicationManager.sessionId.1" })
            return
          case "ssap://com.webos.service.networkinput/getPointerInputSocket":
            reply({ socketPath: `ws://127.0.0.1:${pointerPort}/pointer` })
            return
          case "ssap://com.webos.service.update/getCurrentSWInformation":
            reply({
              product_name: "webOSTV FAKE",
              model_name: "FAKE_TV_MODEL",
              major_ver: "1",
              minor_ver: "0",
              device_id: "aa:bb:cc:dd:ee:ff"
            })
            return
          case "ssap://system/turnOff":
            reply({})
            return
          case "ssap://tv/openChannel":
            // A refusal that arrives as returnValue:false rather than an error frame.
            answer({ returnValue: false, errorText: "Invalid channel" })
            return
          default:
            send(socket, { type: "error", id: frame.id, error: "404 no such service or method" })
        }
      }

      const delay = delays.get(uri)
      if (delay === undefined) respond()
      else later(delay, respond)
    })
  })

  await new Promise<void>((resolve) => server.on("listening", resolve))
  const port = (server.address() as { port: number }).port

  /** Pushes a frame to every socket holding a subscription. */
  const pushRaw = (make: (subscription: { uri: string; id: string }) => string) => {
    for (const subscription of subscriptions) {
      if (subscription.socket.readyState === subscription.socket.OPEN) {
        subscription.socket.send(make(subscription))
      }
    }
  }

  return {
    host: "127.0.0.1",
    port,
    get pointerFrames() {
      return pointerFrames
    },
    get requests() {
      return requests
    },
    get rawFrames() {
      return rawFrames
    },
    get registerPayloads() {
      return registerPayloads
    },
    knownKeys,
    promptCount: () => prompts,
    openConnections: () => server.clients.size,
    openPointerConnections: () => pointerServer.clients.size,
    subscriptionCount: () => subscriptions.length,

    setPairing: (behaviour: PairingBehaviour) => {
      pairing = behaviour
    },
    silence: (uri: string) => {
      silenced.add(uri)
    },
    delayReply: (uri: string, ms: number) => {
      delays.set(uri, ms)
    },
    dropConnections: () => {
      for (const client of server.clients) client.terminate()
    },

    pushVolume: (next: number) => {
      volume = next
      for (const subscription of subscriptions) {
        if (subscription.uri !== "ssap://audio/getVolume") continue
        send(subscription.socket, {
          type: "response",
          id: subscription.id,
          payload: { returnValue: true, changed: ["volume"], volume: next, muted }
        })
      }
    },
    pushGarbage: () => pushRaw(() => "<html>not json</html>"),
    // `type` must be a string to decode as a frame; a number is valid JSON and
    // addressed to a real waiter, so only the decode step can reject it.
    pushWrongShape: () => pushRaw(({ id }) => JSON.stringify({ type: 42, id, payload: {} })),
    pushWithoutId: () =>
      pushRaw(() => JSON.stringify({ type: "response", payload: { volume: -1 } })),
    pushUnknownId: () =>
      pushRaw(() =>
        JSON.stringify({ type: "response", id: "lgtv-9999", payload: { volume: -1 } })
      ),

    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const client of server.clients) client.terminate()
      for (const client of pointerServer.clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => pointerServer.close(() => resolve()))
    }
  }
}
