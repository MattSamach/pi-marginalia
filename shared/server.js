import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { renderReviewHtml } from "./render.js";
import { FEEDBACK_LIMITS, parseCodeReviewFeedback } from "./feedback.js";

const FEEDBACK_PATH = "/__pi_code_review_feedback__";
const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
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

async function readJsonBody(req) {
	const declared = Number(req.headers["content-length"] ?? 0);
	if (Number.isFinite(declared) && declared > FEEDBACK_LIMITS.maxBodyBytes) throw new Error("too-large");
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > FEEDBACK_LIMITS.maxBodyBytes) throw new Error("too-large");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("invalid-json");
	}
}

/** Start an authenticated localhost server for one immutable review snapshot. */
export async function createCodeReviewServer(review, options) {
	if (typeof options?.onFeedback !== "function") throw new Error("Code review server requires an onFeedback callback.");
	const token = randomBytes(24).toString("base64url");
	const cookieName = `pi_code_review_${randomBytes(8).toString("hex")}`;
	let port = 0;
	let submitting = false;
	let submitted = false;
	let closed = false;
	const sockets = new Set();
	const server = createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const expectedCookie = `${cookieName}=${token}`;
			const authenticated = (req.headers.cookie ?? "").split(";").some((part) => part.trim() === expectedCookie);
			if (req.method === "GET" && requestUrl.pathname === "/" && requestUrl.searchParams.get("token") === token) {
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
			if (req.method === "POST" && requestUrl.pathname === FEEDBACK_PATH) {
				if (submitting || submitted) {
					writeText(res, 409, "Feedback was already submitted for this snapshot.");
					return;
				}
				if (req.headers.origin !== `http://127.0.0.1:${port}`) {
					writeText(res, 403, "Invalid origin.");
					return;
				}
				if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
					writeText(res, 415, "Expected application/json.");
					return;
				}
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					writeText(res, error?.message === "too-large" ? 413 : 400, error?.message === "too-large" ? "Feedback payload is too large." : "Invalid JSON.");
					return;
				}
				const feedback = parseCodeReviewFeedback(body, review);
				if (!feedback) {
					writeText(res, 400, "Invalid feedback payload.");
					return;
				}
				if (submitting || submitted) {
					writeText(res, 409, "Feedback was already submitted for this snapshot.");
					return;
				}
				submitting = true;
				let result;
				try {
					result = await options.onFeedback(feedback);
					submitted = true;
				} catch (error) {
					submitting = false;
					throw error;
				}
				res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ stale: result?.stale === true }));
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
		async close() {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.destroy();
			await new Promise((resolvePromise) => server.close(() => resolvePromise()));
		},
	};
}
