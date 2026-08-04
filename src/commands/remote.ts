import { Args, Command, Options } from "@effect/cli"
import { Duration, Effect } from "effect"
import { buttonGroups, resolveButton } from "../domain/buttons.js"
import { BadInput } from "../domain/errors.js"
import { Uri } from "../domain/ssap.js"
import { withTv } from "../services/Tv.js"
import { bold, cyan, dim, emit, ok } from "../ui.js"

const names = Args.text({ name: "button" }).pipe(
  Args.repeated,
  Args.withDescription("One or more button names — see `lgtv keys`")
)

const gap = Options.integer("gap").pipe(
  Options.withDescription("Milliseconds to wait between presses"),
  Options.withDefault(120)
)

export const keyCommand = Command.make("key", { names, gap }, ({ names, gap }) =>
  Effect.gen(function* () {
    if (names.length === 0) {
      return yield* Effect.fail(
        new BadInput({ detail: "Give at least one button name, e.g. `lgtv key HOME`." })
      )
    }
    const resolved = names.map((name) => ({ name, button: resolveButton(name) }))
    const unknown = resolved.filter((entry) => entry.button === undefined)
    if (unknown.length > 0) {
      return yield* Effect.fail(
        new BadInput({
          detail: `Unknown button${unknown.length > 1 ? "s" : ""}: ${unknown
            .map((entry) => entry.name)
            .join(", ")}. Run \`lgtv keys\` to see the list.`
        })
      )
    }

    const buttons = resolved.map((entry) => entry.button as string)
    yield* withTv((tv) =>
      Effect.gen(function* () {
        const pointer = yield* tv.pointer
        yield* Effect.forEach(
          buttons,
          (button, index) =>
            index === 0
              ? pointer.button(button)
              : Effect.zipRight(Effect.sleep(Duration.millis(gap)), pointer.button(button)),
          { discard: true }
        )
        // Give the last frame time to reach the TV before the socket closes.
        yield* Effect.sleep(Duration.millis(120))
        yield* ok(`Sent ${buttons.map(cyan).join(" ")}`)
      })
    )
  })
).pipe(Command.withDescription("Press remote-control buttons"))

export const keysCommand = Command.make("keys", {}, () =>
  emit(
    Object.entries(buttonGroups)
      .map(([group, entries]) => `${bold(group)}\n  ${entries.join(" ")}`)
      .join("\n") + `\n\n${dim("Aliases: ok, vol+, vol-, ch+, ch-, ff, rew, settings, subtitle")}`,
    buttonGroups
  )
).pipe(Command.withDescription("List the button names `lgtv key` accepts"))

// ---- cursor ---------------------------------------------------------------

const dx = Args.integer({ name: "dx" })
const dy = Args.integer({ name: "dy" })

const drag = Options.boolean("drag").pipe(
  Options.withDescription("Hold the pointer down while moving")
)

const cursorMove = Command.make("move", { dx, dy, drag }, ({ dx, dy, drag }) =>
  withTv((tv) =>
    Effect.gen(function* () {
      const pointer = yield* tv.pointer
      yield* pointer.move(dx, dy, drag)
      yield* Effect.sleep(Duration.millis(120))
      yield* ok(`Moved pointer by (${dx}, ${dy})`)
    })
  )
).pipe(Command.withDescription("Move the Magic Remote pointer"))

const cursorClick = Command.make("click", {}, () =>
  withTv((tv) =>
    Effect.gen(function* () {
      const pointer = yield* tv.pointer
      yield* pointer.click
      yield* Effect.sleep(Duration.millis(120))
      yield* ok("Clicked")
    })
  )
).pipe(Command.withDescription("Click at the pointer position"))

const cursorScroll = Command.make("scroll", { dx, dy }, ({ dx, dy }) =>
  withTv((tv) =>
    Effect.gen(function* () {
      const pointer = yield* tv.pointer
      yield* pointer.scroll(dx, dy)
      yield* Effect.sleep(Duration.millis(120))
      yield* ok(`Scrolled (${dx}, ${dy})`)
    })
  )
).pipe(Command.withDescription("Scroll at the pointer position"))

export const cursorCommand = Command.make("cursor", {}, () =>
  Effect.fail(new BadInput({ detail: "Usage: lgtv cursor <move|click|scroll>" }))
).pipe(
  Command.withDescription("Drive the Magic Remote pointer"),
  Command.withSubcommands([cursorMove, cursorClick, cursorScroll])
)

// ---- text entry -----------------------------------------------------------

const text = Args.text({ name: "text" }).pipe(
  Args.withDescription("Text to type into the focused field")
)

const submit = Options.boolean("enter").pipe(
  Options.withDescription("Press Enter after typing")
)

const replace = Options.boolean("replace").pipe(
  Options.withDescription("Clear the field before typing")
)

export const typeCommand = Command.make("type", { text, submit, replace }, ({ text, submit, replace }) =>
  withTv((tv) =>
    Effect.gen(function* () {
      if (replace) {
        yield* tv.request(Uri.deleteCharacters, { count: 255 }).pipe(Effect.ignore)
      }
      yield* tv.request(Uri.insertText, { text, replace })
      if (submit) yield* tv.request(Uri.sendEnterKey)
      yield* ok(`Typed ${JSON.stringify(text)}${submit ? " and pressed Enter" : ""}`)
    })
  )
).pipe(Command.withDescription("Type text into the focused input on the TV"))

// ---- media transport ------------------------------------------------------

const mediaActions: ReadonlyArray<[string, { readonly name: string; readonly uri: string }]> = [
  ["play", { name: "play", uri: Uri.play }],
  ["pause", { name: "pause", uri: Uri.pause }],
  ["stop", { name: "stop", uri: Uri.stop }],
  ["rewind", { name: "rewind", uri: Uri.rewind }],
  ["forward", { name: "forward", uri: Uri.fastForward }]
]

const action = Args.choice(mediaActions, { name: "action" }).pipe(
  Args.withDescription("play, pause, stop, rewind, or forward")
)

export const mediaCommand = Command.make("media", { action }, ({ action }) =>
  withTv((tv) => Effect.zipRight(tv.request(action.uri), ok(`Sent ${action.name}`)))
).pipe(Command.withDescription("Control media playback"))
