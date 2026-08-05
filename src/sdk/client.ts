import WebSocket from "ws";

import type { Decoder } from "./decode.js";
import {
	PairingFailed,
	SsapFailed,
	TvUnreachable,
	UnexpectedResponse,
} from "./errors.js";
import { pairingManifest } from "./pairing.js";
import { PointerSocket } from "./responses.js";
import { Uri } from "./uri.js";

/**
 * The SSAP protocol client: one websocket to a webOS TV, the pairing
 * handshake, and requests, subscriptions and Magic-Remote input multiplexed
 * over it. Promises in, Promises out — no framework, `ws` is the only runtime
 * dependency.
 *
 *     const tv = await connect({ host: "192.168.0.230" })
 *     await tv.request(Uri.setVolume, { volume: 20 })
 *     await tv.close()
 *
 * Everything about *where* a client key is stored, how the user is told to look
 * at the screen, or how a TV is discovered lives outside this file. It reports
 * the key it was granted and calls back when the user has to accept a prompt;
 * what to do about either is the caller's business.
 */

export type Payload = Readonly<Record<string, unknown>>;

/** Frames the TV sends back on the main socket. */
interface IncomingFrame {
	readonly type: string;
	readonly id?: string;
	readonly error?: string;
	readonly payload?: unknown;
}

/** What the message pump hands to whoever is waiting on a frame id. */
type Delivery =
	| { readonly _tag: "Frame"; readonly frame: IncomingFrame }
	| { readonly _tag: "Closed"; readonly reason: string };

type Listener = (delivery: Delivery) => void;

const DEFAULT_TIMEOUT_MS = 10_000;

/** A human has to walk to the TV, so pairing never uses the request timeout. */
const MIN_PAIRING_TIMEOUT_MS = 60_000;

/**
 * Junk on the wire is dropped, not raised — this runs inside a `ws` listener,
 * where a throw is an uncaught exception. `type` must be a string for the frame
 * to mean anything, and an `id` that is not one can never match a waiter.
 */
const asFrame = (input: unknown): IncomingFrame | undefined => {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		return undefined;
	const frame = input as Record<string, unknown>;
	if (typeof frame.type !== "string") return undefined;
	if (frame.id !== undefined && typeof frame.id !== "string") return undefined;
	if (frame.error !== undefined && typeof frame.error !== "string")
		return undefined;
	return frame as unknown as IncomingFrame;
};

const abortReason = (signal: AbortSignal): unknown =>
	signal.reason ?? new Error("the operation was aborted");

/** Opens a websocket, or rejects with `TvUnreachable`. */
const openSocket = (
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<WebSocket> =>
	new Promise<WebSocket>((resolve, reject) => {
		const socket = new WebSocket(url, {
			// webOS presents a self-signed certificate on the secure port.
			rejectUnauthorized: false,
			handshakeTimeout: timeoutMs,
		});
		const detach = () => {
			socket.off("open", onOpen);
			socket.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const onOpen = () => {
			detach();
			if (signal?.aborted === true) {
				socket.terminate();
				reject(abortReason(signal));
				return;
			}
			resolve(socket);
		};
		const onError = (cause: Error) => {
			detach();
			socket.terminate();
			reject(new TvUnreachable(url, cause));
		};
		const onAbort = () => {
			detach();
			socket.terminate();
			reject(abortReason(signal as AbortSignal));
		};
		socket.once("open", onOpen);
		socket.once("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const sendText = (
	socket: WebSocket,
	url: string,
	data: string,
): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		// `ws` hands the stream's callback straight through, so success arrives as
		// `null` rather than `undefined`.
		socket.send(data, (cause) => {
			if (cause === undefined || cause === null) resolve();
			else reject(new TvUnreachable(url, cause));
		});
	});

/** Demultiplexes incoming frames by their request id. */
const startPump = (socket: WebSocket) => {
	const listeners = new Map<string, Listener>();
	let closed: string | undefined;

	const shutdown = (reason: string) => {
		if (closed !== undefined) return;
		closed = reason;
		for (const listener of [...listeners.values()]) {
			listener({ _tag: "Closed", reason });
		}
		listeners.clear();
	};

	socket.on("message", (raw) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(raw));
		} catch {
			return;
		}
		const frame = asFrame(parsed);
		if (frame?.id === undefined) return;
		listeners.get(frame.id)?.({ _tag: "Frame", frame });
	});
	socket.on("close", (code) =>
		shutdown(`connection closed by the TV (code ${code})`),
	);
	socket.on("error", (cause: Error) => shutdown(cause.message));

	return {
		isClosed: () => closed,
		shutdown,
		/** Fires straight away with `Closed` if the socket has already gone. */
		register: (id: string, listener: Listener) => {
			if (closed !== undefined) {
				listener({ _tag: "Closed", reason: closed });
				return;
			}
			listeners.set(id, listener);
		},
		unregister: (id: string) => listeners.delete(id),
	};
};

