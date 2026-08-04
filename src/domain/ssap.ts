import { Option, Schema } from "effect"

/** The `ssap://` endpoints this CLI drives. */
export const Uri = {
  // audio
  getVolume: "ssap://audio/getVolume",
  setVolume: "ssap://audio/setVolume",
  volumeUp: "ssap://audio/volumeUp",
  volumeDown: "ssap://audio/volumeDown",
  setMute: "ssap://audio/setMute",
  getAudioStatus: "ssap://audio/getStatus",

  // power / system
  turnOff: "ssap://system/turnOff",
  createToast: "ssap://system.notifications/createToast",
  softwareInfo: "ssap://com.webos.service.update/getCurrentSWInformation",
  systemInfo: "ssap://system/getSystemInfo",
  powerState: "ssap://com.webos.service.tvpower/power/getPowerState",
  screenOff: "ssap://com.webos.service.tvpower/power/turnOffScreen",
  screenOn: "ssap://com.webos.service.tvpower/power/turnOnScreen",

  // apps
  launch: "ssap://system.launcher/launch",
  closeApp: "ssap://system.launcher/close",
  listApps: "ssap://com.webos.applicationManager/listLaunchPoints",
  foregroundApp: "ssap://com.webos.applicationManager/getForegroundAppInfo",

  // inputs
  listInputs: "ssap://tv/getExternalInputList",
  switchInput: "ssap://tv/switchInput",

  // channels
  channelUp: "ssap://tv/channelUp",
  channelDown: "ssap://tv/channelDown",
  currentChannel: "ssap://tv/getCurrentChannel",
  channelList: "ssap://tv/getChannelList",
  openChannel: "ssap://tv/openChannel",

  // media transport
  play: "ssap://media.controls/play",
  pause: "ssap://media.controls/pause",
  stop: "ssap://media.controls/stop",
  rewind: "ssap://media.controls/rewind",
  fastForward: "ssap://media.controls/fastForward",

  // text entry + remote buttons
  insertText: "ssap://com.webos.service.ime/insertText",
  sendEnterKey: "ssap://com.webos.service.ime/sendEnterKey",
  deleteCharacters: "ssap://com.webos.service.ime/deleteCharacters",
  pointerSocket: "ssap://com.webos.service.networkinput/getPointerInputSocket",

  // network
  // Both are lowercase on the wire; `getStatus` 404s with "no such service or
  // method". The MACs and the link state live on different endpoints.
  connectionInfo: "ssap://com.webos.service.connectionmanager/getinfo",
  connectionStatus: "ssap://com.webos.service.connectionmanager/getstatus"
} as const

/** Frames the TV sends back on the main socket. */
export const IncomingFrame = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown)
})
export type IncomingFrame = typeof IncomingFrame.Type

/** Payloads come back as loose JSON objects; commands narrow with a schema. */
export const AnyPayload = Schema.Record({ key: Schema.String, value: Schema.Unknown })
export type AnyPayload = typeof AnyPayload.Type

export const VolumeStatus = Schema.Struct({
  volume: Schema.optional(Schema.Number),
  muted: Schema.optional(Schema.Boolean),
  volumeStatus: Schema.optional(
    Schema.Struct({
      volume: Schema.optional(Schema.Number),
      muteStatus: Schema.optional(Schema.Boolean),
      volumeLimitable: Schema.optional(Schema.Boolean),
      maxVolume: Schema.optional(Schema.Number),
      soundOutput: Schema.optional(Schema.String)
    })
  )
})
export type VolumeStatus = typeof VolumeStatus.Type

/** `audio/getStatus`: everything `getVolume` returns, plus a flat `mute`. */
export const AudioStatus = Schema.Struct({
  ...VolumeStatus.fields,
  mute: Schema.optional(Schema.Boolean)
})
export type AudioStatus = typeof AudioStatus.Type

