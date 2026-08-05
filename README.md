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

lgtv youtube <url|video-id>        Open a video, short or playlist in the YouTube app
             [--start 90] [--app-id ...]
lgtv youtube --search "cello suites"   Open the YouTube search screen for a query

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

lgtv repl                          Drive many commands over one connection
lgtv run "volume set 12" "key HOME"   The same, from a script, stopping on the first failure
```

`youtube` takes whatever the share sheet gives you — `youtu.be/…`, a `watch?v=…` URL, a
short, a `/live` link, a playlist, or a bare video id — and deep-links it into the TV's
YouTube app, keeping any `t=` timestamp:

```bash
lgtv youtube 'https://youtu.be/dQw4w9WgXcQ?t=90'
lgtv youtube dQw4w9WgXcQ --start 90
```

Quote the URL: `&` and `?` mean something to your shell.

`--search` opens the app's search screen with the query already filled in, which is the only
practical way to search from the command line — the search box is drawn by the YouTube app
itself, so `lgtv type` cannot reach it:

```bash
lgtv youtube --search "cello suites"
```

### `lgtv repl`

Every command above also works inside `lgtv repl`, without the leading `lgtv` — and unlike the
one-shot form, the whole session shares a single connection and handshake, so `key`/`cursor`
reuse one Magic Remote pointer socket instead of reopening it every press:

Start it with `VERBOSE=true` and every reply the TV sends is echoed as it arrives, above whatever
the command prints — a line that went out and got nothing back is flagged instead:

```
$ VERBOSE=true lgtv --host 192.168.1.50 repl
Connected to 192.168.1.50. Type a command, or "help".
lgtv> status
← ssap://com.webos.service.tvpower/power/getPowerState {"state":"Active","returnValue":true}
← ssap://com.webos.applicationManager/getForegroundAppInfo {"returnValue":true,"appId":"netflix"}
← ssap://audio/getVolume {"returnValue":true,"volumeStatus":{"volume":12,"muteStatus":false}}
192.168.1.50
power     on
app       netflix
volume    12
lgtv> key HOME
✓ Sent HOME
← no response
lgtv> exit
```

`key` and `cursor` write to the Magic Remote input socket, which never answers — hence the flag.
The echo goes to stderr, so `lgtv --json repl | jq` still sees only command output on stdout.
`VERBOSE` is read once, when the repl starts, and accepts `true`, `1`, `yes` or `on`; without it
the prompt behaves exactly as before.

Tab completion, history, and Ctrl-C (cancels the running command, not the session) all work.
It also reads from a pipe, running every line and exiting 0 whatever they do:

```bash
printf 'status\nvolume up\nvolume\n' | lgtv --host 192.168.1.50 repl
```

### `lgtv run`

The same loop over a fixed sequence, for scripts. It shares the one connection and pointer socket
the way the repl does, but reads nothing from stdin, prints no prompt, and — unlike the repl —
**stops at the first command that fails and exits 1**, so it can stand in for a `&&` chain:

```bash
lgtv run "app launch netflix" "key HOME" "volume set 12"
```

One argument per command, or one argument holding several lines:

```bash
lgtv run $'status\nvolume up'
```

Each command is split the way a shell would split it, so quoting works as it does at the prompt
(`lgtv run 'youtube --search "planet earth"'`). The failing command's error is reported exactly as
the one-shot form reports it, including under `--json`; the commands after it never run.

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
`LGTV_CONFIG_DIR`, and `VERBOSE` (echoes the TV's raw replies inside `lgtv repl`).

```bash
lgtv --json status | jq .volume
```

## How it works

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is a wire-level reference for SSAP itself — framing, the
pairing handshake, every known `ssap://` method with its parameters, and the Magic Remote pointer
channel. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) covers how this codebase is put together.

| Layer | What it does |
| --- | --- |
| `src/sdk/` | The SSAP client itself: websocket, pairing handshake, request/response demultiplexing by frame id, subscriptions, response decoders and the Magic Remote input socket. Plain Promises; `ws` is its only dependency. |
| `src/domain/` | Button names, YouTube link parsing, line tokenizing, and every CLI error as data. |
| `src/services/Settings.ts` | The config file: default host, per-TV MAC, client key and transport. |
| `src/services/Session.ts` | Resolves flags → env → saved settings into a URL, key and MAC. Resolution is lazy, so `discover` works before anything is configured. |
| `src/services/Tv.ts` | Binds the SDK to Effect: failures as typed values, sockets tied to a `Scope`, subscriptions as `Stream`s, and the client key read through `Session`. |
| `src/services/Discovery.ts` | SSDP `M-SEARCH`, then the UPnP description for the friendly name. |
| `src/services/Wol.ts` | Wake-on-LAN magic packets, sent to the global *and* subnet broadcast on ports 9 and 7. |
| `src/commands/` | One file per command group. |

Sockets are tied to an Effect `Scope`, so an interrupted command (Ctrl-C during `watch`, a
timeout) still closes its connection.

### Using the SSAP client on its own

The protocol client is a standalone SDK — no Effect, no CLI, nothing to configure:

```ts
import { connect, Uri, VolumeStatus } from "lgtv-remote/sdk"

const tv = await connect({
  host: "192.168.0.230",
  clientKey: savedKey,                       // omit on first pairing
  onPairingPrompt: () => console.log("accept the prompt on the TV"),
  onClientKey: (key) => save(key)            // only fires when the key changes
})

await tv.request(Uri.setVolume, { volume: 20 })
const { volume } = await tv.requestAs(Uri.getVolume, VolumeStatus)

for await (const update of tv.updates(Uri.getVolume)) {
  console.log(update["volume"])
  break
}

const pointer = await tv.pointer()
await pointer.button("HOME")

await tv.close()
```

Failures reject with `TvUnreachable`, `PairingFailed`, `SsapFailed` or `UnexpectedResponse` —
all `instanceof SsapError`, each carrying a `_tag` to switch on. Where the client key is
*stored*, how a TV is found, and what the user is told are all the caller's business; the SDK
reports the key it was granted and calls back when a prompt goes up.

### Why not the `lgtv2` package?

`lgtv2` is the well-known Node library for this protocol, but it is callback-based, ships
no types, and was last published in 2022. The protocol itself is small, so `src/sdk/`
implements it directly against `ws` — which buys decoded responses, typed failures, one
socket properly demultiplexed, and a subscription you can `for await` over. Its pairing
manifest is the same one every third-party remote sends; the TV verifies the signature, so
it must go over the wire verbatim.

## Tests

```bash
npm test
```

`test/fake-tv.ts` is a stand-in webOS server: it performs the pairing handshake (prompt
first, then a granted key), answers requests, refuses others with both error frames and
`returnValue: false`, serves a pointer input socket, and pushes subscription updates. The
suite drives the real client against it, so the protocol code is covered without hardware.

`test/contract.test.ts` runs one description of the protocol against *both* the standalone
SDK and the Effect binding, so the two cannot drift apart.

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
