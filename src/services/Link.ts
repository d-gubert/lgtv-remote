import { Effect, Exit, Option, Ref, Scope } from "effect";

import type { Session } from "./Session.js";
import type { ConnectError, Tv } from "./Tv.js";
import { connect } from "./Tv.js";

export interface Link {
  /** The live connection, opening (or re-opening) one if needed. */
  readonly tv: Effect.Effect<Tv, ConnectError, Session>;
  /** Forget the current connection; the next `tv` opens a fresh one. */
  readonly reset: Effect.Effect<void>;
}

interface Generation {
  readonly tv: Tv;
  readonly scope: Scope.CloseableScope;
}

const closeGeneration = (generation: Generation) =>
  Scope.close(generation.scope, Exit.succeed(undefined));

/**
 * Holds one live connection open across many commands, replacing it on
 * demand. Scoped to the repl session: closing the returned scope closes
 * whatever generation is current.
 */
export const make: Effect.Effect<Link, never, Scope.Scope> = Effect.gen(
  function* () {
    const current = yield* Ref.make(Option.none<Generation>());

    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(current), (generation) =>
        Option.isSome(generation)
          ? closeGeneration(generation.value)
          : Effect.void,
      ),
    );

    const open: Effect.Effect<Generation, ConnectError, Session> = Effect.gen(
      function* () {
        const scope = yield* Scope.make();
        // `Scope.extend` does not close `scope` on failure, so without `onError`
        // a failed `connect()` would strand a half-open socket.
        const tv = yield* Scope.extend(connect(), scope).pipe(
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        );
        const generation: Generation = { tv, scope };
        yield* Ref.set(current, Option.some(generation));
        return generation;
      },
    );

    // A plain `Ref`, not a `SynchronizedRef`, is safe only because the repl
    // loop awaits each line before reading the next, so nothing calls `tv`
    // concurrently — worth keeping in mind if that invariant ever changes.
    const tv: Effect.Effect<Tv, ConnectError, Session> = Effect.gen(
      function* () {
        const existing = yield* Ref.get(current);
        if (Option.isNone(existing)) return (yield* open).tv;

        // Pre-flight: the pump already knows if the TV went to standby between
        // lines, so a dead generation is discarded before we try to use it —
        // without this, the first command after standby always fails even
        // though a reconnect would have worked.
        const reason = yield* existing.value.tv.closed;
        if (Option.isNone(reason)) return existing.value.tv;

        yield* closeGeneration(existing.value);
        yield* Ref.set(current, Option.none());
        return (yield* open).tv;
      },
    );

    const reset: Effect.Effect<void> = Effect.gen(function* () {
      const existing = yield* Ref.get(current);
      yield* Ref.set(current, Option.none());
      if (Option.isSome(existing)) yield* closeGeneration(existing.value);
    });

    return { tv, reset };
  },
);