export const LaunchPoint = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  appId: Schema.optional(Schema.String),
  systemApp: Schema.optional(Schema.Boolean)
})
export const LaunchPoints = Schema.Struct({
  launchPoints: Schema.Array(LaunchPoint)
})
export type LaunchPoint = typeof LaunchPoint.Type

export const ForegroundApp = Schema.Struct({
  appId: Schema.optional(Schema.String),
  windowId: Schema.optional(Schema.String),
  processId: Schema.optional(Schema.String)
})
export type ForegroundApp = typeof ForegroundApp.Type

export const ExternalInput = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  appId: Schema.optional(Schema.String),
  connected: Schema.optional(Schema.Boolean),
  icon: Schema.optional(Schema.String)
})
export const ExternalInputList = Schema.Struct({
  devices: Schema.Array(ExternalInput)
})
export type ExternalInput = typeof ExternalInput.Type

export const Channel = Schema.Struct({
  channelId: Schema.optional(Schema.String),
  channelNumber: Schema.optional(Schema.String),
  channelName: Schema.optional(Schema.String),
  channelTypeName: Schema.optional(Schema.String)
})
export const ChannelList = Schema.Struct({
  channelList: Schema.Array(Channel)
})
export type Channel = typeof Channel.Type

export const SoftwareInfo = Schema.Struct({
  product_name: Schema.optional(Schema.String),
  model_name: Schema.optional(Schema.String),
  major_ver: Schema.optional(Schema.String),
  minor_ver: Schema.optional(Schema.String),
  device_id: Schema.optional(Schema.String)
})
export type SoftwareInfo = typeof SoftwareInfo.Type

/** `system/getSystemInfo` — accepted, but the value never changes on a given TV. */
export const SystemInfo = Schema.Struct({
  modelName: Schema.optional(Schema.String),
  serialNumber: Schema.optional(Schema.String),
  receiverType: Schema.optional(Schema.String),
  features: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  programMode: Schema.optional(Schema.Boolean)
})
export type SystemInfo = typeof SystemInfo.Type

export const PowerState = Schema.Struct({
  state: Schema.optional(Schema.String),
  processing: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String)
})

export const PointerSocket = Schema.Struct({
  socketPath: Schema.String
})

/** `getinfo`: a MAC per interface, listed whether or not the interface is up. */
export const ConnectionInfo = Schema.Struct({
  wiredInfo: Schema.optional(Schema.Struct({ macAddress: Schema.optional(Schema.String) })),
  wifiInfo: Schema.optional(Schema.Struct({ macAddress: Schema.optional(Schema.String) }))
})
export type ConnectionInfo = typeof ConnectionInfo.Type

/** `getstatus`: link state per interface, and no MACs at all. */
export const ConnectionStatus = Schema.Struct({
  wired: Schema.optional(Schema.Struct({ state: Schema.optional(Schema.String) })),
  wifi: Schema.optional(
    Schema.Struct({
      state: Schema.optional(Schema.String),
      isWakeOnWifiEnabled: Schema.optional(Schema.Boolean)
    })
  )
})
export type ConnectionStatus = typeof ConnectionStatus.Type

/**
 * The MAC worth remembering for Wake-on-LAN: the one belonging to the
 * interface the TV says is connected.
 *
 * Needs both payloads because neither is enough on its own — `getinfo` lists
 * every interface regardless of link, so "prefer wired" quietly picks the dead
 * NIC on a TV that is on Wi-Fi. When the state is unknown we still return
 * something, since a wrong MAC is no worse than none and `lgtv config set-mac`
 * can correct it.
 */
export const macForActiveInterface = (
  info: ConnectionInfo,
  status?: ConnectionStatus
): Option.Option<string> => {
  const wired = info.wiredInfo?.macAddress
  const wifi = info.wifiInfo?.macAddress
  if (status?.wired?.state === "connected" && wired !== undefined) return Option.some(wired)
  if (status?.wifi?.state === "connected" && wifi !== undefined) return Option.some(wifi)
  return Option.fromNullable(wired ?? wifi)
}
