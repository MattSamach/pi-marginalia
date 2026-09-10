import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { renderReviewHtml } from "./render.js";
import { buildCarriedThreads, createThreadStore, THREAD_LIMITS } from "./threads.js";

const POST_PATH = "/__pi_code_review_post__";
const RESOLVE_PATH = "/__pi_code_review_resolve__";
const FINISH_PATH = "/__pi_code_review_finish__";
const RESUME_PATH = "/__pi_code_review_resume__";
const VIEWED_PATH = "/__pi_code_review_viewed__";
const EVENTS_PATH = "/__pi_code_review_events__";
const SSE_HEARTBEAT_MS = 25_000;
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
	const broadcastPhase = () => broadcast("phase", { phase, currentRound: current().number });
	const heartbeat = setInterval(() => {
		for (const client of sseClients) client.write(": ping\n\n");
	}, SSE_HEARTBEAT_MS);
	heartbeat.unref?.();

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
		writeText(res, 409, "Pi is revising this review. Wait for the next round or resume this one.");
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
		res.writeHead(200, htmlHeaders(nonce));
		res.end(renderReviewHtml(round.review, nonce, { round: round.number, currentRound: current().number, phase }, { carried: round.store.list().filter((thread) => thread.carried), archive, viewed: [...round.viewed] }));
	};

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
			if (req.method === "GET" && requestUrl.pathname === EVENTS_PATH) {
				const requested = Number(requestUrl.searchParams.get("round") ?? current().number);
				const round = rounds.find((candidate) => candidate.number === requested) ?? current();
				res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
				res.write(`event: init\ndata: ${JSON.stringify({ round: round.number, currentRound: current().number, phase, threads: round.store.list(), summary: round.store.summary(), viewedFiles: [...round.viewed] })}\n\n`);
				sseClients.add(res);
				req.on("close", () => sseClients.delete(res));
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === POST_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				if (!guardReviewingPhase(res)) return;
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
				const { round: _round, ...payload } = body && typeof body === "object" ? body : {};
				const result = round.store.postUserTurn(payload);
				if (result.error) {
					const mapped = STORE_ERRORS[result.error] ?? STORE_ERRORS.invalid;
					writeText(res, mapped.status, mapped.message);
					return;
				}
				broadcastThread(round, result.thread);
				if (result.thread.queued) {
					writeJson(res, 200, { thread: result.thread, summary: round.store.summary(), queued: true });
					return;
				}
				let deliveryFailed = false;
				let responseThread = result.thread;
				const turnsToDeliver = result.escalated === true
					? result.thread.turns.filter((turn) => turn.author === "user")
					: [result.thread.turns[result.thread.turns.length - 1]];
				try {
					await options.onThreadPost(round, result.thread, turnsToDeliver);
				} catch {
					deliveryFailed = true;
					if (result.escalated === true) {
						// A failed escalation must not strand the quiet backlog: requeue it
						// so the full history flows through the next escalation or the pass.
						const requeued = round.store.requeue(result.thread.id);
						if (requeued) {
							responseThread = requeued;
							broadcastThread(round, requeued);
						}
					}
				}
				writeJson(res, 200, { thread: responseThread, summary: round.store.summary(), ...(result.escalated === true && !deliveryFailed ? { escalated: true } : {}), ...(deliveryFailed ? { deliveryFailed: true } : {}) });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === VIEWED_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				if (!body || typeof body !== "object" || typeof body.file !== "string" || typeof body.viewed !== "boolean") {
					writeText(res, 400, "Invalid viewed payload.");
					return;
				}
				// Viewed is reviewer bookkeeping: allowed while Pi revises (unlike thread
				// mutations), but only on the current round.
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
			if (req.method === "POST" && requestUrl.pathname === RESOLVE_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				if (!body || typeof body !== "object" || typeof body.resolved !== "boolean" || typeof body.threadId !== "string") {
					writeText(res, 400, "Invalid resolve payload.");
					return;
				}
				if (!guardReviewingPhase(res)) return;
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
				let result;
				try {
					result = await options.onFinishPass(round, note, round.store.list(), round.store.summary());
				} finally {
					finishing = false;
				}
				// A new round may have opened while the handoff awaited; never lock it retroactively.
				const superseded = current() !== round;
				// The pass summary just delivered every queued thread in full.
				for (const delivered of round.store.markAllDelivered()) broadcastThread(round, delivered);
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
					writeText(res, 409, "This round is not waiting on Pi.");
					return;
				}
				phase = "reviewing";
				broadcastPhase();
				writeJson(res, 200, { phase, currentRound: current().number });
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
		currentReview: () => current().review,
		currentRoundNumber: () => current().number,
		hasRound: (reviewId) => rounds.some((round) => round.review.id === reviewId),
		locateThread(threadId) {
			const round = roundOfThread(threadId);
			return round ? { round: round.number, current: round === current() } : undefined;
		},
		getThread: (threadId) => roundOfThread(threadId)?.store.getThread(threadId),
		threads: () => current().store.list(),
		threadSummary: () => current().store.summary(),
		viewedFiles: () => [...current().viewed],
		postPiReply(threadId, body, resolves) {
			const round = current();
			const thread = round.store.postPiReply(threadId, body, resolves);
			if (thread) broadcastThread(round, thread);
			return thread;
		},
		addRound(nextReview, previousRoundId, threadResponses) {
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
				return { identical: true, round: active.number };
			}
			if (nextReview.root !== active.review.root) return { error: "wrong-root" };
			let carried;
			try {
				carried = buildCarriedThreads(threadResponses, active.store.list(), nextReview, active.number);
			} catch (error) {
				return { error: "invalid-responses", message: error instanceof Error ? error.message : String(error) };
			}
			const previousSignatures = new Map(active.review.files.map((file) => [file.path, diffSignature(file)]));
			const viewed = new Set(nextReview.files.filter((file) => active.viewed.has(file.path) && previousSignatures.get(file.path) === diffSignature(file)).map((file) => file.path));
			const round = { number: active.number + 1, review: nextReview, store: createThreadStore(nextReview, THREAD_LIMITS, carried), viewed };
			rounds.push(round);
			phase = "reviewing";
			broadcast("round-ready", { round: round.number, previousRound: active.number });
			return { round: round.number };
		},
		async close() {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			for (const client of sseClients) client.end();
			sseClients.clear();
			for (const socket of sockets) socket.destroy();
			await new Promise((resolvePromise) => server.close(() => resolvePromise()));
		},
	};
}
