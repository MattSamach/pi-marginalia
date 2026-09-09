import { randomBytes } from "node:crypto";

export const THREAD_LIMITS = Object.freeze({
	maxBodyBytes: 256 * 1024,
	maxThreads: 200,
	maxTurnsPerThread: 50,
	maxFieldLength: 20_000,
});

function validText(value, limits) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= limits.maxFieldLength;
}

function validRange(start, end) {
	return (start === undefined && end === undefined) || (Number.isInteger(start) && start > 0 && Number.isInteger(end) && end >= start);
}

/** Live comment-thread store for one immutable review snapshot. */
export function createThreadStore(review, limits = THREAD_LIMITS) {
	const threads = new Map();
	const files = new Map(review.files.map((file) => [file.path, file]));
	const commentaryThreadIds = new Map();
	let overviewThreadId;
	let counter = 0;
	const storeSalt = randomBytes(3).toString("hex");

	const publicThread = (thread) => ({ ...thread, turns: thread.turns.map((turn) => ({ ...turn })) });
	const lastAuthor = (thread) => thread.turns[thread.turns.length - 1]?.author;

	function validateSelection(item) {
		const file = files.get(item.file);
		if (!file || file.binary || file.omitted || !["old", "new", "both"].includes(item.side)) return undefined;
		if (!validRange(item.oldStart, item.oldEnd) || !validRange(item.newStart, item.newEnd)) return undefined;
		if (item.oldStart === undefined && item.newStart === undefined) return undefined;
		if (item.side === "old" && (item.oldStart === undefined || item.newStart !== undefined)) return undefined;
		if (item.side === "new" && (item.newStart === undefined || item.oldStart !== undefined)) return undefined;
		const visible = (key, start, end) => start === undefined || [start, end].every((boundary) => file.lines.some((line) => line[key] === boundary));
		if (!visible("oldLine", item.oldStart, item.oldEnd) || !visible("newLine", item.newStart, item.newEnd)) return undefined;
		if (!validText(item.highlight, limits)) return undefined;
		return {
			file: item.file,
			side: item.side,
			...(item.oldStart === undefined ? {} : { oldStart: item.oldStart, oldEnd: item.oldEnd }),
			...(item.newStart === undefined ? {} : { newStart: item.newStart, newEnd: item.newEnd }),
			highlight: item.highlight.trim(),
		};
	}

	function createThread(fields, turns) {
		if (threads.size >= limits.maxThreads) return { error: "too-many-threads" };
		const thread = { id: `${review.id.slice(0, 8)}-${storeSalt}-t${++counter}`, status: "open", piProposedResolve: false, ...fields, turns };
		threads.set(thread.id, thread);
		return { thread: publicThread(thread), created: true };
	}

	function appendTurn(thread, author, body, ts) {
		if (thread.turns.length >= limits.maxTurnsPerThread) return { error: "thread-full" };
		thread.turns.push({ author, body, ts });
		if (author === "user") {
			thread.status = "open";
			thread.piProposedResolve = false;
		}
		return { thread: publicThread(thread), created: false };
	}

	/** Validate and apply one reviewer post: a new thread or a reply to an existing one. */
	function postUserTurn(value) {
		if (!value || typeof value !== "object" || !validText(value.body, limits)) return { error: "invalid" };
		const body = value.body.trim();
		const ts = Date.now();
		if (value.threadId !== undefined) {
			const thread = typeof value.threadId === "string" ? threads.get(value.threadId) : undefined;
			if (!thread) return { error: "unknown-thread" };
			return appendTurn(thread, "user", body, ts);
		}
		if (value.source === "selection") {
			const anchor = validateSelection(value);
			if (!anchor) return { error: "invalid" };
			return createThread({ source: "selection", ...anchor }, [{ author: "user", body, ts }]);
		}
		if (value.source === "commentary") {
			const file = typeof value.file === "string" ? files.get(value.file) : undefined;
			const commentary = file?.commentary.find((entry) => entry.id === value.commentaryId);
			if (!commentary) return { error: "invalid" };
			const key = `${value.file}\0${value.commentaryId}`;
			const existing = threads.get(commentaryThreadIds.get(key));
			if (existing) return appendTurn(existing, "user", body, ts);
			const result = createThread(
				{ source: "commentary", file: value.file, commentaryId: value.commentaryId },
				[{ author: "pi", body: commentary.body, ts }, { author: "user", body, ts }],
			);
			if (result.thread) commentaryThreadIds.set(key, result.thread.id);
			return result;
		}
		if (value.source === "overview") {
			if (!review.overview) return { error: "invalid" };
			const existing = threads.get(overviewThreadId);
			if (existing) return appendTurn(existing, "user", body, ts);
			const result = createThread({ source: "overview" }, [{ author: "user", body, ts }]);
			if (result.thread) overviewThreadId = result.thread.id;
			return result;
		}
		return { error: "invalid" };
	}

	/** Append Pi's reply; resolves only proposes resolution. */
	function postPiReply(threadId, body, resolves) {
		const thread = typeof threadId === "string" ? threads.get(threadId) : undefined;
		if (!thread || !validText(body, limits)) return undefined;
		const result = appendTurn(thread, "pi", body.trim(), Date.now());
		if (result.error) return undefined;
		if (resolves === true && thread.status === "open") thread.piProposedResolve = true;
		return publicThread(thread);
	}

	/** Reviewer-only resolution toggle. */
	function setResolved(threadId, resolved) {
		const thread = typeof threadId === "string" ? threads.get(threadId) : undefined;
		if (!thread || typeof resolved !== "boolean") return undefined;
		thread.status = resolved ? "resolved" : "open";
		if (resolved) thread.piProposedResolve = false;
		return publicThread(thread);
	}

	function getThread(threadId) {
		const thread = threads.get(threadId);
		return thread ? publicThread(thread) : undefined;
	}

	function list() {
		return [...threads.values()].map(publicThread);
	}

	function summary() {
		const counts = { open: 0, awaitingUser: 0, awaitingPi: 0, resolved: 0 };
		for (const thread of threads.values()) {
			if (thread.status === "resolved") counts.resolved++;
			else {
				counts.open++;
				if (lastAuthor(thread) === "pi") counts.awaitingUser++;
				else counts.awaitingPi++;
			}
		}
		return counts;
	}

	return { postUserTurn, postPiReply, setResolved, getThread, list, summary };
}
