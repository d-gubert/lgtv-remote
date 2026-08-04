import { Command, Options } from "@effect/cli"
import { Console, Option } from "effect"
import { subcommands, VERSION } from "./commands/index.js"
import { replCommand } from "./commands/repl.js"
import { runCommand } from "./commands/run.js"
import * as Session from "./services/Session.js"
import { Settings } from "./services/Settings.js"
import { bold, dim } from "./ui.js"

const host = Options.text("host").pipe(
  Options.withAlias("H"),
  Options.withDescription("TV address (default: $LGTV_HOST, then the saved default)"),
  Options.optional
)

const port = Options.integer("port").pipe(
  Options.withDescription("Websocket port (default 3000, or 3001 with --ssl)"),
  Options.optional
)

/**
 * Three states, not two: unset means "use whatever this TV was paired over",
 * which is why `--no-ssl` exists — it is the only way to say plain explicitly.
 */
const ssl = Options.all({
  on: Options.boolean("ssl").pipe(
    Options.withDescription(
      "Use the secure websocket port — needed by some 2023+ models. Remembered per TV when you pair."
    )
  ),
  off: Options.boolean("no-ssl").pipe(
    Options.withDescription("Use the plain port, ignoring a remembered --ssl")
  )
}).pipe(
  Options.map(({ off, on }) =>
    on ? Option.some(true) : off ? Option.some(false) : Option.none<boolean>()
  )
)

const timeout = Options.integer("timeout").pipe(
  Options.withDescription("Seconds to wait for the TV to reply"),
  Options.withDefault(10)
)

const json = Options.boolean("json").pipe(
  Options.withDescription("Print machine-readable JSON instead of formatted text")
)

const quickStart = [
  bold("lgtv") + " — control an LG webOS TV from the shell",
  "",
  "  lgtv discover              find TVs on the network",
  "  lgtv --host <ip> pair      approve the prompt on the TV once",
  "  lgtv status                see what it is doing",
  "  lgtv volume set 12         change something",
  "  lgtv youtube <url>         play a video on the TV",
  "  lgtv repl                  drive many commands over one connection",
  '  lgtv run "volume set 12"   run a sequence of them, then exit',
  "",
  dim("Run `lgtv --help` for the full command list.")
].join("\n")

export const cli = Command.make(
  "lgtv",
  { host, port, ssl, timeout, json },
  () => Console.log(quickStart)
).pipe(
  Command.withDescription("Control an LG webOS TV over the network"),
  Command.withSubcommands([...subcommands, replCommand, runCommand]),
  Command.provide((options) => Session.layer(options)),
  Command.provide(Settings.Default)
)

export const run = Command.run(cli, {
  name: "lgtv",
  version: VERSION
})
