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

export const THREAD_RESOLUTIONS = Object.freeze(["addressed", "declined", "needs-discussion"]);

/** Open threads with reviewer turns: the set a next round must respond to. */
export function threadsAwaitingResponse(threads) {
	return threads.filter((thread) => thread.status === "open" && thread.turns.some((turn) => turn.author === "user"));
}

/**
 * Validate a next round's thread responses against the previous round's open
 * threads and the next review's rendered diff, and build the carried thread
 * records. Throws with an actionable message on any contract violation.
 */
export function buildCarriedThreads(responses, previousThreads, nextReview, fromRound, limits = THREAD_LIMITS) {
	const list = responses ?? [];
	if (!Array.isArray(list)) throw new Error("threadResponses must be an array.");
	const eligible = new Map(threadsAwaitingResponse(previousThreads).map((thread) => [thread.id, thread]));
	const files = new Map(nextReview.files.map((file) => [file.path, file]));
	const seen = new Set();
	const carried = list.map((response) => {
		if (!response || typeof response !== "object" || typeof response.respondsTo !== "string") throw new Error("Each thread response needs a respondsTo thread id.");
		const origin = eligible.get(response.respondsTo);
		if (!origin) throw new Error(`Thread response ${response.respondsTo} does not match an open thread awaiting a response in round ${fromRound}.`);
		if (seen.has(origin.id)) throw new Error(`Thread ${origin.id} has more than one response.`);
		seen.add(origin.id);
		if (!THREAD_RESOLUTIONS.includes(response.resolution)) throw new Error(`Thread response ${origin.id} needs a resolution of addressed, declined, or needs-discussion.`);
		if (!validText(response.body, limits)) throw new Error(`Thread response ${origin.id} needs a non-empty bounded body.`);
		let placement = "outdated";
		const anchor = {};
		if (response.file !== undefined) {
			const file = files.get(response.file);
			if (!file) throw new Error(`Thread response ${origin.id} anchors to ${response.file}, which is not part of this round; omit file when the anchor is gone.`);
			placement = "file";
			anchor.file = response.file;
			if (response.startLine !== undefined) {
				if (file.binary || file.omitted) throw new Error(`Thread response ${origin.id} cannot line-anchor to ${response.file}.`);
				const side = response.side ?? "both";
				if (!["old", "new", "both"].includes(side)) throw new Error(`Thread response ${origin.id} has an invalid side.`);
				const endLine = response.endLine ?? response.startLine;
				if (!Number.isInteger(response.startLine) || response.startLine < 1 || !Number.isInteger(endLine) || endLine < response.startLine) {
					throw new Error(`Thread response ${origin.id} has an invalid line range.`);
				}
				const boundaryIsVisible = (targetLine) => file.lines.some((line) => (side !== "new" && line.oldLine === targetLine) || (side !== "old" && line.newLine === targetLine));
				if (!boundaryIsVisible(response.startLine) || !boundaryIsVisible(endLine)) {
					throw new Error(`Thread response ${origin.id} does not anchor to a visible complete ${side} range in ${response.file}.`);
				}
				placement = "anchored";
				anchor.side = side;
				anchor.startLine = response.startLine;
				anchor.endLine = endLine;
			} else if (response.endLine !== undefined || response.side !== undefined) {
				throw new Error(`Thread response ${origin.id} cannot set side or endLine without startLine.`);
			}
		} else if (response.startLine !== undefined || response.endLine !== undefined || response.side !== undefined) {
			throw new Error(`Thread response ${origin.id} cannot set an anchor range without a file.`);
		}
		return {
			id: origin.id,
			source: origin.source,
			...(origin.highlight === undefined ? {} : { highlight: origin.highlight }),
			...(anchor.file === undefined ? {} : { file: anchor.file }),
			piProposedResolve: response.resolution === "addressed",
			carried: { fromRound, resolution: response.resolution, placement, ...(anchor.side === undefined ? {} : { side: anchor.side, startLine: anchor.startLine, endLine: anchor.endLine }) },
			turns: [...origin.turns.map((turn) => ({ ...turn })), { author: "pi", body: response.body.trim(), ts: Date.now(), resolution: response.resolution }],
		};
	});
	const missing = [...eligible.keys()].filter((id) => !seen.has(id));
	if (missing.length) throw new Error(`Every open thread needs exactly one response; missing: ${missing.join(", ")}.`);
	return carried;
}

/** Live comment-thread store for one immutable review snapshot. */
export function createThreadStore(review, limits = THREAD_LIMITS, carriedThreads = []) {
	const threads = new Map();
	const files = new Map(review.files.map((file) => [file.path, file]));
	const commentaryThreadIds = new Map();
	let counter = 0;
	const storeSalt = randomBytes(3).toString("hex");
	const mintId = () => `${review.id.slice(0, 8)}-${storeSalt}-t${++counter}`;

	// Every commentary note seeds an open thread awaiting the reviewer. Seeds are
	// exempt from maxThreads, which bounds reviewer-created threads only.
	for (const file of review.files) {
		for (const entry of file.commentary) {
			const thread = {
				id: mintId(),
				status: "open",
				piProposedResolve: false,
				source: "commentary",
				file: file.path,
				commentaryId: entry.id,
				turns: [{ author: "pi", body: entry.body, ts: Date.now() }],
			};
			threads.set(thread.id, thread);
			commentaryThreadIds.set(`${file.path}\0${entry.id}`, thread.id);
		}
	}
	// Carried threads keep their round-of-origin ids and are, like seeds, exempt
	// from maxThreads: the cap bounds reviewer-created threads only.
	for (const carriedThread of carriedThreads) {
		threads.set(carriedThread.id, {
			id: carriedThread.id,
			status: "open",
			piProposedResolve: carriedThread.piProposedResolve === true,
			source: carriedThread.source,
			...(carriedThread.highlight === undefined ? {} : { highlight: carriedThread.highlight }),
			...(carriedThread.file === undefined ? {} : { file: carriedThread.file }),
			carried: { ...carriedThread.carried },
			turns: carriedThread.turns.map((turn) => ({ ...turn })),
		});
	}
	const seededCount = threads.size;

	const publicThread = (thread) => ({ ...thread, ...(thread.carried ? { carried: { ...thread.carried } } : {}), turns: thread.turns.map((turn) => ({ ...turn })) });
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
		if (threads.size - seededCount >= limits.maxThreads) return { error: "too-many-threads" };
		const thread = { id: mintId(), status: "open", piProposedResolve: false, ...fields, turns };
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
			const existing = typeof value.file === "string" ? threads.get(commentaryThreadIds.get(`${value.file}\0${value.commentaryId}`)) : undefined;
			if (!existing) return { error: "invalid" };
			return appendTurn(existing, "user", body, ts);
		}
		if (value.source === "overview") {
			if (!review.overview) return { error: "invalid" };
			return createThread({ source: "overview" }, [{ author: "user", body, ts }]);
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
