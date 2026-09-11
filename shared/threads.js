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
	// Turns carry a per-thread sequence number so amendments target a stable
	// identity even after a sibling deletion shifts array positions. User turns
	// track per-message delivery: a message is mutable until Pi has seen it.
	const stampTurns = (turns, delivered) => turns.map((turn, index) => ({ ...turn, seq: index + 1, ...(turn.author === "user" ? { delivered } : {}) }));
	const undeliveredTurns = (thread) => thread.turns.filter((turn) => turn.author === "user" && turn.delivered === false);

	// Every commentary note seeds an open thread awaiting the reviewer. Seeds are
	// exempt from maxThreads, which bounds reviewer-created threads only.
	for (const file of review.files) {
		for (const entry of file.commentary) {
			const thread = {
				id: mintId(),
				status: "open",
				live: false,
				piProposedResolve: false,
				source: "commentary",
				file: file.path,
				commentaryId: entry.id,
				nextSeq: 2,
				turns: [{ author: "pi", body: entry.body, ts: Date.now(), seq: 1 }],
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
			live: true,
			piProposedResolve: carriedThread.piProposedResolve === true,
			source: carriedThread.source,
			...(carriedThread.highlight === undefined ? {} : { highlight: carriedThread.highlight }),
			...(carriedThread.file === undefined ? {} : { file: carriedThread.file }),
			carried: { ...carriedThread.carried },
			nextSeq: carriedThread.turns.length + 1,
			// Carried turns keep their per-message delivery state: a pending tail the
			// reviewer wrote just before the round advanced must survive as pending,
			// not be silently stamped delivered.
			turns: carriedThread.turns.map((turn, index) => ({ ...turn, seq: index + 1, ...(turn.author === "user" ? { delivered: turn.delivered !== false } : {}) })),
		});
	}
	const seededCount = threads.size;

	const publicThread = (thread) => {
		const visible = {
			...thread,
			// queued: Pi does not know this thread exists yet. pending: undelivered
			// reviewer messages (all of a queued thread's, or a live thread's tail).
			queued: !thread.live && thread.turns.some((turn) => turn.author === "user"),
			pending: undeliveredTurns(thread).length,
			...(thread.carried ? { carried: { ...thread.carried } } : {}),
			turns: thread.turns.map((turn) => ({ ...turn })),
		};
		// nextSeq is store bookkeeping, not wire format.
		delete visible.nextSeq;
		return visible;
	};
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

	function createThread(fields, turns, quiet) {
		if (threads.size - seededCount >= limits.maxThreads) return { error: "too-many-threads" };
		const thread = { id: mintId(), status: "open", live: quiet !== true, piProposedResolve: false, ...fields, nextSeq: turns.length + 1, turns: stampTurns(turns, quiet !== true) };
		threads.set(thread.id, thread);
		const delivered = quiet !== true ? thread.turns.filter((turn) => turn.author === "user").map((turn) => ({ ...turn })) : undefined;
		return { thread: publicThread(thread), created: true, ...(delivered ? { deliveredTurns: delivered, prevLive: false } : {}) };
	}

	function appendTurn(thread, author, body, ts, quiet) {
		if (thread.turns.length >= limits.maxTurnsPerThread) return { error: "thread-full" };
		const turn = { author, body, ts, seq: thread.nextSeq++ };
		if (author === "user") turn.delivered = quiet === true ? false : true;
		thread.turns.push(turn);
		if (author !== "user") return { thread: publicThread(thread), created: false };
		thread.status = "open";
		thread.piProposedResolve = false;
		// A quiet message stays pending. A live message delivers the thread's whole
		// undelivered backlog with it, in order, so Pi never sees a gap.
		if (quiet === true) return { thread: publicThread(thread), created: false };
		const prevLive = thread.live;
		const backlog = undeliveredTurns(thread);
		for (const pendingTurn of backlog) pendingTurn.delivered = true;
		turn.delivered = true;
		thread.live = true;
		const deliveredNow = [...backlog.map((pendingTurn) => ({ ...pendingTurn })), { ...turn }];
		return { thread: publicThread(thread), created: false, deliveredTurns: deliveredNow, prevLive, ...(deliveredNow.length > 1 ? { escalated: true } : {}) };
	}

	/** Validate and apply one reviewer post: a new thread or a reply to an existing one. */
	function postUserTurn(value) {
		if (!value || typeof value !== "object" || !validText(value.body, limits)) return { error: "invalid" };
		const body = value.body.trim();
		const ts = Date.now();
		const quiet = value.quiet === true;
		if (value.threadId !== undefined) {
			const thread = typeof value.threadId === "string" ? threads.get(value.threadId) : undefined;
			if (!thread) return { error: "unknown-thread" };
			return appendTurn(thread, "user", body, ts, quiet);
		}
		if (value.source === "selection") {
			const anchor = validateSelection(value);
			if (!anchor) return { error: "invalid" };
			return createThread({ source: "selection", ...anchor }, [{ author: "user", body, ts }], quiet);
		}
		if (value.source === "commentary") {
			const existing = typeof value.file === "string" ? threads.get(commentaryThreadIds.get(`${value.file}\0${value.commentaryId}`)) : undefined;
			if (!existing) return { error: "invalid" };
			return appendTurn(existing, "user", body, ts, quiet);
		}
		if (value.source === "overview") {
			if (!review.overview) return { error: "invalid" };
			return createThread({ source: "overview" }, [{ author: "user", body, ts }], quiet);
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

	/**
	 * Sending a round delivers every undelivered reviewer message through the
	 * pass summary — whole queued threads and pending tails on live threads
	 * alike. Resolved quiet threads were withdrawn, not delivered; they keep
	 * their pending state so a later reopen can still surface their content.
	 * When a captured map (thread id → Set of turn seqs) is given, only those
	 * exact messages count as delivered — quiet messages posted after the pass
	 * content was captured were not in it and must stay pending.
	 */
	function markAllDelivered(captured) {
		const delivered = [];
		for (const thread of threads.values()) {
			if (captured && !captured.has(thread.id)) continue;
			if (thread.status === "resolved") continue;
			const allowed = captured?.get(thread.id);
			const backlog = undeliveredTurns(thread).filter((turn) => !allowed || allowed.has(turn.seq));
			if (backlog.length === 0) continue;
			for (const turn of backlog) turn.delivered = true;
			thread.live = true;
			delivered.push(publicThread(thread));
		}
		return delivered;
	}

	/**
	 * "Send now": deliver a thread's pending backlog without adding a message.
	 * Returns the delivered turns so the caller can hand them to Pi (and requeue
	 * them if that handoff fails).
	 */
	function deliverPending(threadId) {
		const thread = typeof threadId === "string" ? threads.get(threadId) : undefined;
		if (!thread) return { error: "unknown-thread" };
		if (thread.status !== "open") return { error: "thread-resolved" };
		const backlog = undeliveredTurns(thread);
		if (backlog.length === 0) return { error: "nothing-pending" };
		const prevLive = thread.live;
		for (const turn of backlog) turn.delivered = true;
		thread.live = true;
		return { thread: publicThread(thread), deliveredTurns: backlog.map((turn) => ({ ...turn })), prevLive };
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

	/**
	 * Edit (body given) or delete (body undefined) one reviewer message that Pi
	 * has not seen yet. Only open, undelivered (queued) threads are amendable;
	 * deleting a thread's last turn removes the thread itself.
	 */
	function amendQueuedTurn(threadId, seq, body) {
		const thread = typeof threadId === "string" ? threads.get(threadId) : undefined;
		if (!thread) return { error: "unknown-thread" };
		if (thread.status !== "open") return { error: "thread-resolved" };
		const index = Number.isInteger(seq) ? thread.turns.findIndex((turn) => turn.seq === seq && turn.author === "user") : -1;
		if (index === -1) return { error: "unknown-turn" };
		if (thread.turns[index].delivered !== false) return { error: "not-queued" };
		if (body === undefined) {
			thread.turns.splice(index, 1);
			if (thread.turns.length === 0) {
				threads.delete(thread.id);
				return { removed: true, threadId: thread.id };
			}
			return { thread: publicThread(thread) };
		}
		if (!validText(body, limits)) return { error: "invalid" };
		thread.turns[index] = { ...thread.turns[index], body: body.trim() };
		return { thread: publicThread(thread) };
	}

	/** Return a failed delivery's messages to the pending state so nothing is lost. */
	function requeue(threadId, seqs, prevLive) {
		const thread = threads.get(threadId);
		if (!thread || thread.status !== "open") return undefined;
		const targets = new Set(seqs);
		for (const turn of thread.turns) {
			if (turn.author === "user" && targets.has(turn.seq)) turn.delivered = false;
		}
		thread.live = prevLive === true;
		return publicThread(thread);
	}

	return { postUserTurn, postPiReply, setResolved, getThread, list, summary, markAllDelivered, deliverPending, requeue, amendQueuedTurn };
}
