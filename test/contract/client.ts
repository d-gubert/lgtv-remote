/**
 * The neutral shape of an SSAP client.
 *
 * This is the seam the contract suite tests through. It is deliberately plain
 * — Promises, objects, thrown errors — so the *same* test cases can run against
 * the current Effect implementation and against an Effect-free rewrite at the
 * same time. Nothing in this file may import `effect`.
 *
 * If a behaviour cannot be expressed here, it is not part of the protocol
 * client's contract and belongs in the Effect binding's own tests.
 */

export type Payload = Record<string, unknown>;

/**
 * The failure modes a caller has to be able to tell apart. Adapters map their
 * implementation's errors onto these names; the suite never sees the original.
 */
export type ErrorKind =
	/** The socket never opened, failed, or closed under us. */
	| "TvUnreachable"
	/** The handshake did not produce a client key. */
	| "PairingFailed"
	/** The TV answered, and the answer was a refusal (or never arrived). */
	| "SsapFailed"
	/** The TV answered, but not in the shape the caller asked for. */
	| "UnexpectedResponse"
	/** The adapter could not classify it — always a test failure. */
	| "Unknown";

export class ContractError extends Error {
	constructor(
		readonly kind: ErrorKind,
		readonly detail: string,
		readonly original: unknown,
	) {
		super(`${kind}: ${detail}`);
		this.name = "ContractError";
	}
}

/**
 * Response shapes a client must be able to decode. Named rather than passed as
 * a schema so each adapter can plug in its own decoder — `effect/Schema` today,
 * whatever the rewrite chooses tomorrow — while the suite asserts the same
 * accept/reject behaviour for both.
 */
export type ResponseShape =
	/** All fields optional: almost anything decodes. */
	| "VolumeStatus"
	/** Requires `launchPoints: Array<{ id: string }>`. */
	| "LaunchPoints"
	/** Requires `socketPath: string` — the shape used to prove a decode failure. */
	| "PointerSocket";

export interface Pointer {
	readonly button: (name: string) => Promise<void>;
	readonly click: () => Promise<void>;
	readonly move: (dx: number, dy: number, drag: boolean) => Promise<void>;
	readonly scroll: (dx: number, dy: number) => Promise<void>;
}

export interface Connection {
	readonly url: string;
	/** The key the TV granted for this connection. */
	readonly clientKey: string;
	readonly request: (uri: string, payload?: Payload) => Promise<Payload>;
	readonly requestAs: (
		uri: string,
		shape: ResponseShape,
		payload?: Payload,
	) => Promise<Payload>;
	/**
	 * Subscribes and resolves with the next `count` updates, then stops taking.
	 * Call it *without* awaiting to push updates while it is open.
	 */
	readonly subscribe: (
		uri: string,
		count: number,
	) => Promise<ReadonlyArray<Payload>>;
	/** Opens the Magic-Remote input channel; closed along with the connection. */
	readonly pointer: () => Promise<Pointer>;
	readonly close: () => Promise<void>;
}

export interface ConnectOptions {
	readonly host: string;
	readonly port: number;
	readonly ssl?: boolean;
	/** A key from a previous pairing, if there is one. */
	readonly clientKey?: string;
	readonly timeoutMs: number;
	/** Called with the key the TV granted — how a client hands it back to be stored. */
	readonly onClientKey?: (key: string) => void;
}

export interface ContractClient {
	/** Appears in test names, so a failure says which implementation broke. */
	readonly name: string;
	readonly connect: (options: ConnectOptions) => Promise<Connection>;
}

// ---- helpers the suite shares -----------------------------------------------

/** Asserts `work` fails, and with which kind. Returns the error for detail checks. */
export const failsWith = async (
	kind: ErrorKind,
	work: () => Promise<unknown>,
): Promise<ContractError> => {
	let caught: unknown;
	try {
		await work();
	} catch (error) {
		caught = error;
	}
	if (caught === undefined) {
		throw new Error(`expected the call to fail with ${kind}, but it succeeded`);
	}
	if (!(caught instanceof ContractError)) {
		throw new Error(`expected a ContractError, got ${String(caught)}`);
	}
	if (caught.kind !== kind) {
		throw new Error(`expected ${kind}, got ${caught.kind} (${caught.detail})`);
	}
	return caught;
};

export const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `condition` until it holds — for teardown that completes asynchronously. */
export const eventually = async (
	condition: () => boolean,
	what: string,
	timeoutMs = 2000,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await delay(10);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
};
