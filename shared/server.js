import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { computeContextGaps, CONTEXT_LIMITS, reviewFileDriftKey } from "./git-review.js";
import { renderReviewHtml } from "./render.js";
import { buildCarriedThreads, buildHeldThreads, createThreadStore, THREAD_LIMITS } from "./threads.js";

const POST_PATH = "/__pi_code_review_post__";
const RESOLVE_PATH = "/__pi_code_review_resolve__";
const FINISH_PATH = "/__pi_code_review_finish__";
const RESUME_PATH = "/__pi_code_review_resume__";
const VIEWED_PATH = "/__pi_code_review_viewed__";
const AMEND_PATH = "/__pi_code_review_amend__";
const SEND_PATH = "/__pi_code_review_send__";
const EVENTS_PATH = "/__pi_code_review_events__";
const MERMAID_PATH = "/__pi_code_review_mermaid__.js";
import { computeElementDiff } from "./diagram.js";
const CONTEXT_PATH = "/__pi_code_review_context__";
const APPROVE_PATH = "/__pi_code_review_approve__";
const SSE_HEARTBEAT_MS = 25_000;
const STALENESS_INTERVAL_MS = 4_000;
const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};
const STORE_ERRORS = {
	invalid: { status: 400, message: "Invalid thread payload." },
	"unknown-thread": { status: 404, message: "Unknown thread." },
	"thread-full": { status: 409, message: "This thread has reached its turn limit." },
	"too-many-threads": { status: 409, message: "This review has reached its thread limit." },
	"not-queued": { status: 409, message: "This message was already delivered to Pi and can no longer be changed." },
	"thread-resolved": { status: 409, message: "Reopen this thread before changing its queued messages." },
	"unknown-turn": { status: 404, message: "Unknown message." },
	"nothing-pending": { status: 409, message: "This thread has no pending messages." },
};

function htmlHeaders(nonce) {
	return {
		...SECURITY_HEADERS,
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": [
			"default-src 'none'",
			"base-uri 'none'",
			"connect-src 'self'",
			"font-src 'self'",
			"frame-ancestors 'none'",
			"img-src data:",
			"object-src 'none'",
			`script-src 'nonce-${nonce}'`,
			"style-src 'unsafe-inline'",
		].join("; "),
	};
}

function writeText(res, status, body, headers = {}) {
	res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers });
	res.end(body);
}

function writeJson(res, status, value) {
	res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
	const declared = Number(req.headers["content-length"] ?? 0);
	if (Number.isFinite(declared) && declared > THREAD_LIMITS.maxBodyBytes) throw new Error("too-large");
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > THREAD_LIMITS.maxBodyBytes) throw new Error("too-large");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("invalid-json");
	}
}

/**
 * Start an authenticated localhost server hosting one review session: an ordered
 * sequence of immutable snapshot rounds with live comment threads. Only the
 * newest round accepts mutations; prior rounds stay reachable read-only.
 */
