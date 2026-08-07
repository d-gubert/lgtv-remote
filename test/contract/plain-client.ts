import {
	ContractError,
	type ConnectOptions,
	type Connection,
	type ContractClient,
	type ErrorKind,
	type Payload,
	type ResponseShape,
} from "./client.js";
import {
	connect,
	isSsapError,
	LaunchPoints,
	PointerSocket,
	VolumeStatus,
	type Connection as SsapConnection,
	type Decoder,
	type Payload as SsapPayload,
} from "../../src/sdk/index.js";

/**
 * The Effect-free SDK behind the neutral contract seam.
 *
 * Almost all of this file is the seam's own shape rather than adaptation —
 * `src/sdk` already speaks Promises and throws its failures, so there is little
 * left to translate. That is the point of running it against the same suite as
 * `effect-client.ts`: the two implementations are held to one description of
 * the protocol, and a difference between them shows up as a failing case rather
 * than as a paragraph in a design document.
 */

const toContractError = (error: unknown): ContractError => {
	if (!isSsapError(error)) {
		return new ContractError("Unknown", String(error), error);
	}
	const detailOf = (): string => {
		if (error._tag !== "TvUnreachable") return error.detail;
		return error.cause instanceof Error
			? error.cause.message
			: String(error.cause);
	};
	return new ContractError(error._tag satisfies ErrorKind, detailOf(), error);
};

const rethrow = async <A>(work: () => Promise<A>): Promise<A> => {
	try {
		return await work();
	} catch (error) {
		throw toContractError(error);
	}
};

/** The contract names a shape; this adapter decides it means a `Decoder`. */
const decoders = {
	VolumeStatus,
	LaunchPoints,
	PointerSocket,
} as unknown as Record<ResponseShape, Decoder<unknown>>;

/** Takes the next `count` updates off a subscription, then stops listening. */
const collect = (
	connection: SsapConnection,
	uri: string,
	count: number,
): Promise<ReadonlyArray<Payload>> =>
	new Promise<ReadonlyArray<Payload>>((resolve, reject) => {
		const collected: Array<SsapPayload> = [];
		const subscription = connection.subscribe(uri, {
			onUpdate: (payload) => {
				collected.push(payload);
				if (collected.length < count) return;
				subscription.close();
				resolve(collected as ReadonlyArray<Payload>);
			},
			onError: (error) => reject(toContractError(error)),
		});
	});

export const plainClient: ContractClient = {
	name: "plain",
	connect: async (options: ConnectOptions): Promise<Connection> => {
		const connection = await rethrow(() =>
			connect({
				host: options.host,
				port: options.port,
				timeoutMs: options.timeoutMs,
				...(options.ssl === undefined ? {} : { ssl: options.ssl }),
				...(options.clientKey === undefined
					? {}
					: { clientKey: options.clientKey }),
				...(options.onClientKey === undefined
					? {}
					: { onClientKey: options.onClientKey }),
			}),
		);

		return {
			url: connection.url,
			clientKey: connection.clientKey,
			request: (uri, payload) =>
				rethrow(() => connection.request(uri, payload)) as Promise<Payload>,
			requestAs: (uri, shape, payload) =>
				rethrow(() =>
					connection.requestAs(uri, decoders[shape], payload),
				) as Promise<Payload>,
			subscribe: (uri, count) => collect(connection, uri, count),
			pointer: async () => {
				const input = await rethrow(() => connection.pointer());
				return {
					button: (name) => rethrow(() => input.button(name)),
					click: () => rethrow(() => input.click()),
					move: (dx, dy, drag) => rethrow(() => input.move(dx, dy, drag)),
					scroll: (dx, dy) => rethrow(() => input.scroll(dx, dy)),
				};
			},
			close: () => connection.close(),
		};
	},
};
