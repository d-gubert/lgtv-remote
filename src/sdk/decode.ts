/**
 * A decoder is a function from `unknown` to a value or a reason it is not one.
 *
 * Just enough of a combinator library to state the shapes webOS replies come
 * back in — the SDK carries no schema dependency, and a caller who already has
 * one (zod, valibot, `effect/Schema`) plugs it in by writing a two-line
 * `Decoder`, since the interface is one method.
 *
 * Structs ignore fields they do not mention. SSAP payloads carry firmware- and
 * model-specific extras, and rejecting a reply for saying more than we asked
 * about would break on the next TV.
 */

export type DecodeResult<A> = { readonly ok: true; readonly value: A } | {
  readonly ok: false
  /** Where and why, e.g. `launchPoints[0].id: expected string, got number`. */
  readonly reason: string
}

export interface Decoder<out A> {
  readonly decode: (input: unknown, path?: string) => DecodeResult<A>
}

/** The type a decoder produces — `Infer<typeof VolumeStatus>`. */
export type Infer<D> = D extends Decoder<infer A> ? A : never

const ok = <A>(value: A): DecodeResult<A> => ({ ok: true, value })

const fail = (path: string | undefined, message: string): DecodeResult<never> => ({
  ok: false,
  reason: path === undefined || path === "" ? message : `${path}: ${message}`
})

const typeName = (input: unknown): string =>
  input === null ? "null" : Array.isArray(input) ? "array" : typeof input

const primitive = <A>(expected: string, is: (input: unknown) => boolean): Decoder<A> => ({
  decode: (input, path) =>
    is(input) ? ok(input as A) : fail(path, `expected ${expected}, got ${typeName(input)}`)
})

export const string: Decoder<string> = primitive("string", (i) => typeof i === "string")
export const number: Decoder<number> = primitive(
  "number",
  (i) => typeof i === "number" && Number.isFinite(i)
)
export const boolean: Decoder<boolean> = primitive("boolean", (i) => typeof i === "boolean")

/** Accepts anything, including `undefined`. */
export const unknown: Decoder<unknown> = { decode: (input) => ok(input) }

export const array = <A>(item: Decoder<A>): Decoder<ReadonlyArray<A>> => ({
  decode: (input, path) => {
    if (!Array.isArray(input)) return fail(path, `expected array, got ${typeName(input)}`)
    const values: Array<A> = []
    for (let index = 0; index < input.length; index++) {
      const element = item.decode(input[index], `${path ?? ""}[${index}]`)
      if (!element.ok) return element
      values.push(element.value)
    }
    return ok(values)
  }
})

export const record = <A>(value: Decoder<A>): Decoder<Readonly<Record<string, A>>> => ({
  decode: (input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return fail(path, `expected object, got ${typeName(input)}`)
    }
    const out: Record<string, A> = {}
    for (const [key, raw] of Object.entries(input)) {
      const decoded = value.decode(raw, path === undefined ? key : `${path}.${key}`)
      if (!decoded.ok) return decoded
      out[key] = decoded.value
    }
    return ok(out)
  }
})

// ---- structs ----------------------------------------------------------------

declare const OptionalField: unique symbol

export interface Optional<out A> {
  readonly [OptionalField]: true
  readonly decoder: Decoder<A>
}

/**
 * Marks a field that may be absent. Absent and `undefined` are the same thing
 * here: webOS omits fields it has no answer for, and a couple of endpoints send
 * an explicit `null` for the same idea.
 */
export const optional = <A>(decoder: Decoder<A>): Optional<A> =>
  ({ decoder }) as unknown as Optional<A>

export type Fields = Readonly<Record<string, Decoder<unknown> | Optional<unknown>>>

type ValueOf<F> = F extends Optional<infer A> ? A : F extends Decoder<infer A> ? A : never

type OptionalKeys<F extends Fields> = {
  [K in keyof F]: F[K] extends Optional<unknown> ? K : never
}[keyof F]

type Simplify<T> = { [K in keyof T]: T[K] } & {}

export type StructOf<F extends Fields> = Simplify<
  & { readonly [K in Exclude<keyof F, OptionalKeys<F>>]: ValueOf<F[K]> }
  & { readonly [K in OptionalKeys<F>]?: ValueOf<F[K]> }
>

const isOptional = (field: Decoder<unknown> | Optional<unknown>): field is Optional<unknown> =>
  "decoder" in field

export const struct = <F extends Fields>(fields: F): Decoder<StructOf<F>> => ({
  decode: (input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return fail(path, `expected object, got ${typeName(input)}`)
    }
    const source = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(fields)) {
      const at = path === undefined || path === "" ? key : `${path}.${key}`
      const raw = source[key]
      if (isOptional(field)) {
        // Absent stays absent rather than becoming an explicit `undefined`:
        // the CLI compiles with `exactOptionalPropertyTypes`.
        if (raw === undefined || raw === null) continue
        const decoded = field.decoder.decode(raw, at)
        if (!decoded.ok) return decoded
        out[key] = decoded.value
        continue
      }
      if (raw === undefined) return fail(at, "is missing")
      const decoded = field.decode(raw, at)
      if (!decoded.ok) return decoded
      out[key] = decoded.value
    }
    return ok(out as StructOf<F>)
  }
})

/** A payload with no fields worth naming — every SSAP reply satisfies it. */
export const payload: Decoder<Readonly<Record<string, unknown>>> = record(unknown)