/** Turns one delivery into a payload, or throws the reason it is not one. */
const interpret = (url: string, uri: string, delivery: Delivery): Payload => {
	if (delivery._tag === "Closed") throw new TvUnreachable(url, delivery.reason);
	const { frame } = delivery;
	if (frame.type === "error") {
		throw new SsapFailed(uri, frame.error ?? "unspecified error");
	}
	const payload = (frame.payload ?? {}) as Payload;
	if (payload.returnValue === false) {
		const detail =
			payload.errorText ?? payload.errorCode ?? "the TV returned no reason";
		throw new SsapFailed(uri, String(detail));
	}
	return payload;
};

// ---- public surface ---------------------------------------------------------

export interface CallOptions {
	/** Overrides the connection's timeout for this call. */
	readonly timeoutMs?: number;
	/** Aborting rejects the call and stops waiting for the reply. */
	readonly signal?: AbortSignal;
}

export interface Pointer {
	readonly button: (name: string) => Promise<void>;
	readonly click: () => Promise<void>;
	readonly move: (dx: number, dy: number, drag: boolean) => Promise<void>;
	readonly scroll: (dx: number, dy: number) => Promise<void>;
}

export interface SubscriptionListener {
	readonly onUpdate: (payload: Payload) => void;
	/**
	 * Terminal: the TV refused the subscription or the socket died. Nothing
	 * further arrives, and the subscription is already closed.
	 */
	readonly onError: (error: SsapFailed | TvUnreachable) => void;
}

export interface Subscription {
	/** Stops delivering. The TV is not told; see the note on `subscribe`. */
	readonly close: () => void;
}

/** A subscription being consumed with `for await`. */
export interface Updates extends AsyncIterable<Payload> {
	readonly close: () => void;
}

export interface ConnectOptions {
	/** Where the TV is. Also what the connection reports as its `host`. */
	readonly host: string;
	/** Defaults to 3001 when `ssl` is on, 3000 otherwise. */
	readonly port?: number;
	readonly ssl?: boolean;
	/**
	 * Dial this exactly, ignoring `port` and `ssl`. For callers that resolve the
	 * address themselves; `host` is still required, for reporting.
	 */
	readonly url?: string;
	/** A key from a previous pairing. Without one the TV prompts the user. */
	readonly clientKey?: string;
	/** Per-request timeout, in milliseconds. Default 10s. */
	readonly timeoutMs?: number;
	/**
	 * How long to wait for the user to accept the pairing prompt. Never less
	 * than 60s, because a person has to walk to the TV.
	 */
	readonly pairingTimeoutMs?: number;
	/** The TV has put the pairing dialog on screen. Called at most once. */
	readonly onPairingPrompt?: () => void;
	/** Called with a granted key that differs from the one offered — store it. */
	readonly onClientKey?: (key: string) => void;
	/** Aborting gives up on the connection and closes whatever was opened. */
	readonly signal?: AbortSignal;
}

