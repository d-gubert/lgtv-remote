import { Either } from "effect";

import { BadInput } from "./errors.js";

/**
 * Turning what a person pastes — a share link, a watch URL, a bare id — into
 * the one string the webOS YouTube app understands.
 */

/** The YouTube app on webOS. `lgtv app list` shows it if it is installed. */
export const youtubeAppId = "youtube.leanback.v4";

/** Video ids are always eleven characters of the URL-safe alphabet. */
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

/** Playlist ids vary in length but share the same alphabet and a known prefix. */
const listIdPattern = /^(?:PL|UU|LL|FL|RD|OL|SP)[A-Za-z0-9_-]{10,}$/;

const knownHosts = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtube-nocookie.com",
	"www.youtube-nocookie.com",
	"youtu.be",
	"www.youtu.be",
]);

/** Paths that carry the video id as the segment after the verb. */
const pathVerbs = new Set(["shorts", "embed", "live", "v"]);

export interface YoutubeTarget {
	readonly videoId?: string;
	readonly listId?: string;
	readonly startSeconds?: number;
	/** A search screen rather than a video — see `searchTarget`. */
	readonly query?: string;
}

const fail = (detail: string) => Either.left(new BadInput({ detail }));

/**
 * `t=` shows up as plain seconds (`90`), with a unit (`90s`), or as a duration
 * (`1h2m3s`). Anything else is dropped rather than rejected — a timestamp we
 * cannot read is no reason to refuse to play the video.
 */
const parseStart = (raw: string | null): number | undefined => {
	if (raw === null) return undefined;
	const text = raw.trim().toLowerCase();
	if (/^\d+$/.test(text)) return Number(text);
	const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
	if (match === null || match[0] === "") return undefined;
	const part = (group: string | undefined) =>
		group === undefined ? 0 : Number(group);
	const total = part(match[1]) * 3600 + part(match[2]) * 60 + part(match[3]);
	return total === 0 ? undefined : total;
};

/** `#t=90` is still in circulation alongside the query parameter. */
const startFromHash = (hash: string): string | null => {
	const match = /^#(?:.*&)?t=([^&]+)/.exec(hash);
	return match?.[1] ?? null;
};

const build = (
	videoId: string | undefined,
	listId: string | undefined,
	startSeconds: number | undefined,
): YoutubeTarget => ({
	...(videoId === undefined ? {} : { videoId }),
	...(listId === undefined ? {} : { listId }),
	...(startSeconds === undefined ? {} : { startSeconds }),
});

const parseUrl = (input: string): Either.Either<YoutubeTarget, BadInput> => {
	// People paste `youtu.be/…` without a scheme just as often as with one.
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
		? input
		: `https://${input}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return fail(`Not a YouTube video id or URL: ${input}`);
	}
	if (!knownHosts.has(url.hostname.toLowerCase())) {
		return fail(
			`${url.hostname} is not a YouTube address — expected youtube.com or youtu.be`,
		);
	}

	const segments = url.pathname.split("/").filter((segment) => segment !== "");
	const [head, tail] = segments;
	const resolveFromPath = (): string | undefined => {
		if (url.hostname.toLowerCase().endsWith("youtu.be")) return head;
		if (head !== undefined && pathVerbs.has(head)) return tail;
		return undefined;
	};
	const fromPath = resolveFromPath();

	const videoId = url.searchParams.get("v") ?? fromPath;
	const listId = url.searchParams.get("list") ?? undefined;
	const startSeconds = parseStart(
		url.searchParams.get("t") ??
			url.searchParams.get("start") ??
			startFromHash(url.hash),
	);

	if (videoId !== undefined && !videoIdPattern.test(videoId)) {
		return fail(
			`"${videoId}" is not a valid YouTube video id (expected 11 characters)`,
		);
	}
	if (listId !== undefined && !listIdPattern.test(listId)) {
		return fail(`"${listId}" is not a valid YouTube playlist id`);
	}
	if (videoId === undefined && listId === undefined) {
		return fail(`No video or playlist id found in ${input}`);
	}
	return Either.right(build(videoId, listId, startSeconds));
};

/**
 * Accepts a watch URL, a `youtu.be` share link, `/shorts`, `/embed`, `/live`,
 * a playlist URL, or a bare video or playlist id.
 */
export const parseYoutubeTarget = (
	input: string,
): Either.Either<YoutubeTarget, BadInput> => {
	const text = input.trim();
	if (text === "") return fail("Expected a YouTube URL or video id");
	// A bare id has no separators, so anything with one is treated as a URL —
	// that keeps a malformed link an error instead of a confusing "not an id".
	if (!/[/?&#]/.test(text) && !text.includes(".")) {
		if (videoIdPattern.test(text))
			return Either.right(build(text, undefined, undefined));
		if (listIdPattern.test(text))
			return Either.right(build(undefined, text, undefined));
		return fail(`"${text}" is not a YouTube video id, playlist id, or URL`);
	}
	return parseUrl(text);
};

/**
 * Opening the search screen with the query already filled in. There is no deep
 * link to an *empty* search box: the app drops an empty `q` and stays wherever
 * it was, so an all-whitespace query is refused rather than sent.
 */
export const searchTarget = (
	query: string,
): Either.Either<YoutubeTarget, BadInput> => {
	const text = query.trim();
	if (text === "") return fail("Expected something to search for");
	return Either.right({ query: text });
};

/**
 * The deep link the app expects. Its `deeplinkingParams` template is
 * `{"contentTarget": "$CONTENTID"}`, and the leanback front end reads `v`,
 * `list`, `t` and `q` off this URL.
 */
export const contentTarget = (target: YoutubeTarget): string => {
	const params = new URLSearchParams();
	if (target.query !== undefined) params.set("q", target.query);
	if (target.videoId !== undefined) params.set("v", target.videoId);
	if (target.listId !== undefined) params.set("list", target.listId);
	if (target.startSeconds !== undefined && target.startSeconds > 0) {
		params.set("t", String(target.startSeconds));
	}
	// `q` is the only parameter that can hold a space, and the spelling verified
	// against the app is `%20`. `URLSearchParams` writes `+`, which is equally
	// legal but untried on a TV, so rewrite it — no id or offset can contain one.
	return `https://www.youtube.com/tv?${params.toString().replaceAll("+", "%20")}`;
};

/**
 * The `system.launcher/launch` payload that opens a target.
 *
 * `contentId` and `params` are two firmware generations of the same thing: the
 * launcher substitutes `contentId` into the app's `deeplinkingParams` template,
 * while builds that do not do the substitution honour an explicit `params`.
 * Both carry the identical URL, so whichever the TV reads, the app opens the
 * same video.
 */
export const launchPayload = (
	target: YoutubeTarget,
	appId: string = youtubeAppId,
): Record<string, unknown> => {
	const deepLink = contentTarget(target);
	return {
		id: appId,
		contentId: deepLink,
		params: { contentTarget: deepLink },
	};
};

/** What to call this target in a one-line confirmation. */
export const describeTarget = (target: YoutubeTarget): string =>
	target.query !== undefined
		? `search for ${JSON.stringify(target.query)}`
		: (target.videoId ?? `playlist ${target.listId ?? "?"}`);
