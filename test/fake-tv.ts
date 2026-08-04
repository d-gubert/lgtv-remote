import { WebSocketServer, type WebSocket } from "ws"

/**
 * A stand-in for a webOS TV: enough of the SSAP protocol to exercise the
 * handshake, request/response, error frames, subscriptions and the Magic
 * Remote input socket without touching real hardware.
 */
export interface FakeTv {
  readonly host: string
  readonly port: number
  /** Text frames received on the pointer input socket. */
  readonly pointerFrames: ReadonlyArray<string>
  /** Payloads of every `request` frame, keyed by uri, in arrival order. */
  readonly requests: ReadonlyArray<{ uri: string; payload: Record<string, unknown> | undefined }>
  /** Client keys the TV considers already paired. */
  readonly knownKeys: Set<string>
  readonly pushVolume: (volume: number) => void
  /** Sends a frame that is not JSON at all, to prove the client drops it. */
  readonly pushGarbage: () => void
  readonly close: () => Promise<void>
}

const send = (socket: WebSocket, frame: Record<string, unknown>) => {
  socket.send(JSON.stringify(frame))
}

export const startFakeTv = async (
  options: { readonly promptDelayMs?: number } = {}
): Promise<FakeTv> => {
  const pointerFrames: Array<string> = []
  const requests: Array<{ uri: string; payload: Record<string, unknown> | undefined }> = []
  const knownKeys = new Set<string>()
  const subscribers = new Map<string, WebSocket>()

  const pointerServer = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  pointerServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      pointerFrames.push(String(raw))
    })
  })
  await new Promise<void>((resolve) => pointerServer.on("listening", resolve))
  const pointerPort = (pointerServer.address() as { port: number }).port

  let volume = 12
  let muted = false

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as {
        id: string
        type: string
        uri?: string
        payload?: Record<string, unknown>
      }

      if (frame.type === "register") {
        const offered = frame.payload?.["client-key"]
        const alreadyPaired = typeof offered === "string" && knownKeys.has(offered)
        const grant = () => {
          const key = alreadyPaired ? (offered as string) : `key-${Math.random().toString(16).slice(2)}`
          knownKeys.add(key)
          send(socket, { type: "registered", id: frame.id, payload: { "client-key": key } })
        }
        if (alreadyPaired) {
          grant()
        } else {
          // Unpaired clients see the on-screen prompt first.
          send(socket, {
            type: "response",
            id: frame.id,
            payload: { pairingType: "PROMPT", returnValue: true }
          })
          setTimeout(grant, options.promptDelayMs ?? 20)
        }
        return
      }

      const uri = frame.uri ?? ""

      if (frame.type === "subscribe") {
        subscribers.set(uri, socket)
        send(socket, {
          type: "response",
          id: frame.id,
          payload: { returnValue: true, subscribed: true, volume, muted }
        })
        // Remember the id so pushes reuse it.
        subscriptionIds.set(uri, frame.id)
        return
      }

      requests.push({ uri, payload: frame.payload })

      const reply = (payload: Record<string, unknown>) =>
        send(socket, { type: "response", id: frame.id, payload: { returnValue: true, ...payload } })

      switch (uri) {
        case "ssap://audio/getVolume":
          reply({ volume, muted, volumeStatus: { volume, muteStatus: muted, soundOutput: "tv_speaker" } })
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
        case "ssap://com.webos.service.networkinput/getPointerInputSocket":
          reply({ socketPath: `ws://127.0.0.1:${pointerPort}/pointer` })
          return
        case "ssap://system/turnOff":
          reply({})
          return
        case "ssap://tv/openChannel":
          // A refusal that arrives as returnValue:false rather than an error frame.
          send(socket, {
            type: "response",
            id: frame.id,
            payload: { returnValue: false, errorText: "Invalid channel" }
          })
          return
        default:
          send(socket, { type: "error", id: frame.id, error: "404 no such service or method" })
      }
    })
  })

  const subscriptionIds = new Map<string, string>()

  await new Promise<void>((resolve) => server.on("listening", resolve))
  const port = (server.address() as { port: number }).port

  return {
    host: "127.0.0.1",
    port,
    get pointerFrames() {
      return pointerFrames
    },
    get requests() {
      return requests
    },
    knownKeys,
    pushVolume: (next: number) => {
      volume = next
      const socket = subscribers.get("ssap://audio/getVolume")
      const id = subscriptionIds.get("ssap://audio/getVolume")
      if (socket !== undefined && id !== undefined) {
        send(socket, {
          type: "response",
          id,
          payload: { returnValue: true, changed: ["volume"], volume: next, muted }
        })
      }
    },
    pushGarbage: () => {
      for (const socket of subscribers.values()) {
        socket.send("<html>not json</html>")
      }
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => pointerServer.close(() => resolve()))
    }
  }
}