export interface Connection {
	readonly url: string;
	readonly host: string;
	/** The key this connection is authenticated with. */
	readonly clientKey: string;
	/** The TV granted a different key than the one offered: worth storing. */
	readonly keyChanged: boolean;
	/** Why the connection is gone, or `undefined` while it is alive. */
	readonly closed: string | undefined;
	readonly request: (
		uri: string,
		payload?: Payload,
		options?: CallOptions,
	) => Promise<Payload>;
	/** `request`, narrowed to a shape — see `responses.ts` for the ones on offer. */
	readonly requestAs: <A>(
		uri: string,
		decoder: Decoder<A>,
		payload?: Payload,
		options?: CallOptions,
	) => Promise<A>;
	/**
	 * Subscribes to a uri. The TV answers immediately with the current value and
	 * then pushes every change, so the first `onUpdate` is not a change.
	 *
	 * `close()` stops delivery on this side; there is no unsubscribe frame in
	 * SSAP, so the TV keeps pushing until the connection closes.
	 */
	readonly subscribe: (
		uri: string,
		listener: SubscriptionListener,
	) => Subscription;
	/** `subscribe` as an async iterable. Break out of the loop, or `close()`. */
	readonly updates: (uri: string) => Updates;
	/**
	 * The Magic-Remote input channel — a second socket that takes buttons and
	 * cursor movement rather than SSAP. Opened on first use, shared afterwards,
	 * and closed with the connection.
	 */
	readonly pointer: (options?: CallOptions) => Promise<Pointer>;
	readonly close: () => Promise<void>;
}

/**
 * Connects, completes the webOS handshake, and hands back a live connection.
 *
 * Rejects with `TvUnreachable` if the socket never opened and `PairingFailed`
 * if the handshake did not produce a client key — including when the user
 * ignores the prompt until `pairingTimeoutMs` runs out.
 */
