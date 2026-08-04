import { Either } from "effect"
import { BadInput } from "./errors.js"

/**
 * Splits one `lgtv repl` line into argv-style tokens: whitespace-separated,
 * with `'…'`/`"…"` grouping and `\` escaping, so `toast "Dinner is ready"`
 * and `type "planet earth" --enter` behave the way they would in a shell.
 * Matches `parseMac`'s convention (`src/services/Wol.ts:8`) of returning the
 * failure as data rather than throwing.
 */
export const tokenize = (line: string): Either.Either<ReadonlyArray<string>, BadInput> => {
  const tokens: Array<string> = []
  let current = ""
  let inToken = false
  let quote: "'" | "\"" | undefined
  let i = 0

  const endToken = () => {
    if (inToken) tokens.push(current)
    current = ""
    inToken = false
  }

  while (i < line.length) {
    const ch = line[i]
    if (ch === undefined) break

    if (quote !== undefined) {
      // Shell convention: `\` escapes inside `"…"`, but not inside `'…'`.
      if (ch === "\\" && quote === "\"" && line[i + 1] !== undefined) {
        current += line[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        quote = undefined
        i += 1
        continue
      }
      current += ch
      i += 1
      continue
    }

    if (ch === "'" || ch === "\"") {
      quote = ch
      inToken = true
      i += 1
      continue
    }

    if (ch === "\\" && line[i + 1] !== undefined) {
      current += line[i + 1]
      inToken = true
      i += 2
      continue
    }

    if (ch === " " || ch === "\t") {
      endToken()
      i += 1
      continue
    }

    current += ch
    inToken = true
    i += 1
  }

  if (quote !== undefined) {
    return Either.left(new BadInput({ detail: `Unterminated ${quote} quote.` }))
  }
  endToken()
  return Either.right(tokens)
}
