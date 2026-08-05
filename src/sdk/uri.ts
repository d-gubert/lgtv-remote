/** The `ssap://` endpoints this SDK has been used against, verified on hardware. */
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