export const connect = async (options: ConnectOptions): Promise<Connection> => {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const secure = options.ssl ?? false;
	const url =
		options.url ??
		`${secure ? "wss" : "ws"}://${options.host}:${options.port ?? (secure ? 3001 : 3000)}`;

	const socket = await openSocket(url, timeoutMs, options.signal);
	const pump = startPump(socket);

	/** Every socket this connection owns, so `close` can take them all down. */
	const sockets = new Set<WebSocket>([socket]);
	let closing = false;

	let counter = 0;
	const nextId = () => `lgtv-${++counter}`;

	/**
	 * The main socket is demultiplexed, so a failed write has a natural home: it
	 * means the socket is broken, and every waiter needs to hear that rather than
	 * only the one whose frame failed.
	 */
	const send = (frame: Record<string, unknown>) => {
		sendText(socket, url, JSON.stringify(frame)).catch((error: unknown) => {
			pump.shutdown(error instanceof Error ? error.message : String(error));
		});
	};

	/** Waits for one frame on `id`, cleaning up whichever way it ends. */
	const awaitReply = (
		id: string,
		uri: string,
		callTimeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<Payload> =>
		new Promise<Payload>((resolve, reject) => {
			let settled = false;
			const settle = (deliver: () => void) => {
				if (settled) return;
				settled = true;
				pump.unregister(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				deliver();
			};
			const timer = setTimeout(
				() =>
					settle(() =>
						reject(
							new SsapFailed(uri, `no reply within ${callTimeoutMs / 1000}s`),
						),
					),
				callTimeoutMs,
			);
			const onAbort = () =>
				settle(() => reject(abortReason(signal as AbortSignal)));
			signal?.addEventListener("abort", onAbort, { once: true });
			// Registering can fire straight away on a dead socket, so `timer` and
			// `onAbort` have to exist before this line.
			pump.register(id, (delivery) =>
				settle(() => {
					try {
						resolve(interpret(url, uri, delivery));
					} catch (error) {
						reject(error);
					}
				}),
			);
		});

	const request = (
		uri: string,
		payload?: Payload,
		callOptions?: CallOptions,
	) => {
		const id = nextId();
		const reply = awaitReply(
			id,
			uri,
			callOptions?.timeoutMs ?? timeoutMs,
			callOptions?.signal,
		);
		send({
			id,
			type: "request",
			uri,
			...(payload === undefined ? {} : { payload }),
		});
		return reply;
	};

	const requestAs = async <A>(
		uri: string,
		decoder: Decoder<A>,
		payload?: Payload,
		callOptions?: CallOptions,
	): Promise<A> => {
		const result = decoder.decode(await request(uri, payload, callOptions));
		if (!result.ok) throw new UnexpectedResponse(uri, result.reason);
		return result.value;
	};

	const subscribe = (
		uri: string,
		listener: SubscriptionListener,
	): Subscription => {
		const id = nextId();
		let live = true;
		const close = () => {
			if (!live) return;
			live = false;
			pump.unregister(id);
		};
		pump.register(id, (delivery) => {
			if (!live) return;
			let payload: Payload;
			try {
				payload = interpret(url, uri, delivery);
			} catch (error) {
				// A refusal or a dead socket ends the subscription; anything the
				// listener itself throws is the listener's problem, not the stream's.
				close();
				listener.onError(error as SsapFailed | TvUnreachable);
				return;
			}
			listener.onUpdate(payload);
		});
		send({ id, type: "subscribe", uri });
		return { close };
	};

	/**
	 * `subscribe` buffered into an async iterable. Updates that arrive while
	 * nothing is awaiting are queued rather than dropped, so a slow consumer
	 * falls behind instead of missing changes.
	 */
	const updates = (uri: string): Updates => {
		type Waiter = {
			readonly resolve: (result: IteratorResult<Payload>) => void;
			readonly reject: (error: unknown) => void;
		};
		const buffered: Array<Payload> = [];
		let waiter: Waiter | undefined;
		/** Set once, and delivered to whoever asks next — then the iterable ends. */
		let failure: unknown;
		let ended = false;

		/** Hands the pending `next()` its answer, whatever kind of answer it is. */
		const takeWaiter = (): Waiter | undefined => {
			const pending = waiter;
			waiter = undefined;
			return pending;
		};

		const subscription = subscribe(uri, {
			onUpdate: (payload) => {
				const pending = takeWaiter();
				if (pending === undefined) buffered.push(payload);
				else pending.resolve({ done: false, value: payload });
			},
			onError: (error) => {
				ended = true;
				const pending = takeWaiter();
				// Buffered updates are still worth having; the failure waits its turn.
				if (pending === undefined || buffered.length > 0) failure = error;
				else pending.reject(error);
			},
		});

		const close = () => {
			ended = true;
			failure = undefined;
			subscription.close();
			takeWaiter()?.resolve({ done: true, value: undefined });
		};

		const iterator: AsyncIterator<Payload> = {
			next: () => {
				const next = buffered.shift();
				if (next !== undefined)
					return Promise.resolve({ done: false, value: next });
				if (failure !== undefined) {
					const error = failure;
					failure = undefined;
					return Promise.reject(error);
				}
				if (ended) return Promise.resolve({ done: true, value: undefined });
				return new Promise<IteratorResult<Payload>>((resolve, reject) => {
					waiter = { resolve, reject };
				});
			},
			// Called by `break`, `return` and `throw` inside a `for await`.
			return: () => {
				close();
				return Promise.resolve({ done: true, value: undefined });
			},
		};

		return { [Symbol.asyncIterator]: () => iterator, close };
	};

	// ---- Magic Remote channel -------------------------------------------------

	let pointerChannel: Promise<Pointer> | undefined;

	const openPointer = async (callOptions?: CallOptions): Promise<Pointer> => {
		const { socketPath } = await requestAs(
			Uri.pointerSocket,
			PointerSocket,
			undefined,
			callOptions,
		);
		const input = await openSocket(socketPath, timeoutMs, callOptions?.signal);
		if (closing) {
			input.terminate();
			throw new TvUnreachable(socketPath, "the connection was closed");
		}
		sockets.add(input);
		const write = (frame: string) => sendText(input, socketPath, frame);
		return {
			button: (name: string) => write(`type:button\nname:${name}\n\n`),
			click: () => write("type:click\n\n"),
			move: (dx: number, dy: number, drag: boolean) =>
				write(`type:move\ndx:${dx}\ndy:${dy}\ndown:${drag ? 1 : 0}\n\n`),
			scroll: (dx: number, dy: number) =>
				write(`type:scroll\ndx:${dx}\ndy:${dy}\n\n`),
		};
	};

	/**
	 * Memoised on success only. Caching the rejection instead would make one
	 * refusal — a TV that was busy, a socket that lost a race — permanent for the
	 * life of the connection.
	 */
	const pointer = (callOptions?: CallOptions): Promise<Pointer> => {
		if (pointerChannel === undefined) {
			const attempt = openPointer(callOptions);
			// Forgetting a failed attempt through a *separate* handler, so `attempt`
			// counts as handled even when the caller walks away from it. Rethrowing
			// into the memoised promise instead would leave an unhandled rejection
			// behind every abandoned `key` press.
			attempt.catch(() => {
				if (pointerChannel === attempt) pointerChannel = undefined;
			});
			pointerChannel = attempt;
		}
		return pointerChannel;
	};

	const close = async (): Promise<void> => {
		closing = true;
		pump.shutdown("the connection was closed");
		for (const open of sockets) {
			open.removeAllListeners();
			open.close();
		}
		sockets.clear();
	};

	// ---- handshake ------------------------------------------------------------

	const registerId = "register_0";

	const handshake = new Promise<string>((resolve, reject) => {
		let settled = false;
		let announced = false;
		const settle = (deliver: () => void) => {
			if (settled) return;
			settled = true;
			pump.unregister(registerId);
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			deliver();
		};
		const timer = setTimeout(
			() =>
				settle(() =>
					reject(new PairingFailed(url, "timed out waiting for approval")),
				),
			Math.max(
				options.pairingTimeoutMs ?? 0,
				timeoutMs,
				MIN_PAIRING_TIMEOUT_MS,
			),
		);
		const onAbort = () =>
			settle(() => reject(abortReason(options.signal as AbortSignal)));
		options.signal?.addEventListener("abort", onAbort, { once: true });

		pump.register(registerId, (delivery) => {
			if (delivery._tag === "Closed") {
				settle(() => reject(new PairingFailed(url, delivery.reason)));
				return;
			}
			const { frame } = delivery;
			if (frame.type === "error") {
				settle(() =>
					reject(
						new PairingFailed(
							url,
							frame.error ?? "the TV rejected the handshake",
						),
					),
				);
				return;
			}
			if (frame.type === "registered") {
				const key = (frame.payload as Record<string, unknown> | undefined)?.[
					"client-key"
				];
				settle(() =>
					typeof key === "string"
						? resolve(key)
						: reject(new PairingFailed(url, "the TV returned no client key")),
				);
				return;
			}
			// Any other frame here means the TV is showing the pairing dialog. The
			// exact shape has changed across firmware, so it is not inspected.
			if (!announced) {
				announced = true;
				options.onPairingPrompt?.();
			}
		});
	});

	send({
		id: registerId,
		type: "register",
		payload: {
			...pairingManifest,
			...(options.clientKey === undefined
				? {}
				: { "client-key": options.clientKey }),
		},
	});

	let clientKey: string;
	try {
		clientKey = await handshake;
	} catch (error) {
		// A handshake that failed still opened a socket; do not leak it.
		await close();
		throw error;
	}

	const keyChanged = clientKey !== options.clientKey;
	if (keyChanged) options.onClientKey?.(clientKey);

	return {
		url,
		host: options.host,
		clientKey,
		keyChanged,
		get closed() {
			return pump.isClosed();
		},
		request,
		requestAs,
		subscribe,
		updates,
		pointer,
		close,
	};
};
