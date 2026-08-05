import { array, boolean, number, optional, record, string, struct, unknown, type Infer } from "./decode.js"

/**
 * The reply shapes this SDK knows how to narrow, one per endpoint worth
 * decoding. Each is a value and a type of the same name, so `requestAs` reads
 * the same as the type it hands back:
 *
 *     const status = await tv.requestAs(Uri.getVolume, VolumeStatus)
 *
 * Almost every field is optional because almost every field really is: webOS
 * omits what a given model has no answer for, and the fields that are required
 * here are the ones a caller cannot do anything without.
 */

const volumeFields = {
  volume: optional(number),
  muted: optional(boolean),
  volumeStatus: optional(
    struct({
      volume: optional(number),
      muteStatus: optional(boolean),
      volumeLimitable: optional(boolean),
      maxVolume: optional(number),
      soundOutput: optional(string)
    })
  )
}

export const VolumeStatus = struct(volumeFields)
export type VolumeStatus = Infer<typeof VolumeStatus>

/** `audio/getStatus`: everything `getVolume` returns, plus a flat `mute`. */
export const AudioStatus = struct({ ...volumeFields, mute: optional(boolean) })
export type AudioStatus = Infer<typeof AudioStatus>

export const LaunchPoint = struct({
  id: string,
  title: optional(string),
  appId: optional(string),
  systemApp: optional(boolean)
})
export type LaunchPoint = Infer<typeof LaunchPoint>

export const LaunchPoints = struct({ launchPoints: array(LaunchPoint) })
export type LaunchPoints = Infer<typeof LaunchPoints>

export const ForegroundApp = struct({
  appId: optional(string),
  windowId: optional(string),
  processId: optional(string)
})
export type ForegroundApp = Infer<typeof ForegroundApp>

export const ExternalInput = struct({
  id: string,
  label: optional(string),
  appId: optional(string),
  connected: optional(boolean),
  icon: optional(string)
})
export type ExternalInput = Infer<typeof ExternalInput>

export const ExternalInputList = struct({ devices: array(ExternalInput) })
export type ExternalInputList = Infer<typeof ExternalInputList>

export const Channel = struct({
  channelId: optional(string),
  channelNumber: optional(string),
  channelName: optional(string),
  channelTypeName: optional(string)
})
export type Channel = Infer<typeof Channel>

export const ChannelList = struct({ channelList: array(Channel) })
export type ChannelList = Infer<typeof ChannelList>

export const SoftwareInfo = struct({
  product_name: optional(string),
  model_name: optional(string),
  major_ver: optional(string),
  minor_ver: optional(string),
  device_id: optional(string)
})
export type SoftwareInfo = Infer<typeof SoftwareInfo>

/** `system/getSystemInfo` — accepted, but the value never changes on a given TV. */
export const SystemInfo = struct({
  modelName: optional(string),
  serialNumber: optional(string),
  receiverType: optional(string),
  features: optional(record(unknown)),
  programMode: optional(boolean)
})
export type SystemInfo = Infer<typeof SystemInfo>

export const PowerState = struct({
  state: optional(string),
  processing: optional(string),
  reason: optional(string)
})
export type PowerState = Infer<typeof PowerState>

export const PointerSocket = struct({ socketPath: string })
export type PointerSocket = Infer<typeof PointerSocket>

/** `getinfo`: a MAC per interface, listed whether or not the interface is up. */
export const ConnectionInfo = struct({
  wiredInfo: optional(struct({ macAddress: optional(string) })),
  wifiInfo: optional(struct({ macAddress: optional(string) }))
})
export type ConnectionInfo = Infer<typeof ConnectionInfo>

/** `getstatus`: link state per interface, and no MACs at all. */
export const ConnectionStatus = struct({
  wired: optional(struct({ state: optional(string) })),
  wifi: optional(
    struct({
      state: optional(string),
      isWakeOnWifiEnabled: optional(boolean)
    })
  )
})
export type ConnectionStatus = Infer<typeof ConnectionStatus>

/**
 * The MAC worth remembering for Wake-on-LAN: the one belonging to the
 * interface the TV says is connected.
 *
 * Needs both payloads because neither is enough on its own — `getinfo` lists
 * every interface regardless of link, so "prefer wired" quietly picks the dead
 * NIC on a TV that is on Wi-Fi. When the state is unknown we still return
 * something, since a wrong MAC is no worse than none.
 */
export const macForActiveInterface = (
  info: ConnectionInfo,
  status?: ConnectionStatus
): string | undefined => {
  const wired = info.wiredInfo?.macAddress
  const wifi = info.wifiInfo?.macAddress
  if (status?.wired?.state === "connected" && wired !== undefined) return wired
  if (status?.wifi?.state === "connected" && wifi !== undefined) return wifi
  return wired ?? wifi
}
