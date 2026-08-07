/**
 * Everything the protocol client can fail with, as ordinary `Error`s.
 *
 * Each carries a `_tag` naming the failure, so a caller can switch on it
 * without a chain of `instanceof`s, and so a binding for another effect system
 * can map them mechanically. The tags match the CLI's own error names on
 * purpose — `src/services/Tv.ts` translates one into the other by tag.
 */

export type SsapErrorTag =
	| "TvUnreachable"
	| "PairingFailed"
	| "SsapFailed"
	| "UnexpectedResponse";

/** The base every failure below extends, so `instanceof` catches all of them. */
export abstract class SsapError extends Error {
	abstract readonly _tag: SsapErrorTag;
}

const describe = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

/** The socket never opened, failed, or closed under us. */
export class TvUnreachable extends SsapError {
	readonly _tag = "TvUnreachable";

	/** Whatever `ws` reported, or a description of how the socket ended. */
	override readonly cause: unknown;

	constructor(
		readonly url: string,
		cause: unknown,
	) {
		super(`could not reach ${url}: ${describe(cause)}`);
		this.name = "TvUnreachable";
		this.cause = cause;
	}
}

/** The handshake ended without a client key: refused, dropped, or timed out. */
export class PairingFailed extends SsapError {
	readonly _tag = "PairingFailed";

	constructor(
		readonly url: string,
		readonly detail: string,
	) {
		super(`pairing with ${url} failed: ${detail}`);
		this.name = "PairingFailed";
	}
}

/**
 * The TV answered and the answer was a refusal — an `error` frame, or a
 * response carrying `returnValue: false`. A request that is never answered
 * fails this way too, since the TV accepted it and simply said nothing.
 */
export class SsapFailed extends SsapError {
	readonly _tag = "SsapFailed";

	constructor(
		readonly uri: string,
		readonly detail: string,
	) {
		super(`the TV refused ${uri}: ${detail}`);
		this.name = "SsapFailed";
	}
}

/** The TV answered, but not in the shape the caller asked to decode. */
export class UnexpectedResponse extends SsapError {
	readonly _tag = "UnexpectedResponse";

	constructor(
		readonly uri: string,
		readonly detail: string,
	) {
		super(`the reply to ${uri} was not in the expected shape: ${detail}`);
		this.name = "UnexpectedResponse";
	}
}

/**
 * Every failure as one union, so a `switch` on `_tag` narrows to the fields
 * that tag carries. `SsapError` is the class to catch; this is the type to
 * handle.
 */
export type AnySsapError =
	| TvUnreachable
	| PairingFailed
	| SsapFailed
	| UnexpectedResponse;

export const isSsapError = (error: unknown): error is AnySsapError =>
	error instanceof SsapError;