export async function createCodeReviewServer(review, options) {
	if (typeof options?.onThreadPost !== "function" || typeof options?.onFinishPass !== "function") {
		throw new Error("Code review server requires onThreadPost and onFinishPass callbacks.");
	}
	// Identity of a file's rendered diff; viewed checkmarks survive a new round
	// only for files whose diff is byte-identical to the previous one.
	const diffSignature = (file) => JSON.stringify([file.status, file.oldPath ?? null, file.binary === true, file.omitted === true, file.truncated === true, file.patchBytes ?? 0, file.contentSha256 ?? null, (file.lines ?? []).map((line) => [line.kind, line.content, line.oldLine ?? null, line.newLine ?? null])]);
	const rounds = [{ number: 1, review, store: createThreadStore(review), viewed: new Set() }];
	let phase = "reviewing";
	let closeReason;
	const entryTokens = new Map();
	const mintToken = () => {
		const token = randomBytes(24).toString("base64url");
		entryTokens.set(token, false);
		return token;
	};
	const firstToken = mintToken();
	const cookieName = `pi_code_review_${randomBytes(8).toString("hex")}`;
	const cookieValue = randomBytes(24).toString("base64url");
	let port = 0;
	let finishing = false;
	// While a finish handoff is awaiting, the exact undelivered messages the pass
	// captured (thread id → Set of turn seqs); addRound consults it so carried
	// copies never re-deliver what the in-flight pass already carries.
	let inFlightCapture;
	let closed = false;
	const sockets = new Set();
	const sseClients = new Set();

	const current = () => rounds[rounds.length - 1];
	// Carried threads keep their ids across rounds; newest-first lookup makes the
	// living copy authoritative while older rounds stay reachable read-only.
	const roundOfThread = (threadId) => {
		for (let index = rounds.length - 1; index >= 0; index--) {
			if (rounds[index].store.getThread(threadId)) return rounds[index];
		}
		return undefined;
	};

	const broadcast = (event, data) => {
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of sseClients) client.write(frame);
	};
	const broadcastThread = (round, thread) => broadcast("thread", { round: round.number, thread, summary: round.store.summary() });
	const broadcastPhase = () => broadcast("phase", { phase, currentRound: current().number, ...(closeReason === undefined ? {} : { reason: closeReason }) });
	const heartbeat = setInterval(() => {
		for (const client of sseClients) client.write(": ping\n\n");
	}, SSE_HEARTBEAT_MS);
	heartbeat.unref?.();

	// Live worktree-drift detection: while reviewers are connected and the round
	// is active, a cheap fingerprint gates a full snapshot re-collection; the
	// badge informs only — rounds stay immutable and commenting stays open.
	let stale = false;
	let driftPaths = [];
	let staleFingerprint;
	let staleCheckInFlight;
	const setStale = (nextStale, nextDriftPaths = []) => {
		const drift = nextStale ? nextDriftPaths : [];
		if (nextStale === stale && drift.join("\n") === driftPaths.join("\n")) return;
		stale = nextStale;
		driftPaths = drift;
		broadcast("staleness", { stale, driftPaths });
	};
	const resetStaleness = () => {
		staleFingerprint = undefined;
		setStale(false);
	};
	// Paths whose reviewed content differs between the frozen round and the
	// worktree probe — including files that joined or left the changeset.
	const computeDriftPaths = (review, probeFiles) => {
		const frozen = new Map(review.files.map((file) => [file.path, reviewFileDriftKey(file)]));
		const probed = new Map(probeFiles.map((file) => [file.path, file.key]));
		const paths = new Set();
		for (const [path, key] of frozen) if (probed.get(path) !== key) paths.add(path);
		for (const path of probed.keys()) if (!frozen.has(path)) paths.add(path);
		return [...paths].sort().slice(0, 100);
	};
	const checkStaleness = async (force = false) => {
		// Drift while Pi is revising is expected, not signal; the check resumes
		// with the phase. force serves the approval flow, which re-checks after
		// locking the phase.
		if (!options.staleness || closed || (!force && phase !== "reviewing")) return stale;
		if (staleCheckInFlight) {
			// Periodic ticks skip while a probe runs; the approval path needs the
			// freshest verdict, so it waits the in-flight probe out instead of
			// returning the previous one.
			if (!force) return stale;
			await staleCheckInFlight;
			return stale;
		}
		const round = current();
		staleCheckInFlight = (async () => {
			try {
				const fingerprint = await options.staleness.fingerprint();
				if (fingerprint === staleFingerprint) return;
				const probe = await options.staleness.snapshot();
				// A round that advanced mid-check was collected from a newer tree than
				// this probe observed; discard the result and let the next tick measure.
				if (current() !== round) return;
				staleFingerprint = fingerprint;
				setStale(probe.id !== round.review.id, computeDriftPaths(round.review, probe.files));
			} catch {
				// Transient collection failures keep the previous verdict.
			}
		})();
		try {
			await staleCheckInFlight;
		} finally {
			staleCheckInFlight = undefined;
		}
		return stale;
	};
	const stalenessTimer = setInterval(() => {
		if (sseClients.size > 0) void checkStaleness();
	}, STALENESS_INTERVAL_MS);
	stalenessTimer.unref?.();

	// Hand delivered turns to Pi; on failure return them to the pending state so
	// nothing is stranded — they flow through the next delivery or the pass.
	const deliverToPi = async (round, result) => {
		try {
			const outcome = await options.onThreadPost(round, result.thread, result.deliveredTurns);
			// The status line follows the handoff: queued means the extension holds
			// the message until Pi settles (sent); otherwise it is already in Pi's
			// context with a turn in progress (working).
			const stamped = round.store.setReplyState(result.thread.id, outcome?.queued === true ? "sent" : "working");
			if (stamped) broadcastThread(round, stamped);
			return { thread: stamped ?? result.thread, failed: false };
		} catch {
			// An approval that landed while this delivery was in flight closed the
			// session; nothing will re-deliver, so the terminal store stays frozen.
			if (phase === "approved" || phase === "closed") return { thread: result.thread, failed: true };
			const requeued = round.store.requeue(result.thread.id, result.deliveredTurns.map((turn) => turn.seq), result.prevLive);
			if (requeued) broadcastThread(round, requeued);
			return { thread: requeued ?? result.thread, failed: true };
		}
	};

	const guardMutation = (req, res) => {
		if (req.headers.origin !== `http://127.0.0.1:${port}`) {
			writeText(res, 403, "Invalid origin.");
			return false;
		}
		if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
			writeText(res, 415, "Expected application/json.");
			return false;
		}
		return true;
	};
	const guardReviewingPhase = (res) => {
		if (phase === "reviewing") return true;
		if (phase === "approved") writeText(res, 409, "This review is approved and closed to changes; pages stay readable.");
		else if (phase === "closed") writeText(res, 409, "Pi closed this review session; pages stay readable.");
		else writeText(res, 409, "Pi is revising this review. Press \u201cResume reviewing this round\u201d to comment while you wait, or hold on for the next round.");
		return false;
	};
	const readGuardedBody = async (req, res) => {
		try {
			return await readJsonBody(req);
		} catch (error) {
			writeText(res, error?.message === "too-large" ? 413 : 400, error?.message === "too-large" ? "Request payload is too large." : "Invalid JSON.");
			return undefined;
		}
	};
	const renderRound = (round, res) => {
		const nonce = randomBytes(18).toString("base64");
		const archive = rounds
			.filter((candidate) => candidate.number < round.number)
			.map((candidate) => ({
				round: candidate.number,
				resolved: candidate.store.list().filter((thread) => thread.status === "resolved").map((thread) => ({ id: thread.id, source: thread.source, file: thread.file, highlight: thread.highlight, lastBody: thread.turns[thread.turns.length - 1]?.body ?? "" })),
			}))
			.filter((entry) => entry.resolved.length > 0);
		// Plan rounds mark which sections actually changed since the round they
		// superseded — the reviewer's convergence scan without a diff view.
		let changedSections;
		let elementDiff;
		if (round.review.kind === "plan" && round.number > 1) {
			const previous = rounds.find((candidate) => candidate.number === round.number - 1);
			const before = new Map(previous.review.files.map((file) => [file.path, file.contentSha256]));
			changedSections = round.review.files.filter((file) => before.get(file.path) !== file.contentSha256).map((file) => file.path);
			// Element-level diff per section: what glows (new ids, relabeled
			// nodes, new edges) and what the rail reports as removed.
			const beforeMarkdown = new Map(previous.review.files.map((file) => [file.path, file.markdown ?? ""]));
			for (const file of round.review.files) {
				const diff = computeElementDiff(beforeMarkdown.get(file.path) ?? "", file.markdown ?? "");
				if (diff.changed.length || diff.removed.length) {
					elementDiff = elementDiff ?? {};
					elementDiff[file.path] = { ...diff, fromRound: round.number - 1 };
				}
			}
		}
		res.writeHead(200, htmlHeaders(nonce));
		res.end(renderReviewHtml(round.review, nonce, { round: round.number, currentRound: current().number, phase, closeReason }, { carried: round.store.list().filter((thread) => thread.carried), archive, viewed: [...round.viewed], changedSections, elementDiff, appearance: options.appearance }));
	};

	let mermaidSource;
	const server = createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const expectedCookie = `${cookieName}=${cookieValue}`;
			const authenticated = (req.headers.cookie ?? "").split(";").some((part) => part.trim() === expectedCookie);
			const tokenParam = requestUrl.searchParams.get("token");
			if (req.method === "GET" && requestUrl.pathname === "/" && tokenParam !== null && entryTokens.has(tokenParam)) {
				if (entryTokens.get(tokenParam) && !authenticated) {
					writeText(res, 403, "This review link was already used. Ask Pi to reopen the review.");
					return;
				}
				entryTokens.set(tokenParam, true);
				res.writeHead(302, {
					...SECURITY_HEADERS,
					Location: "/",
					"Set-Cookie": `${cookieName}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/`,
				});
				res.end();
				return;
			}
			if (!authenticated) {
				writeText(res, 403, "Forbidden");
				return;
			}
			if (req.method === "GET" && requestUrl.pathname === "/") {
				renderRound(current(), res);
				return;
			}
			if (req.method === "GET" && requestUrl.pathname === MERMAID_PATH) {
				// Vendored renderer: served from the installed mermaid package so
				// the page never reaches a CDN. Cached after the first read.
				try {
					if (mermaidSource === undefined) {
						const { createRequire } = await import("node:module");
						const { readFile } = await import("node:fs/promises");
						const resolved = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
						mermaidSource = await readFile(resolved);
					}
					res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "private, max-age=3600" });
					res.end(mermaidSource);
				} catch {
					writeText(res, 404, "The mermaid renderer is not installed.");
				}
				return;
			}
			const roundPage = req.method === "GET" ? /^\/round\/(\d{1,4})$/.exec(requestUrl.pathname) : undefined;
			if (roundPage) {
				const round = rounds.find((candidate) => candidate.number === Number(roundPage[1]));
				if (!round) {
					writeText(res, 404, "Unknown review round.");
					return;
				}
				renderRound(round, res);
				return;
			}
			if (req.method === "GET" && requestUrl.pathname === CONTEXT_PATH) {
				if (typeof options.contextLines !== "function") {
					writeText(res, 404, "Context expansion is not available in this session.");
					return;
				}
				const round = rounds.find((candidate) => candidate.number === Number(requestUrl.searchParams.get("round")));
				if (!round) {
					writeText(res, 404, "Unknown review round.");
					return;
				}
				const file = round.review.files.find((candidate) => candidate.path === requestUrl.searchParams.get("path"));
				if (!file) {
					writeText(res, 404, "Unknown file.");
					return;
				}
				const oldStart = Number(requestUrl.searchParams.get("oldStart"));
				const oldEnd = Number(requestUrl.searchParams.get("oldEnd"));
				if (!Number.isInteger(oldStart) || !Number.isInteger(oldEnd) || oldStart < 1 || oldEnd < oldStart) {
					writeText(res, 400, "Invalid context range.");
					return;
				}
				if (oldEnd - oldStart + 1 > CONTEXT_LIMITS.maxRequestLines) {
					writeText(res, 400, `Context requests are limited to ${CONTEXT_LIMITS.maxRequestLines} lines.`);
					return;
				}
				// The range must lie inside a genuine gap of the frozen diff; client
				// coordinates are never trusted for numbering — delta comes from the gap.
				const gap = computeContextGaps(file).find((candidate) => oldStart >= candidate.oldStart && oldEnd <= candidate.oldEnd);
				if (!gap) {
					writeText(res, 400, "The requested range is not an expandable gap of this diff.");
					return;
				}
				const contents = await options.contextLines(round.review, file, oldStart, oldEnd);
				const trailing = gap.oldEnd === Infinity;
				if (contents === undefined || (!trailing && contents.length !== oldEnd - oldStart + 1)) {
					writeText(res, 404, "Context is unavailable for this file.");
					return;
				}
				writeJson(res, 200, {
					path: file.path,
					lines: contents.map((content, index) => ({ old: oldStart + index, new: oldStart + index + gap.delta, content })),
					eof: trailing && contents.length < oldEnd - oldStart + 1,
				});
				return;
			}
			if (req.method === "GET" && requestUrl.pathname === EVENTS_PATH) {
				const requested = Number(requestUrl.searchParams.get("round") ?? current().number);
				const round = rounds.find((candidate) => candidate.number === requested) ?? current();
				// Reconnect honesty: with no turn in progress, a thread still marked
				// working is really seen — its delivery outlived a runtime whose settle
				// sweep never ran. Repair persistently before composing init so a later
				// unrelated turn cannot flip the state back to working.
				if (typeof options.isTurnActive === "function" && !options.isTurnActive()) {
					for (const repaired of round.store.sweepReplyState("working", "seen")) broadcastThread(round, repaired);
				}
				res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
				res.write(`event: init\ndata: ${JSON.stringify({ round: round.number, currentRound: current().number, phase, stale, driftPaths, threads: round.store.list(), summary: round.store.summary(), viewedFiles: [...round.viewed] })}\n\n`);
				sseClients.add(res);
				req.on("close", () => sseClients.delete(res));
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === POST_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				// Quiet posts stay accepted while Pi revises: they deliver nothing now
				// and ride the round advance as queued/held content. Live posts,
				// resolves, and passes wait for the next round.
				if (!(phase === "revising" && body?.quiet === true) && !guardReviewingPhase(res)) return;
				const round = current();
				if (typeof body?.threadId === "string") {
					const owner = roundOfThread(body.threadId);
					if (owner && owner !== round) {
						writeText(res, 409, `This thread belongs to superseded round ${owner.number}; continue in round ${round.number}.`);
						return;
					}
				} else if (body?.round !== undefined && body.round !== round.number) {
					writeText(res, 409, `This page shows superseded round ${body.round}; comment in round ${round.number}.`);
					return;
				}
				// While a finish pass is in flight, a live reply that would deliver a
				// backlog the pass already captured must wait — Pi would get it twice.
				// Quiet posts and backlog-free live posts stay allowed. Tolerated
				// ordering quirk: a backlog-free live post here delivers a counter one
				// higher than the already-captured pass block for the same thread, so Pi
				// can see a later transmission with a LOWER counter; loss detection only
				// acts when the tally falls below the counter, so this is benign.
				if (finishing && body?.quiet !== true) {
					const target = typeof body?.threadId === "string"
						? round.store.getThread(body.threadId)
						: body?.source === "commentary" && typeof body?.file === "string"
							? round.store.list().find((thread) => thread.source === "commentary" && thread.file === body.file && thread.commentaryId === body.commentaryId)
							: undefined;
					if (target && target.pending > 0) {
						writeText(res, 409, "The round is being handed to Pi; try again in a moment.");
						return;
					}
				}
				const { round: _round, ...payload } = body && typeof body === "object" ? body : {};
				const result = round.store.postUserTurn(payload);
				if (result.error) {
					const mapped = STORE_ERRORS[result.error] ?? STORE_ERRORS.invalid;
					writeText(res, mapped.status, mapped.message);
					return;
				}
				broadcastThread(round, result.thread);
				if (!result.deliveredTurns) {
					writeJson(res, 200, { thread: result.thread, summary: round.store.summary(), ...(result.thread.queued ? { queued: true } : { pending: true }) });
					return;
				}
				const delivery = await deliverToPi(round, result);
				writeJson(res, 200, { thread: delivery.thread, summary: round.store.summary(), ...(result.escalated === true && !delivery.failed ? { escalated: true } : {}), ...(delivery.failed ? { deliveryFailed: true } : {}) });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === VIEWED_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				// Viewed is reviewer bookkeeping: allowed while Pi revises (unlike thread
				// mutations), but only on the current round — and never after approval.
				// Closed means closed: the terminal 409 outranks payload shape errors.
				if (phase === "approved" || phase === "closed") {
					writeText(res, 409, phase === "approved" ? "This review is approved and closed to changes; pages stay readable." : "Pi closed this review session; pages stay readable.");
					return;
				}
				if (!body || typeof body !== "object" || typeof body.file !== "string" || typeof body.viewed !== "boolean") {
					writeText(res, 400, "Invalid viewed payload.");
					return;
				}
				const round = current();
				if (body.round !== undefined && body.round !== round.number) {
					writeText(res, 409, `This page shows superseded round ${body.round}; the viewed checklist lives on round ${round.number}.`);
					return;
				}
				if (!round.review.files.some((file) => file.path === body.file)) {
					writeText(res, 404, "Unknown file.");
					return;
				}
				if (body.viewed) round.viewed.add(body.file);
				else round.viewed.delete(body.file);
				broadcast("viewed", { round: round.number, viewedFiles: [...round.viewed] });
				writeJson(res, 200, { viewedFiles: [...round.viewed] });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === SEND_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				if (!body || typeof body !== "object" || typeof body.threadId !== "string") {
					writeText(res, 400, "Invalid send payload.");
					return;
				}
				if (!guardReviewingPhase(res)) return;
				if (finishing) {
					writeText(res, 409, "The round is being handed to Pi; try again in a moment.");
					return;
				}
				const round = current();
				const owner = roundOfThread(body.threadId);
				if (owner && owner !== round) {
					writeText(res, 409, `This thread belongs to superseded round ${owner.number}; continue in round ${round.number}.`);
					return;
				}
				const result = round.store.deliverPending(body.threadId);
				if (result.error) {
					const mapped = STORE_ERRORS[result.error] ?? STORE_ERRORS.invalid;
					writeText(res, mapped.status, mapped.message);
					return;
				}
				broadcastThread(round, result.thread);
				const delivery = await deliverToPi(round, result);
				writeJson(res, 200, { thread: delivery.thread, summary: round.store.summary(), ...(delivery.failed ? { deliveryFailed: true } : { sent: result.deliveredTurns.length }) });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === AMEND_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				const deleting = body?.delete === true;
				if (!body || typeof body !== "object" || typeof body.threadId !== "string" || !Number.isInteger(body.seq) || (deleting ? body.body !== undefined : typeof body.body !== "string")) {
					writeText(res, 400, "Invalid amend payload.");
					return;
				}
				if (!guardReviewingPhase(res)) return;
				// An in-flight finish pass has already captured the queued content it is
				// delivering; amending inside that window would diverge store and pass.
				if (finishing) {
					writeText(res, 409, "The round is being handed to Pi; try again in a moment.");
					return;
				}
				const round = current();
				const owner = roundOfThread(body.threadId);
				if (owner && owner !== round) {
					writeText(res, 409, `This thread belongs to superseded round ${owner.number}; continue in round ${round.number}.`);
					return;
				}
				const result = round.store.amendQueuedTurn(body.threadId, body.seq, deleting ? undefined : body.body);
				if (result.error) {
					const mapped = STORE_ERRORS[result.error] ?? STORE_ERRORS.invalid;
					writeText(res, mapped.status, mapped.message);
					return;
				}
				if (result.removed) {
					broadcast("thread-removed", { round: round.number, threadId: result.threadId, summary: round.store.summary() });
					writeJson(res, 200, { removed: true, threadId: result.threadId, summary: round.store.summary() });
					return;
				}
				broadcastThread(round, result.thread);
				writeJson(res, 200, { thread: result.thread, summary: round.store.summary() });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === RESOLVE_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				if (!body || typeof body !== "object" || typeof body.resolved !== "boolean" || typeof body.threadId !== "string") {
					writeText(res, 400, "Invalid resolve payload.");
					return;
				}
				if (!guardReviewingPhase(res)) return;
				// Resolution changes mid-handoff would desync the captured pass from the
				// stamping that follows it (withdrawn backlogs re-stamped, captured ones
				// skipped); hold them for the few seconds the handoff takes.
				if (finishing) {
					writeText(res, 409, "The round is being handed to Pi; try again in a moment.");
					return;
				}
				const round = current();
				const owner = roundOfThread(body.threadId);
				if (owner && owner !== round) {
					writeText(res, 409, `This thread belongs to superseded round ${owner.number}; continue in round ${round.number}.`);
					return;
				}
				const thread = round.store.setResolved(body.threadId, body.resolved);
				if (!thread) {
					writeText(res, 404, "Unknown thread.");
					return;
				}
				broadcastThread(round, thread);
				writeJson(res, 200, { thread, summary: round.store.summary() });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === FINISH_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				const note = body?.note === undefined ? undefined : typeof body.note === "string" && body.note.trim() && body.note.length <= THREAD_LIMITS.maxFieldLength ? body.note.trim() : undefined;
				if (body?.note !== undefined && note === undefined) {
					writeText(res, 400, "Invalid finish note.");
					return;
				}
				if (!guardReviewingPhase(res)) return;
				if (finishing) {
					writeText(res, 409, "A finish-pass handoff is already in progress.");
					return;
				}
				finishing = true;
				const round = current();
				const passThreads = round.store.list();
				// The pass delivers exactly the undelivered messages it captured — and
				// only those: quiet messages posted while the handoff awaits (new threads
				// or new turns on captured threads) stay pending. Only open threads are
				// in the pass; resolved ones were withdrawn.
				const capturedPending = new Map(passThreads.filter((thread) => thread.status === "open").map((thread) => [thread.id, new Set(thread.turns.filter((turn) => turn.author === "user" && turn.delivered === false).map((turn) => turn.seq))]));
				inFlightCapture = capturedPending;
				let result;
				try {
					result = await options.onFinishPass(round, note, passThreads, round.store.summary());
				} finally {
					finishing = false;
					inFlightCapture = undefined;
				}
				// A new round may have opened while the handoff awaited; never lock it retroactively.
				const superseded = current() !== round;
				// Threads the pass just delivered pick up the pass's own delivery state:
				// a queued pass rides the extension queue (sent); an immediate one is in
				// Pi's context with a turn incoming (working).
				const passState = result?.queued === true ? "sent" : "working";
				for (const delivered of round.store.markAllDelivered(capturedPending)) {
					broadcastThread(round, round.store.setReplyState(delivered.id, passState) ?? delivered);
				}
				if (!superseded) {
					phase = "revising";
					broadcastPhase();
				}
				writeJson(res, 200, { stale: result?.stale === true, ...(superseded ? { superseded: true } : {}) });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === RESUME_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				if (phase !== "revising") {
					writeText(res, 409, phase === "approved" ? "This review is approved and closed." : "This round is not waiting on Pi.");
					return;
				}
				phase = "reviewing";
				broadcastPhase();
				writeJson(res, 200, { phase, currentRound: current().number });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === APPROVE_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				if (!guardReviewingPhase(res)) return;
				if (finishing) {
					writeText(res, 409, "The round is being handed to Pi; try again in a moment.");
					return;
				}
				const message = typeof body?.message === "string" && body.message.trim() && body.message.length <= THREAD_LIMITS.maxFieldLength ? body.message.trim() : undefined;
				if (message === undefined) {
					writeText(res, 400, "Approval requires a non-empty commit message.");
					return;
				}
				const round = current();
				const blockers = round.store.summary().open;
				if (blockers > 0) {
					writeText(res, 409, `${blockers} thread${blockers === 1 ? " is" : "s are"} still open; resolve every thread before approving.`);
					return;
				}
				// Lock the session before the async work so nothing can reopen a thread
				// mid-approval; revert only if the handoff to Pi fails.
				phase = "approved";
				broadcastPhase();
				const staleNow = await checkStaleness(true);
				try {
					await options.onApprove?.(round, message, staleNow);
				} catch {
					phase = "reviewing";
					broadcastPhase();
					writeText(res, 500, "Could not deliver the approval to Pi; the round stays open.");
					return;
				}
				writeJson(res, 200, { approved: true, stale: staleNow });
				return;
			}
			writeText(res, 404, "Not found");
		} catch (error) {
			writeText(res, 500, error instanceof Error ? error.message : "Internal server error");
		}
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectPromise);
			resolvePromise();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not determine code review server port.");
	port = address.port;
	return {
		url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(firstToken)}`,
		port,
		root: review.root,
		entryUrl: () => `http://127.0.0.1:${port}/?token=${encodeURIComponent(mintToken())}`,
		clientCount: () => sseClients.size,
		checkStaleness,
		isStale: () => stale,
		currentReview: () => current().review,
		currentRoundNumber: () => current().number,
		closeSession(reason) {
			if (phase === "approved" || phase === "closed") return { error: phase };
			phase = "closed";
			closeReason = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
			broadcastPhase();
			return { round: current().number };
		},
		roundFiles: (reviewId) => rounds.find((round) => round.review.id === reviewId)?.review.files.map(({ path, summary, reviewMode, commentary, contentSha256 }) => ({ path, summary, reviewMode, commentary, contentSha256 })),
		hasRound: (reviewId) => rounds.some((round) => round.review.id === reviewId),
		locateThread(threadId) {
			const round = roundOfThread(threadId);
			return round ? { round: round.number, current: round === current() } : undefined;
		},
		getThread: (threadId) => roundOfThread(threadId)?.store.getThread(threadId),
		threadContext(threadId) {
			const round = roundOfThread(threadId);
			if (!round) return undefined;
			return { thread: round.store.getThread(threadId), round: round.number, current: round === current(), review: round.review };
		},
		threads: () => current().store.list(),
		threadSummary: () => current().store.summary(),
		viewedFiles: () => [...current().viewed],
		// Pi's turn ended: delivered reviewer messages still waiting on a reply
		// were seen, not answered. Every round sweeps so nothing strands working.
		markTurnEnd() {
			for (const round of rounds) {
				for (const thread of round.store.sweepReplyState("working", "seen")) broadcastThread(round, thread);
			}
		},
		// The extension's queue flushed into Pi's context: sent threads are working.
		markQueueDelivered() {
			for (const round of rounds) {
				for (const thread of round.store.sweepReplyState("sent", "working")) broadcastThread(round, thread);
			}
		},
		postPiReply(threadId, body, resolves) {
			// A closed session names the true reason; a bare failure would read as a
			// turn-limit guess and send Pi down the wrong recovery path.
			if (phase === "approved" || phase === "closed") return { error: phase };
			const round = current();
			const thread = round.store.postPiReply(threadId, body, resolves);
			if (thread) broadcastThread(round, thread);
			return thread;
		},
		addRound(nextReview, previousRoundId, threadResponses) {
			if (phase === "approved" || phase === "closed") return { error: phase };
			const active = current();
			if (previousRoundId !== active.review.id) {
				if (rounds.some((round) => round.review.id === previousRoundId)) {
					return { error: "superseded", currentRound: active.number, currentRoundId: active.review.id };
				}
				return { error: "unknown-round" };
			}
			// An identical snapshot has nothing to re-anchor: threads stay live in the
			// existing round, so the response contract deliberately does not apply and
			// any supplied responses are ignored in favor of in-place replies.
			if (nextReview.id === active.review.id) {
				if (phase !== "reviewing") {
					phase = "reviewing";
					broadcastPhase();
				}
				resetStaleness();
				return { identical: true, round: active.number };
			}
			if (nextReview.root !== active.review.root) return { error: "wrong-root" };
			let carried;
			try {
				carried = buildCarriedThreads(threadResponses, active.store.list(), nextReview, active.number);
			} catch (error) {
				return { error: "invalid-responses", message: error instanceof Error ? error.message : String(error) };
			}
			// Open threads whose reviewer content Pi never received are not part of
			// the response contract; they cross into the new round still queued.
			const held = buildHeldThreads(active.store.list(), nextReview, active.number);
			// A round opened while a finish handoff is in flight must not re-deliver
			// messages the in-flight pass already carries: stamp the captured seqs
			// delivered in the carried and held copies (uncaptured mid-handoff turns
			// stay pending).
			if (inFlightCapture) {
				for (const record of [...carried, ...held]) {
					const capturedSeqs = inFlightCapture.get(record.id);
					if (!capturedSeqs) continue;
					for (const turn of record.turns) {
						if (turn.author === "user" && turn.delivered === false && capturedSeqs.has(turn.seq)) turn.delivered = true;
					}
				}
			}
			const previousSignatures = new Map(active.review.files.map((file) => [file.path, diffSignature(file)]));
			const viewed = new Set(nextReview.files.filter((file) => active.viewed.has(file.path) && previousSignatures.get(file.path) === diffSignature(file)).map((file) => file.path));
			// A round that does not re-propose a commit message keeps the last one.
			const roundReview = nextReview.proposedCommitMessage === undefined && active.review.proposedCommitMessage !== undefined
				? { ...nextReview, proposedCommitMessage: active.review.proposedCommitMessage }
				: nextReview;
			const round = { number: active.number + 1, review: roundReview, store: createThreadStore(roundReview, THREAD_LIMITS, carried, held), viewed };
			rounds.push(round);
			phase = "reviewing";
			// The new round's snapshot was just collected from this worktree.
			resetStaleness();
			broadcast("round-ready", { round: round.number, previousRound: active.number });
			return { round: round.number };
		},
		async close() {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			clearInterval(stalenessTimer);
			for (const client of sseClients) client.end();
			sseClients.clear();
			for (const socket of sockets) socket.destroy();
			await new Promise((resolvePromise) => server.close(() => resolvePromise()));
		},
	};
}
