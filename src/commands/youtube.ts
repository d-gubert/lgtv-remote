import { Args, Command, Options } from "@effect/cli"
import { Effect, Either, Option } from "effect"
import { Uri } from "../domain/ssap.js"
import {
  contentTarget,
  describeTarget,
  launchPayload,
  parseYoutubeTarget,
  youtubeAppId
} from "../domain/youtube.js"
import { withTv } from "../services/Tv.js"
import { cyan, dim, emit, green } from "../ui.js"

const link = Args.text({ name: "url-or-id" }).pipe(
  Args.withDescription(
    "A YouTube link (watch, youtu.be, shorts, live, playlist) or a bare video id"
  )
)

const appId = Options.text("app-id").pipe(
  Options.withDescription(`App to deep-link into (default ${youtubeAppId})`),
  Options.withDefault(youtubeAppId)
)

const start = Options.integer("start").pipe(
  Options.withDescription("Start this many seconds in, overriding any t= in the link"),
  Options.optional
)

export const youtubeCommand = Command.make(
  "youtube",
  { link, appId, start },
  ({ appId, link, start }) =>
    Effect.gen(function* () {
      const parsed = yield* Either.match(parseYoutubeTarget(link), {
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
).pipe(Command.withDescription("Open a YouTube video or playlist in the TV's YouTube app"))
