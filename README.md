# lgtv-remote

Control an LG webOS TV from the command line. Built with [Effect](https://effect.website)
and `@effect/cli`.

It speaks **SSAP** — the websocket protocol the official LG remote app uses — so it can do
everything that app can: launch apps, switch inputs, change channels, press remote buttons,
drive the Magic Remote pointer, type into search boxes, and stream state changes.

## Requirements

- Node 22+
- On the TV: **Settings → General → External Devices → LG Connect Apps** (called
  *Mobile TV On* / *TV On with Mobile* on some models) must be enabled.
- For `lgtv on`, the TV also needs **Settings → General → Devices → TV Management →
  Mobile TV On** so it keeps listening for Wake-on-LAN while in standby.

## Setup

```bash
npm install
npm run build
npm link          # optional — puts `lgtv` on your PATH

lgtv discover                    # find TVs on your network
lgtv --host 192.168.1.50 pair    # accept the prompt that appears on the TV
lgtv status
```

`pair` stores the client key the TV grants, plus its MAC address and whether the connection
used `--ssl`, in `~/.config/lgtv-remote/config.yaml` (mode 0600). After that every command
just works — no `--host` or `--ssl` needed.

Without building, run it straight from source with `npm run lgtv -- status`.

## Commands

```
lgtv discover [--for 4]            Find LG webOS TVs on the network (SSDP)
lgtv pair                          Pair and remember the client key
lgtv status                        Power state, current app, volume, channel
lgtv info                          Model and firmware

lgtv on [--wait 30]                Wake-on-LAN, optionally blocking until it answers
lgtv off                           Standby
lgtv screen on|off                 Blank the panel, keep the audio

lgtv volume                        Show the volume
lgtv volume up|down [steps]
lgtv volume set 20
lgtv mute [on|off|toggle]

lgtv app list [--all]
lgtv app current
lgtv app launch netflix [--content-id ...]
lgtv app close netflix

lgtv input list
lgtv input set HDMI_1

lgtv channel current|list|up|down
lgtv channel set 7

lgtv media play|pause|stop|rewind|forward
lgtv key HOME UP UP ENTER          Remote buttons — see `lgtv keys`
lgtv cursor move 40 -10 | click | scroll 0 -3
lgtv type "planet earth" --enter   Type into the focused field

lgtv toast "Dinner is ready"
lgtv watch volume|app|channel|power
lgtv raw ssap://audio/getVolume [--payload '{"…":1}']
lgtv config show|set-host|set-mac|set-ssl|forget
```

### Global flags

| Flag | Meaning |
| --- | --- |
| `-H, --host` | TV address. Falls back to `$LGTV_HOST`, then the saved default. |
| `--port` | Websocket port. Default 3000, or 3001 with `--ssl`. |
| `--ssl` | Use the secure port — some 2023+ models only accept that one. Pair with it once and it is remembered for that TV. |
| `--no-ssl` | Ignore a remembered `--ssl` for this run. |
| `--timeout` | Seconds to wait for a reply. Default 10. |
| `--json` | Machine-readable output, including errors. Exit code 1 on failure. |

Also read from the environment: `LGTV_HOST`, `LGTV_PORT`, `LGTV_SSL`, `LGTV_MAC`,
`LGTV_CONFIG_DIR`.

```bash
lgtv --json status | jq .volume
```

## How it works

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is a wire-level reference for SSAP itself — framing, the
pairing handshake, every known `ssap://` method with its parameters, and the Magic Remote pointer
channel. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) covers how this codebase is put together.

| Layer | What it does |
| --- | --- |
| `src/domain/` | SSAP endpoints and response schemas, button names, the pairing manifest, and every error as data. |
| `src/services/Settings.ts` | The config file: default host, per-TV MAC, client key and transport. |
| `src/services/Session.ts` | Resolves flags → env → saved settings into a URL, key and MAC. Resolution is lazy, so `discover` works before anything is configured. |
| `src/services/Tv.ts` | The SSAP client: scoped websocket, handshake, request/response demultiplexing by frame id, subscriptions as `Stream`s, and the Magic Remote input socket. |
| `src/services/Discovery.ts` | SSDP `M-SEARCH`, then the UPnP description for the friendly name. |
| `src/services/Wol.ts` | Wake-on-LAN magic packets, sent to the global *and* subnet broadcast on ports 9 and 7. |
| `src/commands/` | One file per command group. |

Sockets are tied to an Effect `Scope`, so an interrupted command (Ctrl-C during `watch`, a
timeout) still closes its connection.

### Why not the `lgtv2` package?

`lgtv2` is the well-known Node library for this protocol, but it is callback-based, ships
no types, and was last published in 2022. The protocol itself is small, so `src/services/Tv.ts`
implements it directly against `ws` — which buys typed responses via `effect/Schema`, typed
errors, scoped connections, and subscriptions as real streams. Its pairing manifest is the
same one every third-party remote sends; the TV verifies the signature, so it must go over
the wire verbatim.

## Tests

```bash
npm test
```

`test/fake-tv.ts` is a stand-in webOS server: it performs the pairing handshake (prompt
first, then a granted key), answers requests, refuses others with both error frames and
`returnValue: false`, serves a pointer input socket, and pushes subscription updates. The
suite drives the real client against it, so the protocol code is covered without hardware.

## Troubleshooting

**`Could not reach the TV`** — check *LG Connect Apps* is on. If the TV is a 2023 or newer
model, try `--ssl`; pairing with it saves the choice, so later commands stay on the secure
port (`lgtv config set-ssl off` undoes that). If it is in standby, `lgtv on` first.

**`Pairing failed: timed out waiting for approval`** — the prompt appears on the TV itself;
accept it within 60 seconds.

**`lgtv on` does nothing** — Wake-on-LAN needs *Mobile TV On* enabled, a wired connection
or Wi-Fi that supports WoWLAN, and a router that forwards broadcasts. Confirm the stored MAC
with `lgtv config show`.

**A command returns `404 no such service or method`** — that endpoint does not exist on your
model. `lgtv raw` is the quickest way to probe alternatives; see
[Probing an unknown endpoint](docs/PROTOCOL.md#10-probing-an-unknown-endpoint) for how to read
what comes back, and [Confirmed absent on webOS 23](docs/PROTOCOL.md#613-confirmed-absent-on-webos-23)
for known-missing endpoints and their replacements.
