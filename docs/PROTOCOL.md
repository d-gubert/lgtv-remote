# SSAP — the LG webOS TV protocol

A wire-level reference for **SSAP** (Simple Service Access Protocol), the JSON-over-WebSocket
protocol that the official LG remote app — and this CLI — use to drive a webOS television.

This document covers the framing, the pairing handshake, every `ssap://` method known to work,
the separate Magic Remote pointer channel, and the two side protocols (SSDP, Wake-on-LAN) that
sit either side of it. Implementation notes for *this* codebase live in
[`ARCHITECTURE.md`](./ARCHITECTURE.md); usage lives in [`../README.md`](../README.md).

## How this reference was produced

Endpoints marked `live` were issued against a real television and the replies captured verbatim:

| | |
| --- | --- |
| Model | LG 55UR8750PSA (`HE_DTV_W23P_AFADATAA`) |
| Platform | webOS TV 23, platform `10.3.1` |
| Firmware | `33.31.61` |
| Broadcast system | ATSC, no tuner signal connected |
| Transport | `wss://…:3001` |
| Date | 2026-08-03 |

Sample payloads below are real responses with serial numbers, MAC addresses, tokens, SSIDs and
IP addresses replaced by placeholders. Everything else is unedited.

**Status markers** used throughout:

| Marker | Meaning |
| --- | --- |
| `live` | Issued against the reference TV; the response shape shown was observed. |
| `live*` | Existence confirmed live by sending deliberately invalid arguments; the success shape is taken from the CLI's schemas, not observed. |
| `cli` | Implemented by this CLI and exercised against `test/fake-tv.ts`, but **not** issued live because it is destructive or disruptive (power off, screen blanking). |
| `404` | The reference TV answered `404 no such service or method`. Listed because other clients document it — expect it to be absent on webOS 23. |

