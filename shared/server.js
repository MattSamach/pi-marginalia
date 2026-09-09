import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { renderReviewHtml } from "./render.js";
import { createThreadStore, THREAD_LIMITS } from "./threads.js";

const POST_PATH = "/__pi_code_review_post__";
const RESOLVE_PATH = "/__pi_code_review_resolve__";
const FINISH_PATH = "/__pi_code_review_finish__";
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

/** Start an authenticated localhost server hosting one immutable review snapshot with live comment threads. */
export async function createCodeReviewServer(review, options) {
	if (typeof options?.onThreadPost !== "function" || typeof options?.onFinishPass !== "function") {
		throw new Error("Code review server requires onThreadPost and onFinishPass callbacks.");
	}
	const store = createThreadStore(review);
	const token = randomBytes(24).toString("base64url");
	const cookieName = `pi_code_review_${randomBytes(8).toString("hex")}`;
	let port = 0;
	let finishing = false;
	let closed = false;
	let tokenRedeemed = false;
	const sockets = new Set();
	const sseClients = new Set();

	const broadcast = (event, data) => {
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of sseClients) client.write(frame);
	};
	const broadcastThread = (thread) => broadcast("thread", { thread, summary: store.summary() });
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
	const readGuardedBody = async (req, res) => {
		try {
			return await readJsonBody(req);
		} catch (error) {
			writeText(res, error?.message === "too-large" ? 413 : 400, error?.message === "too-large" ? "Request payload is too large." : "Invalid JSON.");
			return undefined;
		}
	};

	const server = createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const expectedCookie = `${cookieName}=${token}`;
			const authenticated = (req.headers.cookie ?? "").split(";").some((part) => part.trim() === expectedCookie);
			if (req.method === "GET" && requestUrl.pathname === "/" && requestUrl.searchParams.get("token") === token) {
				if (tokenRedeemed && !authenticated) {
					writeText(res, 403, "This review link was already used. Ask Pi to reopen the review.");
					return;
				}
				tokenRedeemed = true;
				res.writeHead(302, {
					...SECURITY_HEADERS,
					Location: "/",
					"Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
				});
				res.end();
				return;
			}
			if (!authenticated) {
				writeText(res, 403, "Forbidden");
				return;
			}
			if (req.method === "GET" && requestUrl.pathname === "/") {
				const nonce = randomBytes(18).toString("base64");
				res.writeHead(200, htmlHeaders(nonce));
				res.end(renderReviewHtml(review, nonce));
				return;
			}
			if (req.method === "GET" && requestUrl.pathname === EVENTS_PATH) {
				res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
				res.write(`event: init\ndata: ${JSON.stringify({ threads: store.list(), summary: store.summary() })}\n\n`);
				sseClients.add(res);
				req.on("close", () => sseClients.delete(res));
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === POST_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				const result = store.postUserTurn(body);
				if (result.error) {
					const mapped = STORE_ERRORS[result.error] ?? STORE_ERRORS.invalid;
					writeText(res, mapped.status, mapped.message);
					return;
				}
				broadcastThread(result.thread);
				let deliveryFailed = false;
				try {
					await options.onThreadPost(result.thread, result.thread.turns[result.thread.turns.length - 1]);
				} catch {
					deliveryFailed = true;
				}
				writeJson(res, 200, { thread: result.thread, summary: store.summary(), ...(deliveryFailed ? { deliveryFailed: true } : {}) });
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === RESOLVE_PATH) {
				if (!guardMutation(req, res)) return;
				const body = await readGuardedBody(req, res);
				if (body === undefined) return;
				if (!body || typeof body !== "object" || typeof body.resolved !== "boolean") {
					writeText(res, 400, "Invalid resolve payload.");
					return;
				}
				const thread = store.setResolved(body.threadId, body.resolved);
				if (!thread) {
					writeText(res, 404, "Unknown thread.");
					return;
				}
				broadcastThread(thread);
				writeJson(res, 200, { thread, summary: store.summary() });
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
				if (finishing) {
					writeText(res, 409, "A finish-pass handoff is already in progress.");
					return;
				}
				finishing = true;
				let result;
				try {
					result = await options.onFinishPass(note, store.list(), store.summary());
				} finally {
					finishing = false;
				}
				writeJson(res, 200, { stale: result?.stale === true });
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
		url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
		port,
		review,
		getThread: (threadId) => store.getThread(threadId),
		threads: () => store.list(),
		threadSummary: () => store.summary(),
		postPiReply(threadId, body, resolves) {
			const thread = store.postPiReply(threadId, body, resolves);
			if (thread) broadcastThread(thread);
			return thread;
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
