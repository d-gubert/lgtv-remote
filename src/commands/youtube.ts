import { Args, Command, Options } from "@effect/cli"
import { Effect, Either, Option } from "effect"
import { BadInput } from "../domain/errors.js"
import { Uri } from "../sdk/index.js"
import {
  contentTarget,
  describeTarget,
  launchPayload,
  parseYoutubeTarget,
  searchTarget,
  youtubeAppId
} from "../domain/youtube.js"
import type { YoutubeTarget } from "../domain/youtube.js"
import { withTv } from "../services/Tv.js"
import { cyan, dim, emit, green } from "../ui.js"

const link = Args.text({ name: "url-or-id" }).pipe(
  Args.withDescription(
    "A YouTube link (watch, youtu.be, shorts, live, playlist) or a bare video id"
  ),
  Args.optional
)

const search = Options.text("search").pipe(
  Options.withDescription("Open the search screen for this query instead of a link"),
  Options.optional
)

const appId = Options.text("app-id").pipe(
  Options.withDescription(`App to deep-link into (default ${youtubeAppId})`),
  Options.withDefault(youtubeAppId)
)

const start = Options.integer("start").pipe(
  Options.withDescription("Start this many seconds in, overriding any t= in the link"),
  Options.optional
)

/** A link and `--search` are two ways to say the same thing, so exactly one is expected. */
const chooseTarget = (
  link: Option.Option<string>,
  search: Option.Option<string>
): Either.Either<YoutubeTarget, BadInput> => {
  if (Option.isSome(search)) {
    if (Option.isNone(link)) return searchTarget(search.value)
    // With no link to fill it, the positional swallows a trailing global flag —
    // `--search x --json` arrives here looking like two targets. `lgtv volume
    // --json` is rejected the same way, so the fix is where the flag goes.
    return Either.left(
      new BadInput({
        detail: link.value.startsWith("-")
          ? `Global flags go before the subcommand: lgtv ${link.value} youtube --search …`
          : "Give a link or --search, not both."
      })
    )
  }
  return Option.isSome(link)
    ? parseYoutubeTarget(link.value)
    : Either.left(
        new BadInput({ detail: `Give a YouTube link or video id, or --search "planet earth".` })
      )
}

export const youtubeCommand = Command.make(
  "youtube",
  { link, search, appId, start },
  ({ appId, link, search, start }) =>
    Effect.gen(function* () {
      if (Option.isSome(search) && Option.isSome(start)) {
        return yield* Effect.fail(
          new BadInput({ detail: "--start applies to a video, not to a search." })
        )
      }
      const parsed = yield* Either.match(chooseTarget(link, search), {
        onLeft: Effect.fail,
        onRight: Effect.succeed
      })
      const target = Option.isSome(start) ? { ...parsed, startSeconds: start.value } : parsed
      const deepLink = contentTarget(target)

      yield* withTv((tv) =>
        Effect.zipRight(
          tv.request(Uri.launch, launchPayload(target, appId)),
          emit(`${green("✓")} Opening ${cyan(describeTarget(target))}\n${dim(deepLink)}`, {
            appId,
            contentTarget: deepLink,
            ...target
          })
        )
      )
    })
).pipe(
  Command.withDescription("Open a YouTube video, playlist, or search in the TV's YouTube app")
)