A `404` here is a statement about *this model*. The SSAP surface differs across webOS versions
and regions, so probe before concluding an endpoint is missing — see
[Probing an unknown endpoint](#10-probing-an-unknown-endpoint).

---

## 1. Transport

| | Plain | Secure |
| --- | --- | --- |
| URL | `ws://<host>:3000` | `wss://<host>:3001` |
| Certificate | — | Self-signed; clients must not verify it |

Some 2023-and-newer models accept **only** the secure port. The certificate is self-signed and
issued to an internal LG hostname, so `rejectUnauthorized: false` (or the equivalent) is
mandatory — `src/services/Tv.ts:32`.

Everything travels as **WebSocket text frames containing one JSON object each**. There is no
binary framing, no compression, and no length prefix. A single connection carries every request,
response and subscription, multiplexed by an `id` field the client chooses.

Two consequences worth internalising:

- **Pairing is per-transport.** A client key granted over `wss://` is not honoured on the plain
  port. Whichever transport you pair over must be reused, which is why this CLI stores `ssl`
  alongside the key (`src/services/Session.ts:100`).
- **Unroutable frames must be dropped, not raised.** A frame with no `id`, an `id` you never
  issued, or a body that is not JSON at all has no caller to fail; treating it as an error turns
  stray traffic into a crash.

---

## 2. Frame types

Seven frame types exist. `type` is always present, and `id` on everything the TV can route.

### Client → TV

| `type` | Fields | Purpose |
| --- | --- | --- |
| `register` | `id`, `payload` (manifest + optional `client-key`) | Open the session. Must be the first frame. |
| `request` | `id`, `uri`, `payload?` | Call a method once. |
| `subscribe` | `id`, `uri`, `payload?` | Call a method **and** keep receiving updates on the same `id`. |
| `unsubscribe` | `id` | Stop a subscription. Not verified here — this CLI ends subscriptions by closing the socket. |

### TV → Client

| `type` | Fields | Purpose |
| --- | --- | --- |
| `registered` | `id`, `payload.client-key` | Pairing granted. |
| `response` | `id`, `payload` | Result of a request, the first value of a subscription, **or** a subscription push. |
| `error` | `id`, `error`, `payload?` | Refusal. `error` is a string like `404 no such service or method`. |

A subscription push is indistinguishable from a normal response except that it reuses an id you
already received an answer for. Demultiplexing therefore has to be *by id into a mailbox*, not
request/reply pairing — `startPump` in `src/services/Tv.ts:64`.

### Request frame

```json
{ "id": "lgtv-1", "type": "request", "uri": "ssap://audio/setVolume", "payload": { "volume": 20 } }
```

`id` is client-chosen and opaque to the TV; it is echoed back untouched. This CLI uses
`register_0` for the handshake and `lgtv-N` from a per-connection counter for everything else
(`src/services/Tv.ts:212`). Omit `payload` entirely for methods that take no arguments — sending
`"payload": {}` is also accepted.

### Success

```json
{ "type": "response", "id": "lgtv-1", "payload": { "returnValue": true } }
```

`payload.returnValue` is `true` on success for nearly every endpoint. A handful omit it
(`audio/getSoundOutput` when subscribed, `tv/getExternalInputList` when subscribed), so treat a
*missing* `returnValue` as success and only an explicit `false` as failure.

---

## 3. Failure shapes

There are **two distinct ways a call fails**, and a client that handles only the first will
report failed commands as successes.

### 3.1 Error frames

```json
{ "type": "error", "id": "lgtv-4", "error": "404 no such service or method", "payload": {} }
```

Observed `error` strings on the reference TV:

| String | Meaning |
| --- | --- |
| `404 no such service or method` | The URI does not exist on this model. The single most common answer when porting code between webOS versions. |
| `403 access denied` | The method exists but this client may not call it — either the manifest lacks the permission, or the target is not owned by this session. |
| `500 Application error` | The method ran and failed. **The `payload` carries the reason** — see below. |
| `2 invalid parameters` | Required parameters missing or the wrong type, rejected before dispatch. |
| `1 Could not validate json message against schema` | The payload failed the method's JSON schema, e.g. `{"volume": "not-a-number"}`. |

`500 Application error` frames carry a populated payload, unlike the others:

```json
{
  "type": "error",
  "id": "lgtv-9",
  "error": "500 Application error",
  "payload": {
    "returnValue": false,
    "errorCode": -1000,
    "errorText": "missing \"message\" parameter"
  }
}
```

`errorText` is by far the most useful field when reverse-engineering an endpoint's parameters —
most of the parameter documentation in section 6 was recovered by calling methods with wrong
arguments and reading it.

### 3.2 Successful responses that are refusals

```json
{
  "type": "response",
  "id": "lgtv-7",
  "payload": { "returnValue": false, "errorText": "Invalid channel" }
}
```

The frame `type` is `response`, not `error`. Only `returnValue: false` marks it as a failure.
This CLI collapses both shapes into one `SsapFailed` error at `src/services/Tv.ts:137-155`.

Some endpoints nest a third layer, where the outer call succeeded but the service it proxied to
did not:

```json
{
  "returnValue": false,
  "errorCode": -1000,
  "errorText": "com.webos.service.utp/bind returns invalid result(response error)",
  "response": {
    "errorCode": -101,
    "returnValue": false,
    "errorText": "There is no active broadcast to bind",
    "subscribed": false
  }
}
```

That is every `ssap://tv/*` channel method on a TV with no tuner signal. The inner `response`
object holds the real reason.

---

## 4. The pairing handshake

### 4.1 Sequence

The first frame on any connection must be a `register`. Nothing else is answered until pairing
completes.

```mermaid
sequenceDiagram
  participant C as Client
  participant TV as webOS TV
  C->>TV: {id:"register_0", type:"register", payload:{…manifest, "client-key"?}}
  alt stored key still valid
    TV-->>C: {type:"registered", payload:{"client-key":"…"}}
  else no key, or key revoked
    TV-->>C: {type:"response", payload:{pairingType:"PROMPT", returnValue:true}}
    Note over TV: dialog appears on screen; user has ~60s
    TV-->>C: {type:"registered", payload:{"client-key":"…"}}
  end
```

The register payload is the pairing manifest (section 4.2) with the stored key added as a
top-level `client-key` when you have one:

```json
{
  "id": "register_0",
  "type": "register",
  "payload": {
    "forcePairing": false,
    "pairingType": "PROMPT",
    "client-key": "a1b2c3…",
    "manifest": { "…": "…" }
  }
}
```

Rules that matter:

- **A `response` frame during the handshake means the dialog is on screen.** It is not an error
  and not a result; keep reading from the same id until `registered` arrives.
- **The granted key may differ from the one you sent.** Always persist the key from the
  `registered` payload rather than assuming yours was accepted.
- **`registered` can arrive with no key.** Treat that as a pairing failure.
- **Allow ~60 seconds**, not a normal command timeout — a human has to walk to the TV. This CLI
  uses `max(--timeout, 60s)` for the handshake only (`src/services/Tv.ts:315`).
- `pairingType` may also be `PIN`, in which case the TV shows a number and expects
  `ssap://pairing/setPin`. The reference TV never used it and this CLI does not implement it.

### 4.2 The manifest

`src/domain/pairing.ts` holds the manifest every third-party LG remote sends. It identifies the
client as LG's own test app (`com.lge.test`, "LG Remote App") and carries an RSA-SHA256 signature
block that the TV verifies.

> **The manifest must go over the wire byte-for-byte.** Do not reformat it, trim the permission
> lists, or "clean up" the localized names — any change invalidates the signature and the TV
> refuses the handshake.

The manifest declares two permission arrays. They are what the client is *asking* for; the TV
grants them wholesale when the user accepts the prompt.

<details>
<summary><code>manifest.signed.permissions</code> — 16 entries</summary>

`TEST_SECURE`, `CONTROL_INPUT_TEXT`, `CONTROL_MOUSE_AND_KEYBOARD`, `READ_INSTALLED_APPS`,
`READ_LGE_SDX`, `READ_NOTIFICATIONS`, `SEARCH`, `WRITE_SETTINGS`, `WRITE_NOTIFICATION_ALERT`,
`CONTROL_POWER`, `READ_CURRENT_CHANNEL`, `READ_RUNNING_APPS`, `READ_UPDATE_INFO`,
`UPDATE_FROM_REMOTE_APP`, `READ_LGE_TV_INPUT_EVENTS`, `READ_TV_CURRENT_TIME`
</details>

<details>
<summary><code>manifest.permissions</code> — 50 entries</summary>

`LAUNCH`, `LAUNCH_WEBAPP`, `APP_TO_APP`, `CLOSE`, `TEST_OPEN`, `TEST_PROTECTED`, `CONTROL_AUDIO`,
`CONTROL_DISPLAY`, `CONTROL_INPUT_JOYSTICK`, `CONTROL_INPUT_MEDIA_RECORDING`,
`CONTROL_INPUT_MEDIA_PLAYBACK`, `CONTROL_INPUT_TV`, `CONTROL_POWER`, `READ_APP_STATUS`,
`READ_CURRENT_CHANNEL`, `READ_INPUT_DEVICE_LIST`, `READ_NETWORK_STATE`, `READ_RUNNING_APPS`,
`READ_TV_CHANNEL_LIST`, `WRITE_NOTIFICATION_TOAST`, `READ_POWER_STATE`, `READ_COUNTRY_INFO`,
`READ_SETTINGS`, `CONTROL_TV_SCREEN`, `CONTROL_TV_STANBY`, `CONTROL_FAVORITE_GROUP`,
`CONTROL_USER_INFO`, `CHECK_BLUETOOTH_DEVICE`, `CONTROL_BLUETOOTH`, `CONTROL_TIMER_INFO`,
`STB_INTERNAL_CONNECTION`, `CONTROL_RECORDING`, `READ_RECORDING_STATE`, `WRITE_RECORDING_LIST`,
`READ_RECORDING_LIST`, `READ_RECORDING_SCHEDULE`, `WRITE_RECORDING_SCHEDULE`,
`READ_STORAGE_DEVICE_LIST`, `READ_TV_PROGRAM_INFO`, `CONTROL_BOX_CHANNEL`,
`READ_TV_ACR_AUTH_TOKEN`, `READ_TV_CONTENT_STATE`, `READ_TV_CURRENT_TIME`, `ADD_LAUNCHER_CHANNEL`,
`SET_CHANNEL_SKIP`, `RELEASE_CHANNEL_SKIP`, `CONTROL_CHANNEL_BLOCK`, `DELETE_SELECT_CHANNEL`,
`CONTROL_CHANNEL_GROUP`, `SCAN_TV_CHANNELS`, `CONTROL_TV_POWER`, `CONTROL_WOL`
</details>

Note `CONTROL_TV_STANBY` — LG's typo, not one to correct.

### 4.3 Client key lifecycle

The key is a bearer credential: anyone holding it can control the TV without a prompt, from any
address. Store it with restrictive permissions — this CLI writes `~/.config/lgtv-remote/config.yaml`
with mode `0600`.

Keys are revoked when the user resets the TV, clears paired devices, or (on some models) after a
factory-level firmware update. A revoked key produces the `PROMPT` path again rather than an
error, so re-pairing is transparent if you persist whatever `registered` returns.

---

## 5. Subscriptions

Send `type: "subscribe"` instead of `"request"`. The TV replies immediately with the current
value, then sends further `response` frames **reusing the same `id`** whenever the value changes.

```
→ {"id":"lgtv-2","type":"subscribe","uri":"ssap://audio/getVolume"}
← {"id":"lgtv-2","type":"response","payload":{"returnValue":true,"volumeStatus":{"volume":11,…}}}
   … user presses volume-up on the physical remote …
← {"id":"lgtv-2","type":"response","payload":{"returnValue":true,"volumeStatus":{"volume":12,"cause":"setVolume",…}}}
```

Pushes often add a **`cause`** field naming what triggered the change (`"setVolume"` was observed),
and `changed: ["volume"]` on some models. Neither is guaranteed.

### Which endpoints accept `subscribe`

Verified live. "Echoes `subscribed`" means the first response contains `subscribed: true`.

| URI | Accepted | Echoes `subscribed` | Notes |
| --- | --- | --- | --- |
| `ssap://audio/getVolume` | yes | **no** | Pushes confirmed live despite the missing flag. |
| `ssap://audio/getStatus` | yes | **no** | Same. |
| `ssap://audio/getSoundOutput` | yes | yes | |
| `ssap://com.webos.applicationManager/getForegroundAppInfo` | yes | yes | The way to follow app changes. |
| `ssap://com.webos.applicationManager/listLaunchPoints` | yes | yes | Fires on install/uninstall. |
| `ssap://com.webos.service.tvpower/power/getPowerState` | yes | yes | The way to detect standby. |
| `ssap://tv/getExternalInputList` | yes | yes | Fires on HDMI hotplug. |
| `ssap://com.webos.service.connectionmanager/getstatus` | yes | yes | |
| `ssap://com.webos.service.update/getStatus` | yes | yes | |
| `ssap://com.webos.service.ime/registerRemoteKeyboard` | yes | yes | **Subscribe-only** — a plain `request` returns `Must subscribe to registerRemoteKeyboard`. |
| `ssap://settings/getSystemSettings` | yes | yes | Payload (`category`, `keys`) required as for a request. |
| `ssap://system/getSystemInfo` | yes | yes | Accepted, but the value never changes. |
| `ssap://tv/getCurrentChannel` | no | — | `500` with no tuner signal; works on a tuned TV. |
| `ssap://tv/getChannelProgramInfo` | no | — | Same. |

> **Do not gate your client on `subscribed: true`.** `audio/getVolume` — the single most-watched
> endpoint — omits it on webOS 23 yet pushes normally. `test/fake-tv.ts` *does* echo it, so this
> is a divergence between the test double and real hardware (section 9).

Unsubscribing is done with `{"id":"…","type":"unsubscribe"}`. Closing the socket also ends every
subscription, which is what this CLI relies on.

---

## 6. Method reference

Every URI is `ssap://<service>/<method>`. Payload keys are exact and case-sensitive.

### 6.0 Service namespaces

`ssap://api/getServiceList` enumerates the short-form services. On the reference TV, all at
version 1 except `webapp` at version 2:

`api`, `audio`, `config`, `externalpq`, `media.controls`, `media.viewer`, `pairing`, `settings`,
`system`, `system.launcher`, `system.notifications`, `timer`, `tv`, `user`, `webapp`, `weeCustom`

**This list is not the whole protocol.** The long-form `com.webos.*` URIs — application manager,
tvpower, IME, connection manager, update, network input — are bridged straight through to Luna
system-bus services and never appear in it. Roughly half of the methods below are invisible to
`getServiceList`.

---

### 6.1 `api` — introspection

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://api/getServiceList` | `live` | — | `services: [{ name, version }]` |

```json
{ "returnValue": true, "services": [ { "name": "api", "version": 1 }, { "name": "audio", "version": 1 } ] }
```

---

### 6.2 `audio` — volume, mute, sound output

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://audio/getVolume` | `live` | — | `volumeStatus` object (below) |
| `ssap://audio/getStatus` | `live` | — | Same as `getVolume`, plus flat `volume` and `mute` |
| `ssap://audio/getMute` | `live` | — | `mute: boolean` |
| `ssap://audio/setVolume` | `live*` | `{ volume: number }` | `returnValue` |
| `ssap://audio/volumeUp` | `cli` | — | `returnValue` |
| `ssap://audio/volumeDown` | `cli` | — | `returnValue` |
| `ssap://audio/setMute` | `live` | `{ mute: boolean }` | `{ muteStatus, soundOutput }` |
| `ssap://audio/getSoundOutput` | `live` | — | `soundOutput: string` |
| `ssap://audio/changeSoundOutput` | `live*` | `{ output: string }` | `returnValue` |
| `ssap://com.webos.service.apiadapter/audio/getSoundOutput` | `live` | — | Alias of `audio/getSoundOutput` |
| `ssap://com.webos.service.apiadapter/audio/changeSoundOutput` | `live*` | `{ output: string }` | Alias of `audio/changeSoundOutput` |

`getVolume` response, in full:

```json
{
  "returnValue": true,
  "volumeStatus": {
    "volume": 11,
    "muteStatus": false,
    "maxVolume": 100,
    "soundOutput": "tv_external_speaker",
    "volumeLimitable": true,
    "volumeLimiter": "none",
    "activeStatus": true,
    "adjustVolume": true,
    "mode": "normal",
    "dedicatedSpeakerConnected": false,
    "externalDeviceControl": false,
    "volumeSyncable": false,
    "ossActivate": false
  },
  "callerId": "secondscreen.client"
}
```

**Portability trap.** Older webOS returns `volume` and `muted` at the *top level*; webOS 23
returns them nested under `volumeStatus` as `volume` and `muteStatus`. `audio/getStatus` returns
both. Read `volume ?? volumeStatus.volume` and `muted ?? volumeStatus.muteStatus` — see
`flatten()` in `src/commands/audio.ts:9`.

`setVolume` takes an integer 0–`maxVolume` (100 on the reference TV). A non-numeric value is
rejected before dispatch with `1 Could not validate json message against schema`.

**`setMute` coerces.** `{"mute": "not-a-boolean"}` was accepted live and muted the TV — the
string is truthy. Do not rely on the TV to validate this parameter; validate before sending.

`changeSoundOutput` values are model-dependent; an unknown one returns
`There is No matched extended item: soundOutput`. Read the current value from `getSoundOutput`
to learn this TV's vocabulary. Commonly seen: `tv_speaker`, `tv_external_speaker`,
`external_optical`, `external_arc`, `external_speaker`, `bt_soundbar`, `lineout`, `headphone`.

---

### 6.3 `system` and power

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://system/getSystemInfo` | `live` | — | `{ modelName, serialNumber, receiverType, features, programMode }` |
| `ssap://system/turnOff` | `cli` | — | `returnValue`. **Puts the TV into standby**; the socket closes immediately after. |
| `ssap://com.webos.service.update/getCurrentSWInformation` | `live` | — | Firmware block (below) |
| `ssap://com.webos.service.update/getStatus` | `live` | — | `{ status, usbImageSize, nsuImageSize, ssuImageSize, platformUpgrade, currentPlatformVersion, nextPlatformVersion }` |
| `ssap://com.webos.service.tvpower/power/getPowerState` | `live` | — | `{ state, processing?, reason? }` |
| `ssap://com.webos.service.tvpower/power/turnOffScreen` | `cli` | — | Blanks the panel, audio continues. |
| `ssap://com.webos.service.tvpower/power/turnOnScreen` | `cli` | — | Restores the panel. |

`getSystemInfo`:

```json
{
  "returnValue": true,
  "modelName": "55UR8750PSA",
  "serialNumber": "<redacted>",
  "receiverType": "ATSC",
  "features": { "dvr": true },
  "programMode": false
}
```

`getCurrentSWInformation` — the richest single identity call:

```json
{
  "returnValue": true,
  "product_name": "webOSTV 23",
  "model_name": "HE_DTV_W23P_AFADATAA",
  "sw_type": "FIRMWARE",
  "major_ver": "33",
  "minor_ver": "31.61",
  "country": "BR2",
  "country_group": "BR",
  "device_id": "aa:bb:cc:11:22:33",
  "auth_flag": "N",
  "ignore_disable": "N",
  "eco_info": "01",
  "config_key": "00",
  "language_code": "en-US"
}
```

Note `model_name` here is the *platform* code (`HE_DTV_W23P_AFADATAA`), while
`system/getSystemInfo` returns the *marketing* model (`55UR8750PSA`). This CLI's `lgtv info`
shows the former.

> **`device_id` is the wired MAC, even on a TV connected by Wi-Fi.** On the reference TV,
> `device_id` matched `wiredInfo.macAddress` while the active interface was `wlan0` with a
> different MAC. Using it for Wake-on-LAN silently targets the dead NIC. Use
> `connectionmanager/getinfo` + `getstatus` instead (section 6.9).

`getPowerState` returned `{"state":"Active","returnValue":true}` on the reference TV; other
values reported by clients on other models include `Active Standby`, `Suspend` and `Screen Off`,
sometimes alongside `processing` and `reason` fields. Subscribing to it is the correct way to
detect the TV being turned off by any means. Note that once the TV reaches standby the socket
closes and the port stops accepting connections — the absence of an answer is itself the signal.

`turnOffScreen` / `turnOnScreen` were **not** issued live. Some webOS 5+ models additionally
require `{ "standbyMode": "active" }`; if a bare call returns a `500`, that is the first thing to
try.

---

### 6.4 `system.launcher` and `applicationManager` — apps

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://com.webos.applicationManager/listLaunchPoints` | `live` | — | `launchPoints: [...]` — the launcher bar |
| `ssap://com.webos.applicationManager/listApps` | `live` | — | `apps: [...]` — everything installed (154 entries on the reference TV) |
| `ssap://com.webos.applicationManager/getForegroundAppInfo` | `live` | — | `{ appId, appCategory, processId, windowId }` |
| `ssap://com.webos.applicationManager/getAppInfo` | `live` | `{ id: string }` | `{ appId, appInfo: {...} }` |
| `ssap://com.webos.applicationManager/launch` | `live*` | `{ id: string, params?: object }` | `returnValue` |
| `ssap://system.launcher/launch` | `live*` | `{ id: string, contentId?: string, params?: object }` | `{ returnValue, sessionId? }` |
| `ssap://system.launcher/close` | `live*` | `{ id: string }` | `returnValue` |
| `ssap://system.launcher/open` | `live*` | `{ target: string }` | Opens a URL in the TV browser |
| `ssap://system.launcher/getAppState` | `403` | `{ appId, sessionId }` | Denied to this manifest on the reference TV |
| `ssap://com.webos.applicationManager/close` | `404` | — | Use `system.launcher/close` |
| `ssap://com.webos.applicationManager/getAppStatus` | `404` | — | Use `getForegroundAppInfo` |

`listLaunchPoints` is what a remote app shows the user; `listApps` includes hidden system apps and
is far longer — 24 launch points against 154 apps on the reference TV. A launch point:

```json
{
  "id": "netflix",
  "title": "Netflix",
  "launchPointId": "netflix_default",
  "systemApp": false,
  "removable": true,
  "installTime": 1766064560,
  "icon": "https://<host>:3001/resources/<hash>/SMALL_APP_ICON.png",
  "largeIcon": "https://<host>:3001/resources/<hash>/LARGE_APP_ICON.png",
  "bgImage": "/media/cryptofs/apps/usr/palm/applications/netflix/…png",
  "iconColor": "#ffffff",
  "tileSize": "normal",
  "relaunch": false,
  "hidden": false,
  "unmovable": false,
  "params": {},
  "previewMetadata": { "targetEndpoint": "luna://netflix.service/discovery", "sourceEndpoint": "…" }
}
```

Filter on `systemApp !== true` to get the user-facing list — that is what `lgtv app list` does
without `--all`.

Icon URLs are served over HTTPS **by the TV itself** on the secure port, with the same
self-signed certificate. Fetching them needs the same verification bypass as the websocket.

`getAppInfo` returns the full `appInfo` manifest for one app: `folderPath`, `version`, `vendor`,
`type` (`web` / `native`), `trustLevel`, `deeplinkingParams`, `supportTouchMode`, and much more.
It is the reliable way to discover an app's `deeplinkingParams` template before constructing a
`contentId`.

Launching:

- Unknown id via `system.launcher/launch` → `500 Application error` with a bare
  `{"returnValue": false}`.
- Unknown id via `applicationManager/launch` → `500` with `{"errorCode": -101, "errorText": "not exist"}`.
  The latter is the better endpoint for existence checks; the former is the better one for
  deep-linking, since it accepts `contentId`.
- `contentId` semantics are per-app. `getAppInfo(id).appInfo.deeplinkingParams` shows the
  template the app expects, e.g. `{"contentTarget": "$CONTENTID"}`.

Deep-linking YouTube (`youtube.leanback.v4`) — what `lgtv youtube` sends:

```json
{
  "id": "youtube.leanback.v4",
  "contentId": "https://www.youtube.com/tv?v=dQw4w9WgXcQ&t=90",
  "params": { "contentTarget": "https://www.youtube.com/tv?v=dQw4w9WgXcQ&t=90" }
}
```

`https://www.youtube.com/tv?…` is the leanback front end's own URL space; it reads `v`
(video), `list` (playlist), `t` (start offset in seconds) and `q` (search) off it. `contentId` and `params`
are two firmware generations of the same mechanism — the launcher substitutes `contentId` into
`deeplinkingParams`, older builds only honour an explicit `params` — so sending the identical
URL in both is the portable form. A launch replies `{returnValue: true, sessionId: "…"}`.

Verified on the reference TV against YouTube `25.1.1`, whose `deeplinkingParams` is
`{"contentTarget":"$CONTENTID"}`: the video opens from another input *and* while the app is
already in the foreground, and `t=` seeks rather than being ignored. Nothing on the wire reports
which video the app settled on — `getForegroundAppInfo` only confirms the app — so a deep link
can only be checked by looking at the screen.

`q` opens the app's **search screen with the query already entered** — `lgtv youtube --search`:

```json
{
  "id": "youtube.leanback.v4",
  "contentId": "https://www.youtube.com/tv?q=cello%20suites",
  "params": { "contentTarget": "https://www.youtube.com/tv?q=cello%20suites" }
}
```

Verified on the reference TV from a cold start (`?q=jazz%20trio`) and against the app already in
the foreground on a previous search (`?q=cello%20suites` replaced it). Spaces were sent as `%20`;
`+` is equally legal URL syntax but has not been tried here, which is why `contentTarget()`
rewrites it (`src/domain/youtube.ts:147`). **An empty `q` is a no-op** — `?q=` sent to the running
app left the screen on its previous search, so there is no deep link to a *blank* search box.

That matters because the alternative route to the search box is worse than it looks. Walking
there with `key LEFT … UP … ENTER` and then filling it with `com.webos.service.ime/insertText`
could not be made to work: after every attempt `registerRemoteKeyboard` still reported
`{"currentWidget":{"focus":false}}`, i.e. the leanback search field is the app's own on-screen
keyboard grid and never raises the system IME. Text *did* appear in the box during that probing,
but a `q` deep link had been sent in the same run and deep links land on a running app, so the
insert is not what put it there. Deep-link the query rather than trying to type it.

`system.launcher/close` answered `403 access denied` for an id that does not exist — the method
is present but refuses ids it cannot resolve to a session this client owns. It is also refused
for ids that plainly do exist: closing a foreground `youtube.leanback.v4` succeeded once and then
answered `403` a few minutes later, same client, same app, also foreground and also launched by
this client. What distinguishes the two is not known. Treat `close` as best-effort and confirm
with `getForegroundAppInfo` instead of trusting the reply — a refused close leaves the app
running, which then silently turns a "cold start" test into a relaunch.

Well-known app ids: `netflix`, `youtube.leanback.v4`, `amazon` (Prime Video), `com.webos.app.home`,
`com.webos.app.livetv`, `com.webos.app.browser`, `com.webos.app.discovery` (LG Content Store),
`com.webos.app.hdmi1`…`hdmi4`, `com.webos.app.selfdiagnosis`. Enumerate rather than assume —
`lgtv app list --all`.

---

### 6.5 `tv` — inputs and channels

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://tv/getExternalInputList` | `live` | — | `devices: [...]` |
| `ssap://tv/switchInput` | `live*` | `{ inputId: string }` | `returnValue` |
| `ssap://tv/getChannelList` | `live` | — | `{ channelList: [...], channelListCount, ... }` |
| `ssap://tv/getCurrentChannel` | `live*` | — | `{ channelId, channelNumber, channelName, channelTypeName, ... }` |
| `ssap://tv/openChannel` | `live*` | `{ channelNumber: string }` or `{ channelId: string }` | `returnValue` |
| `ssap://tv/channelUp` | `live` | — | `returnValue` |
| `ssap://tv/channelDown` | `live` | — | `returnValue` |
| `ssap://tv/getChannelProgramInfo` | `live*` | — | Current/next programme (EPG) |
| `ssap://tv/getChannelCurrentProgramInfo` | `live*` | — | As above, alternate name |
| `ssap://tv/getACRAuthToken` | `live` | — | `{ token: string }` |
| `ssap://tv/getCountryInfo` | `404` | — | Use `settings/getSystemSettings` category `option` |
| `ssap://tv/getFavoriteChannelList` | `404` | — | |
| `ssap://tv/getChannelInfo` | `404` | — | |
| `ssap://tv/getTVSystemInfo` | `404` | — | Use `system/getSystemInfo` |

An external input entry:

```json
{
  "id": "HDMI_2",
  "label": "PS5 Game Console",
  "port": 2,
  "appId": "com.webos.app.hdmi2",
  "connected": false,
  "hdmiPlugIn": true,
  "hdmiSignalExist": false,
  "icon": "https://<host>:3001/resources/<hash>/gameconsole.png",
  "favorite": false,
  "subCount": 2,
  "subList": [
    { "id": "SIMPLINK", "portId": 2, "osdName": "PlayStation 5", "cecPower": "Off", "cecpDevType": 4, "physicalAddress": 8192 },
    { "id": "URCU", "brandName": "PS5", "labelName": "PS5", "serviceType": "game", "codeset": "N5724" }
  ]
}
```

Three distinct notions of "connected" — note the difference:

| Field | Meaning |
| --- | --- |
| `connected` | This input is the one currently selected. |
| `hdmiPlugIn` | Something is physically plugged into the port. |
| `hdmiSignalExist` | That something is currently sending a signal. |

`subList` surfaces HDMI-CEC (SIMPLINK) peers and learned universal-remote (URCU) profiles,
including `cecPower` — which is how you can tell whether a connected console is awake.

`switchInput` takes the `id` (`HDMI_1`), not the label and not the `appId`. An unknown value
returns `500` / `no such input`. Switching inputs can equivalently be done by launching the
input's `appId` through `system.launcher/launch`.

**Channels need a tuner.** With no broadcast signal, `getCurrentChannel`, `getChannelProgramInfo`
and `openChannel` all fail with the nested `com.webos.service.utp/bind` error described in
section 3.2 (`There is no active broadcast to bind`). `getChannelList` still succeeds but returns
an empty list plus a diagnostic:

```json
{
  "returnValue": true,
  "channelListCount": 0,
  "channelList": [],
  "tuner_channel": { "returnValue": false, "errorCode": "1010", "errorText": "tuner channel map does not exist" },
  "ipAntennaSupport": true, "ipCableSupport": true, "ipSatelliteSupport": true, "ipOPSupport": true,
  "dataSource": 2, "dataType": 0, "verifyDone": true
}
```

`channelUp` / `channelDown` return `returnValue: true` even with no tuner — they are fire-and-forget.

`getACRAuthToken` returns a 128-hex-character automatic-content-recognition token. It is a
device-identifying secret tied to LG's content-recognition service; do not log or transmit it.

---

### 6.6 `media.controls` — playback transport

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://media.controls/play` | `live` | — | `returnValue` |
| `ssap://media.controls/pause` | `live` | — | `returnValue` |
| `ssap://media.controls/stop` | `live` | — | `returnValue` |
| `ssap://media.controls/rewind` | `live` | — | `returnValue` |
| `ssap://media.controls/fastForward` | `live` | — | `returnValue` |
| `ssap://media.controls/getStatus` | `404` | — | No transport-state read-back on this model |

All five return `{"returnValue": true}` unconditionally — **including when nothing is playing**.
The reply confirms the frame was accepted, never that the media state changed. There is no way to
read transport state back on webOS 23, so a client cannot verify a pause took effect.

#### `media.viewer` — opening a file (dead on webOS 23)

`media.viewer` appears in `getServiceList` and does have real methods, but none of them can be
made to work on this firmware.

| Method | Status | Payload | Result |
| --- | --- | --- | --- |
| `ssap://media.viewer/open` | `broken` | `{ target: string }` | `1 Invalid appId specified OR Unsupported Application Type: com.webos.app.photovideo` |
| `ssap://media.viewer/open` | `broken` | anything without `target` | `500 Application error` |
| `ssap://media.viewer/close` | `403` | — | `access denied` — method exists, refuses this client |
| `ssap://media.viewer/play`, `/stop`, `/getStatus`, `/getViewerStatus` | `404` | — | not this service's methods |

`open` requires a `target` and then hands off to `com.webos.app.photovideo` — an app id that no
longer exists on webOS 23 (`getAppInfo` for it returns the same `Invalid appId` error). The
hand-off target is fixed: passing `appId` alongside `target` does not redirect it, and the error
is identical for `file://` and `http://` targets and for `.mp4` / `.jpg` / `.mp3` extensions. The
endpoint is a relic pointing at a removed app; there is no payload that makes it succeed.

**There is therefore no way to open a file from USB over SSAP.** The pieces that do exist:

- `com.webos.service.attachedstoragemanager/listDevices` (section 6.12) enumerates attached USB
  storage and gives its mount path — a listing only, with no directory-browse method.
- The Media Player app is `com.webos.app.mediadiscovery` (photovideo's replacement). Its
  `getAppInfo` reports `deeplinkingParams: ""`, i.e. it declares no deep-link template, and it
  behaves accordingly: `system.launcher/launch` with `contentId`, and `launch` with
  `params: { target | deviceId }`, both answer `returnValue: true` and then land on the app's
  device-picker home screen (verified on-screen). The launch reply's `true` is about the app id
  only; the content arguments are silently dropped.

Driving the Media Player's UI with `lgtv key` / the pointer socket is the only remaining route.

Also `404`, searched for while looking for a play-a-URI API: `com.webos.media/load`,
`com.webos.media/play`, `com.webos.service.mediaindexer/getDeviceList`,
`com.webos.service.mediaindexer/requestMediaScan`, `com.webos.service.photorenderer/display`,
`com.webos.service.videooutput/getStatus`.

---

### 6.7 `system.notifications` — toasts and alerts

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://system.notifications/createToast` | `live*` | `{ message: string, iconData?, iconExtension?, onClick? }` | `{ toastId }` |
| `ssap://system.notifications/createAlert` | `live*` | `{ message, buttons: [...], ... }` | `{ alertId }` |
| `ssap://system.notifications/closeToast` | `live*` | `{ toastId: string }` (or a source id) | `returnValue` |
| `ssap://system.notifications/closeAlert` | `live*` | `{ alertId: string }` | `returnValue` |

Parameter requirements recovered from live error text:

| Call | `errorText` |
| --- | --- |
| `createToast {}` | `missing "message" parameter` |
| `createAlert {}` | `Message is not parsed` |
| `closeToast {}` | `Both Toast Id and Source Id can't be Empty` |
| `closeAlert {}` | `Message is not parsed` |

`message` is the only required field for a toast. `iconData` is base64 image bytes and
`iconExtension` its type (`png`, `jpg`). `onClick` describes an action to run if the user selects
the toast.

`createAlert` renders a modal dialog with buttons and blocks the user until dismissed — it is far
more intrusive than a toast. Each button is `{ label, onClick, params }`; the returned `alertId`
is what `closeAlert` takes.

---

### 6.8 `settings` and `config` — reading TV configuration

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://settings/getSystemSettings` | `live` | `{ category: string, keys: string[] }` | `{ category, settings: {...} }` |
| `ssap://settings/setSystemSettings` | `live*` | `{ category: string, settings: {...} }` | `returnValue` |
| `ssap://config/getConfigs` | `live` | `{ configNames: string[] }` — glob patterns allowed | `{ configs: {...} }` |
| `ssap://settings/getCurrentSettings` | `404` | | |
| `ssap://com.webos.settingsservice/getSystemSettings` | `404` | | Long form not bridged; use `ssap://settings/…` |
| `ssap://system/getSystemSettings` | `404` | | |

#### `getSystemSettings`

Both `category` and `keys` are mandatory — omitting `keys` returns `keys are mandatory.`

Verified categories and keys:

| Category | Keys confirmed | Sample response |
| --- | --- | --- |
| `option` | `country`, `audioGuidance` | `{"audioGuidance":"off"}` |
| `picture` | `brightness`, `contrast`, `backlight`, `pictureMode` | `{"brightness":"50","contrast":"95","backlight":"100","pictureMode":"normal"}` |
| `sound` | `soundMode` | `{"soundMode":"standard"}` |
| `general` | `tvOnScreen` | `{"tvOnScreen":"effect"}` |
| `network` | `deviceName` | `{"deviceName":"[LG] webOS TV UR8750PSA"}` |

Numeric picture settings come back as **strings**, not numbers.

Two rejection modes, both worth handling:

| Cause | `errorText` |
| --- | --- |
| Category not known | `category, <name> doesn't support the key(s): <keys>` |
| Category known, key not permitted for this client | `Some keys are not allowed for the request. ( <key> )` |

**A single disallowed key fails the entire request** — `["country","audioGuidance","IPControlSecureKey"]`
returned nothing at all rather than the two readable values. Request keys one at a time when
probing. Keys rejected as not-allowed on the reference TV: `systemPin`, `onTimer`,
`quickStartMode`, `IPControlSecureKey`, `screenRotation`. Categories rejected as unknown:
`aiService`.

`setSystemSettings` exists (it rejects an unknown category with the same message shape) and is
covered by the manifest's `WRITE_SETTINGS` permission. It was not exercised live — writes here
change picture and sound presets persistently.

#### `getConfigs`

Takes glob patterns and returns a flat map. Verified prefixes:

| Pattern | Contents |
| --- | --- |
| `tv.model.*` | 123 hardware capability flags on the reference TV — panel type, supported HDR modes, tuner type, WoL support, speaker wattage, serial number, model name |
| `tv.nyx.*` | Firmware and platform identity |
| `tv.conti.*` | Regional/broadcast feature flags |
| `tv.rmm.*` | Tuner and broadcast-standard flags |

```json
{
  "tv.nyx.otaId": "HE_DTV_W23P_AFADATAA",
  "tv.nyx.platformCode": "10",
  "tv.nyx.platformVersion": "10.3.1",
  "tv.nyx.sdpproductid": "webOSTV 23",
  "tv.nyx.firmwareVersion": "33.31.61",
  "tv.nyx.bootloaderVersion": "8.00.173/8.00.173",
  "tv.nyx.beta": false,
  "tv.nyx.tvBroadcastSystem": "ATSC"
}
```

`tv.model.*` is the best capability-detection surface available. Selected flags from the
reference TV:

```json
{
  "tv.model.modelname": "55UR8750PSA",
  "tv.model.TVManufacturer": "LG Electronics",
  "tv.model.displayType": "LCD DISPLAY",
  "tv.model.moduleInchType": "55",
  "tv.model.supportHDR": true,
  "tv.model.supportDolbyVisionHDR": false,
  "tv.model.supportWol": true,
  "tv.model.supportLAN": "On",
  "tv.model.wifiType": "WiFi_BT",
  "tv.model.supportVRR": "vrr_off",
  "tv.model.supportFreesync": false,
  "tv.model.instantBoot": "quickStartPlus",
  "tv.model.sysType": "ATSC",
  "tv.model.audioSpkWatt": "10W"
}
```

Note `tv.model.supportWol` — the definitive answer to "can this TV be woken at all", independent
of whether the *setting* is enabled.

Booleans here are real JSON booleans, unlike `getSystemSettings` values.

---

### 6.9 `connectionmanager` — network state and MAC addresses

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://com.webos.service.connectionmanager/getinfo` | `live` | — | Per-interface MAC addresses |
| `ssap://com.webos.service.connectionmanager/getstatus` | `live` | — | Per-interface link state |
| `ssap://com.webos.service.connectionmanager/getStatus` | `404` | — | **Capital S is a 404.** Both methods are lowercase on the wire. |

`getinfo` — MACs only, listed **whether or not the interface has a link**:

```json
{
  "returnValue": true,
  "wiredInfo": { "macAddress": "AA:BB:CC:11:22:33" },
  "wifiInfo":  { "macAddress": "AA:BB:CC:44:55:66" },
  "p2pInfo":   { "macAddress": "AC:BB:CC:44:55:66" }
}
```

`getstatus` — link state and addressing, **and no MACs at all**:

```json
{
  "returnValue": true,
  "wired": { "state": "disconnected", "plugged": false },
  "wifi": {
    "state": "connected",
    "interfaceName": "wlan0",
    "ipAddress": "192.168.1.50",
    "netmask": "255.255.255.0",
    "gateway": "192.168.1.1",
    "method": "dhcp",
    "ssid": "<redacted>",
    "connectedChannel": "44",
    "connectedFrequency": "5220",
    "isWakeOnWifiEnabled": false,
    "onInternet": "yes",
    "ipv6": { "ipAddress": "…", "prefixLength": 64, "method": "auto", "gateway": "…" }
  },
  "wifiDirect": { "state": "disconnected" },
  "bluetooth": { "state": "disconnected", "tetheringEnabled": false },
  "cellular": { "enabled": false },
  "wan": { "connected": false, "connectedContexts": [] },
  "offlineMode": "disabled",
  "isInternetConnectionAvailable": true
}
```

> **You need both calls to pick the right MAC for Wake-on-LAN.** Neither is sufficient alone:
> `getinfo` lists a wired MAC on a TV that has never had a cable plugged in, so "prefer wired"
> silently stores the dead NIC's address; `getstatus` says which interface is live but carries no
> MAC. Join them — `macForActiveInterface` in `src/domain/ssap.ts:176`.

`isWakeOnWifiEnabled: false` on a Wi-Fi-connected TV means **no magic packet can ever wake it**,
regardless of router configuration. Check it at pairing time and warn — `src/commands/setup.ts:73`.

---

### 6.10 `com.webos.service.ime` — text entry

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://com.webos.service.ime/insertText` | `live` | `{ text: string, replace: boolean }` | `returnValue` |
| `ssap://com.webos.service.ime/sendEnterKey` | `live` | — | `returnValue` |
| `ssap://com.webos.service.ime/deleteCharacters` | `live*` | `{ count: number }` — must be ≥ 1 | `returnValue` |
| `ssap://com.webos.service.ime/registerRemoteKeyboard` | `live` | — | **Subscribe-only** |

All three write methods return `{"returnValue": true}` **even with no text field focused on the
TV** — `insertText {"text":"", "replace":false}` succeeded against the home screen. The reply says
the frame was accepted, not that any character landed. There is no way to detect a missing focus.

`deleteCharacters` rejects `count: 0` with `Missing or invalid "count" parameter`. Sending a count
larger than the field content is safe and is how "clear the field" is implemented
(`src/commands/remote.ts:134` sends 255).

`registerRemoteKeyboard` must be sent as `type: "subscribe"`; a plain request returns
`500` / `Must subscribe to registerRemoteKeyboard`. Once subscribed it pushes the focus state of
the on-screen keyboard, which is the only way to know whether `insertText` will go anywhere.

---

### 6.11 `com.webos.service.networkinput` — the pointer socket

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://com.webos.service.networkinput/getPointerInputSocket` | `live` | — | `{ socketPath: string }` |

```json
{ "returnValue": true, "socketPath": "wss://192.168.1.50:3001/resources/<hash>/netinput.pointer.sock" }
```

The returned `socketPath` is a **complete URL for a second WebSocket**, on the same host and port,
with a per-session hash in the path. It does not speak JSON. See section 7.

---

### 6.12 `com.webos.service.attachedstoragemanager` — storage

| Method | Status | Payload | Returns |
| --- | --- | --- | --- |
| `ssap://com.webos.service.attachedstoragemanager/listDevices` | `live` | — | `devices: [{ deviceId, deviceName, deviceType, deviceUri }]` |

Lists internal pseudo-devices and any attached USB storage:

```json
{
  "returnValue": true,
  "devices": [
    { "deviceId": "INTERNAL_STORAGE_PICTUREWIZARD", "deviceName": "INTERNAL_STORAGE_PICTUREWIZARD", "deviceType": "internal picturewizard", "deviceUri": "/mnt/lg/appstore/preload/picturewizard" },
    { "deviceId": "INTERNAL_STORAGE_CAMERA", "deviceName": "CAMERA_INTERNAL STORAGE", "deviceType": "internal camera", "deviceUri": "/mnt/lg/appstore/cam" },
    { "deviceId": "INTERNAL_STORAGE_SAMPLES", "deviceName": "SAMPLE INTERNAL STORAGE", "deviceType": "internal samples", "deviceUri": "…/samples" }
  ]
}
```

---

### 6.13 Confirmed absent on webOS 23

Documented by other clients or plausible by naming convention; all returned
`404 no such service or method` on the reference TV.

| URI | Use instead |
| --- | --- |
| `ssap://com.webos.settingsservice/getSystemSettings` | `ssap://settings/getSystemSettings` |
| `ssap://com.webos.service.connectionmanager/getStatus` | lowercase `getstatus` |
| `ssap://com.webos.applicationManager/close` | `ssap://system.launcher/close` |
| `ssap://com.webos.applicationManager/getAppStatus` | `getForegroundAppInfo` |
| `ssap://com.webos.service.tv.systemproperty/getSystemInfo` | `ssap://system/getSystemInfo` |
| `ssap://com.webos.service.eim/getAllInputSources` | `ssap://tv/getExternalInputList` |
| `ssap://com.webos.service.bluetooth2/adapter/getStatus` | — |
| `ssap://com.webos.service.tv.time/getCurrentTime` | — |
| `ssap://com.webos.service.secondscreen.gateway/app2app/getDeviceInfo` | — |
| `ssap://tv/getCountryInfo` | `settings/getSystemSettings` category `option` |
| `ssap://tv/getFavoriteChannelList`, `ssap://tv/getChannelInfo`, `ssap://tv/getTVSystemInfo` | — |
| `ssap://media.controls/getStatus`, `ssap://media.viewer/getStatus` | — |
| `ssap://timer/getTimer`, `ssap://timer/getSleepTimer` | — |
| `ssap://user/getUserInfo`, `ssap://webapp/getWebAppList`, `ssap://externalpq/getStatus`, `ssap://pairing/getPairingStatus`, `ssap://settings/getCurrentSettings` | — |

The last row is notable: `timer`, `user`, `webapp`, `externalpq`, `pairing` and `weeCustom` all
appear in `getServiceList`, so the *services* exist — the guessed method names simply are not
theirs. Their real method names remain undiscovered.

---

## 7. The Magic Remote pointer channel

Remote-control **button presses do not travel over SSAP.** They go over a second WebSocket whose
URL comes from `getPointerInputSocket`, and which speaks a plain-text line protocol.

This is the same channel a physical Magic Remote uses, which is why it carries both pointer
motion and button events.

### Frame grammar

Each frame is a set of `key:value` lines terminated by a **blank line** — i.e. the frame ends
with `\n\n`. No JSON, no ids, no responses of any kind.

```
type:button\nname:HOME\n\n
type:click\n\n
type:move\ndx:40\ndy:-10\ndown:0\n\n
type:scroll\ndx:0\ndy:-3\n\n
```

| `type` | Fields | Meaning |
| --- | --- | --- |
| `button` | `name` | Press and release a remote button. |
| `click` | — | Click at the current pointer position. |
| `move` | `dx`, `dy`, `down` | Move the pointer by a relative delta. `down:1` drags. |
| `scroll` | `dx`, `dy` | Scroll wheel. Negative `dy` scrolls down. |

Coordinates are **relative deltas in pointer units**, not screen pixels, and there is no way to
read the current pointer position or to move to an absolute point.

> **Writes are fire-and-forget.** The TV never acknowledges a pointer frame, so a client that
> closes the socket immediately after writing will lose the last frame. Sleep ~120 ms before
> tearing down the connection — `src/commands/remote.ts:51`.

### Button names

From `src/domain/buttons.ts`. Names are case-sensitive on the wire; this CLI upper-cases and
resolves aliases before sending.

| Group | Names |
| --- | --- |
| Navigation | `UP` `DOWN` `LEFT` `RIGHT` `ENTER` `BACK` `EXIT` `HOME` |
| Playback | `PLAY` `PAUSE` `STOP` `REWIND` `FASTFORWARD` `RECORD` |
| Volume & channel | `VOLUMEUP` `VOLUMEDOWN` `MUTE` `CHANNELUP` `CHANNELDOWN` |
| Numbers | `0`–`9` `DASH` |
| Colours | `RED` `GREEN` `YELLOW` `BLUE` |
| Menus | `MENU` `INFO` `GUIDE` `QMENU` `ASTERISK` `CC` `LIVE_ZOOM` `AD` `SEARCH` |
| Power | `POWER` |

Aliases accepted by `lgtv key` (client-side only — resolved before the frame is written):
`ok`/`select` → `ENTER`, `return` → `BACK`, `vol+`/`volup` → `VOLUMEUP`, `vol-`/`voldown` →
`VOLUMEDOWN`, `ch+`/`chup` → `CHANNELUP`, `ch-`/`chdown` → `CHANNELDOWN`, `ff`/`forward` →
`FASTFORWARD`, `rew` → `REWIND`, `settings` → `MENU`, `dot` → `DASH`, `star` → `ASTERISK`,
`subtitle` → `CC`.

The grammar has no reply path — nothing is ever read back from this socket — so an unrecognised
`name`, a malformed frame and a successful button press are indistinguishable to the client.
Validate names before sending; `resolveButton` (`src/domain/buttons.ts:45`) is where this CLI
does it.

Note the overlap with SSAP: `VOLUMEUP` here and `ssap://audio/volumeUp` do the same thing, as do
the playback buttons and `ssap://media.controls/*`. Prefer SSAP where it exists, since it at least
acknowledges the frame.

---

## 8. Adjacent protocols

Neither is SSAP, but a complete client needs both.

### 8.1 Discovery — SSDP

`M-SEARCH` over UDP multicast to **239.255.255.250:1900**:

```
M-SEARCH * HTTP/1.1
HOST: 239.255.255.250:1900
MAN: "ssdp:discover"
MX: 2
ST: <target>
```

Three search targets are sent, because not every model advertises the LG-specific one
(`src/services/Discovery.ts:19`):

| Target | Why |
| --- | --- |
| `urn:lge-com:service:webos-second-screen:1` | The webOS second-screen service. |
| `urn:schemas-upnp-org:device:MediaRenderer:1` | Models that only advertise generic UPnP. |
| `ssdp:all` | Catch-all. |

A reply counts as an LG TV when any of the `st`, `usn`, `server` or `location` headers matches
`/lge?[-_ ]?com|webos|lg electronics|lgsmarttv/i`. Fetch the `location` URL — a UPnP device
description — for `<friendlyName>` and `<modelName>`.

Discovery finds TVs that are **on**. Many models stop answering SSDP in standby even when they
are still listening for Wake-on-LAN, so an empty result does not mean the TV is unreachable.
Multicast is also routinely dropped by guest networks, VLANs and Wi-Fi client isolation.

### 8.2 Wake — Wake-on-LAN

Standard magic packet: `FF FF FF FF FF FF` followed by the 6-byte MAC repeated 16 times
(102 bytes). Sent to **both** `255.255.255.255` and the TV's `/24` directed broadcast
(`a.b.c.255`), on **ports 9 and 7**, three times each — which combination survives depends
entirely on the router, and the packets are 102 bytes (`src/services/Wol.ts:47`).

Prerequisites on the TV, all three of which must hold:

1. *Settings → General → External Devices → LG Connect Apps* enabled.
2. *Settings → General → Devices → TV Management → Mobile TV On* enabled, so it keeps listening
   in standby.
3. The right MAC — the one belonging to the **active** interface (section 6.9), not `device_id`
   from `getCurrentSWInformation`.

If the TV is on Wi-Fi and `isWakeOnWifiEnabled` is `false`, none of this works: the Wi-Fi chip is
powered down in standby. That is a TV setting, not a network problem.

---

## 9. Where `test/fake-tv.ts` diverges from real hardware

The test double is deliberately minimal. Known behavioural differences, useful when a change
passes tests but fails against a TV:

| Behaviour | `fake-tv.ts` | Reference TV |
| --- | --- | --- |
| `subscribe` to `audio/getVolume` | Echoes `subscribed: true` | Omits the field entirely, but pushes normally |
| Volume payload | Flat `volume`/`muted` **and** nested `volumeStatus` | Nested only, plus `callerId` |
| Unknown URI | `error` frame, always | `404`, `403`, `500` or `2 invalid parameters` depending on why |
| `setMute` with a non-boolean | Coerces via `Boolean()` | Coerces too — and really mutes |
| Pointer socket | Plain `ws://` on a separate port | `wss://` on the same port, hashed path |
| Response latency | Immediate | 20–400 ms; channel and app-list calls are slowest |

---

## 10. Probing an unknown endpoint

`lgtv raw` sends any URI and prints the reply, which is the fastest way to answer "does this model
support X":

```bash
lgtv raw ssap://api/getServiceList
lgtv raw ssap://audio/getVolume
lgtv raw ssap://settings/getSystemSettings --payload '{"category":"picture","keys":["brightness"]}'
lgtv raw ssap://config/getConfigs --payload '{"configNames":["tv.model.*"]}'
```

Reading the result:

| Reply | Conclusion |
| --- | --- |
| `404 no such service or method` | Not on this model. Stop. |
| `403 access denied` | Exists; the manifest or session cannot use it. |
| `2 invalid parameters` / `1 Could not validate…` | Exists; your payload is wrong. |
| `500` with `errorText` | Exists and ran. **Read `errorText` — it usually names the missing parameter.** |
| `returnValue: false` | Exists and refused. Check `errorText`. |

Technique that recovered most of the parameter documentation above: **call the method with
deliberately invalid arguments** (`{"inputId":"__nonexistent__"}`, `{}`) and read the error text.
It distinguishes "absent" from "wrong arguments" without changing TV state.

Two cautions:

- Some setters **coerce rather than reject**. `{"mute":"not-a-boolean"}` muted the reference TV
  instead of erroring. Probe with an argument that is invalid in *type*, and never probe
  destructive methods (`system/turnOff`, `power/turnOffScreen`) this way.
- Each `lgtv raw` opens a fresh connection and repeats the handshake. To probe many endpoints,
  reuse one socket.
