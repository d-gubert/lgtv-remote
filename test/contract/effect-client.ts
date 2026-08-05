import {
  Cause,
  Chunk,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
  Stream,
} from "effect";

import {
  ContractError,
  type ConnectOptions,
  type Connection,
  type ContractClient,
  type ErrorKind,
  type Payload,
  type ResponseShape,
} from "./client.js";
import { TvNotConfigured } from "../../src/domain/errors.js";
import {
  LaunchPoints,
  PointerSocket,
  VolumeStatus,
  type Decoder,
} from "../../src/sdk/index.js";
import { Session, type SessionApi } from "../../src/services/Session.js";
import { connect, type Tv } from "../../src/services/Tv.js";

/**
 * The current, Effect-based implementation behind the neutral contract seam.
 *
 * Note what it does *not* do: no `Settings`, no filesystem, no `NodeContext`.
 * `SessionApi` is an interface, so the adapter hands `connect` a literal one —
 * which is the point. The contract covers the protocol client alone; where the
 * client key gets stored is the CLI's problem, and here it is just the
 * `onClientKey` callback.
 *
 * When the Effect-free SDK exists, write a sibling `plain-client.ts` with the
 * same shape and add it to `test/contract.test.ts`. Both run green until the
 * Effect binding is retired, at which point this file is deleted — the suite is
 * untouched.
 */

const KNOWN_KINDS = new Set<string>([
  "TvUnreachable",
  "PairingFailed",
  "SsapFailed",
  "UnexpectedResponse",
]);

const toContractError = (error: unknown): ContractError => {
  const tag = (error as { _tag?: unknown } | undefined)?._tag;
  if (typeof tag === "string" && KNOWN_KINDS.has(tag)) {
    const fields = error as { detail?: unknown; cause?: unknown };
    const detailOf = (): string => {
      if (fields.detail !== undefined) return String(fields.detail);
      if (fields.cause instanceof Error) return fields.cause.message;
      return String(fields.cause ?? "");
    };
    return new ContractError(tag as ErrorKind, detailOf(), error);
  }
  return new ContractError("Unknown", String(error), error);
};

const runOrThrow = async <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw toContractError(Cause.squash(exit.cause));
};

/**
 * The contract names a shape; each adapter decides what that means. The
 * erasure to `unknown` is the whole point — the suite must not know.
 */
const decoders = {
  VolumeStatus,
  LaunchPoints,
  PointerSocket,
} as unknown as Record<ResponseShape, Decoder<unknown>>;

const sessionLayer = (options: ConnectOptions) => {
  const secure = options.ssl ?? false;
  const api: SessionApi = {
    json: false,
    timeout: Duration.millis(options.timeoutMs),
    host: Effect.succeed(options.host),
    ssl: Effect.succeed(secure),
    wsUrl: Effect.succeed(
      `${secure ? "wss" : "ws"}://${options.host}:${options.port}`,
    ),
    clientKey: Effect.succeed(Option.fromNullable(options.clientKey)),
    mac: Effect.fail(new TvNotConfigured({ missing: "mac" })),
    rememberKey: (_host, key) => Effect.sync(() => options.onClientKey?.(key)),
  };
  return Layer.succeed(Session, api);
};

export const effectClient: ContractClient = {
  name: "effect",
  connect: async (options: ConnectOptions): Promise<Connection> => {
    const layer = sessionLayer(options);
    const scope = await Effect.runPromise(Scope.make());

    const run = <A, E>(effect: Effect.Effect<A, E, Session>): Promise<A> =>
      runOrThrow(Effect.provide(effect, layer));

    /** Binds a scoped effect to this connection's lifetime rather than its own. */
    const runScoped = <A, E>(
      effect: Effect.Effect<A, E, Session | Scope.Scope>,
    ): Promise<A> => run(Scope.extend(effect, scope));

    let tv: Tv;
    try {
      tv = await runScoped(connect({ announcePairing: false }));
    } catch (error) {
      // A handshake that fails still opened a socket; do not leak it.
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }

    return {
      url: tv.url,
      clientKey: tv.clientKey,
      request: (uri, payload) =>
        run(tv.request(uri, payload)) as Promise<Payload>,
      requestAs: (uri, shape, payload) =>
        run(tv.requestAs(uri, decoders[shape], payload)).then(
          (decoded) => decoded as Payload,
        ),
      subscribe: async (uri, count) => {
        const chunk = await run(
          Stream.runCollect(Stream.take(tv.subscribe(uri), count)),
        );
        return Chunk.toReadonlyArray(chunk) as ReadonlyArray<Payload>;
      },
      pointer: async () => {
        const input = await runScoped(tv.pointer);
        return {
          button: (name) => run(input.button(name)),
          click: () => run(input.click),
          move: (dx, dy, drag) => run(input.move(dx, dy, drag)),
          scroll: (dx, dy) => run(input.scroll(dx, dy)),
        };
      },
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  },
};
