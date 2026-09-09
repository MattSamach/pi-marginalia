import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { spawn } from "node:child_process";
import { applyReviewManifest, collectReviewSnapshot } from "./shared/git-review.js";
import { createReviewMessageQueue } from "./shared/delivery-queue.js";
import { formatReviewPassXml, formatThreadMessageXml } from "./shared/feedback.js";
import { createCodeReviewServer } from "./shared/server.js";

type ReviewThreadTurn = { author: "user" | "pi"; body: string; ts: number };
type ReviewThread = {
	id: string;
	source: "selection" | "commentary" | "overview";
	status: "open" | "resolved";
	piProposedResolve: boolean;
	file?: string;
	commentaryId?: string;
	highlight?: string;
	turns: ReviewThreadTurn[];
};
type ReviewThreadSummary = { open: number; awaitingUser: number; awaitingPi: number; resolved: number };

const commentarySchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 20_000, description: "Stable ID unique within this file; used to identify user replies." }),
	body: Type.String({ minLength: 1, maxLength: 20_000, description: "Pi's explanation of this code or decision." }),
	side: Type.Optional(Type.String({ pattern: "^(old|new|both)$", description: "Diff side for an anchored note; defaults to both." })),
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	endLine: Type.Optional(Type.Integer({ minimum: 1 })),
});
const reviewFileSchema = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 20_000, description: "Repository-relative changed file path. Files are displayed in this array order." }),
	summary: Type.String({ maxLength: 20_000, description: "File-level purpose, design rationale, suggested review focus, or why a reference file needs no focused review." }),
	reviewMode: Type.Optional(Type.String({ pattern: "^(review|reference)$", description: "Use reference only for visible but low-value review artifacts such as binaries or deterministic generated output; defaults to review." })),
	commentary: Type.Optional(Type.Array(commentarySchema, { maxItems: 100 })),
});
const reviewOverviewSchema = Type.Object({
	intent: Type.String({ minLength: 1, maxLength: 500, description: "One sentence stating the problem and resulting behavior." }),
	changes: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 2, maxItems: 4, description: "Outcome-level changes; do not enumerate files." }),
	validation: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 2, description: "Meaningful automated or manual checks performed." }),
	reviewFocus: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "At most one area where human judgment is especially useful." })),
	risks: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "At most one material risk, limitation, or deferred gap." })),
});
const openCodeReviewSchema = Type.Object({
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
	overview: reviewOverviewSchema,
	files: Type.Array(reviewFileSchema, { maxItems: 500, description: "Ordered changed files. Any changed files omitted here are appended automatically." }),
});
export type OpenCodeReviewInput = Static<typeof openCodeReviewSchema>;
const replyReviewThreadSchema = Type.Object({
	threadId: Type.String({ minLength: 1, maxLength: 200, description: "Thread id from a code-review-thread message." }),
	body: Type.String({ minLength: 1, maxLength: 20_000, description: "Concise reply shown inside the reviewer's thread." }),
	resolves: Type.Optional(Type.Boolean({ description: "Propose resolution; only the reviewer's resolve action closes the thread." })),
});

type ReviewServer = Awaited<ReturnType<typeof createCodeReviewServer>>;
const CMUX_OPEN_TIMEOUT_MS = 2_500;

function getCmuxOpenCommand(url: string): { command: string; args: string[] } | undefined {
	const workspaceId = String(process.env.CMUX_WORKSPACE_ID ?? "").trim();
	const detected = Boolean(
		workspaceId ||
		String(process.env.TERM_PROGRAM ?? "").toLowerCase() === "cmux" ||
		String(process.env.TERM ?? "").toLowerCase().includes("cmux") ||
		String(process.env.CMUX_BUNDLE_ID ?? "").toLowerCase().includes("cmux"),
	);
	if (!detected) return undefined;
	const args = ["browser", "open", url];
	if (workspaceId) args.push("--workspace", workspaceId);
	args.push("--focus", "true");
	return { command: String(process.env.CMUX_BUNDLED_CLI_PATH ?? "").trim() || "cmux", args };
}

async function tryOpenInCmux(url: string): Promise<boolean> {
	const command = getCmuxOpenCommand(url);
	if (!command) return false;
	return await new Promise<boolean>((resolvePromise) => {
		let settled = false;
		const child = spawn(command.command, command.args, { stdio: "ignore" });
		const finish = (opened: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolvePromise(opened);
		};
		const timeout = setTimeout(() => { child.kill(); finish(false); }, CMUX_OPEN_TIMEOUT_MS);
		timeout.unref?.();
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}

async function openBrowser(url: string): Promise<void> {
	if (await tryOpenInCmux(url)) return;
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", rejectPromise);
		child.once("spawn", () => {
			child.off("error", rejectPromise);
			child.unref();
			resolvePromise();
		});
	});
}

export default function piCodeReview(pi: ExtensionAPI): void {
	const servers = new Set<ReviewServer>();
	const queue = createReviewMessageQueue((messages: string[]) => pi.sendUserMessage(messages.join("\n\n")));

	const openReview = async (ctx: ExtensionContext, manifest: OpenCodeReviewInput | { title?: string; overview?: undefined; files: [] }, signal?: AbortSignal) => {
		const snapshot = await collectReviewSnapshot(ctx.cwd, { signal });
		const review = applyReviewManifest(snapshot, manifest);
		for (const stale of [...servers].filter((existing) => existing.review.root === review.root)) {
			servers.delete(stale);
			await stale.close();
		}
		const server = await createCodeReviewServer(review, {
			onThreadPost: async (thread: ReviewThread, turn: ReviewThreadTurn) => {
				const queued = queue.post(formatThreadMessageXml(review, thread, turn), ctx.isIdle());
				ctx.ui.notify(`Review thread ${thread.id}: new reviewer message${queued ? " (queued until Pi settles)" : ""}.`, "info");
			},
			onFinishPass: async (note: string | undefined, threads: ReviewThread[], summary: ReviewThreadSummary) => {
				let stale = true;
				try {
					stale = (await collectReviewSnapshot(review.root)).id !== review.id;
				} catch {}
				const queued = queue.post(formatReviewPassXml(review, threads, summary, stale, note), ctx.isIdle());
				ctx.ui.notify(`Review pass finished: ${summary.open} open and ${summary.resolved} resolved thread(s)${queued ? " (queued until Pi settles)" : ""}.`, "info");
				return { stale };
			},
		});
		servers.add(server);
		try {
			await openBrowser(server.url);
		} catch (error) {
			servers.delete(server);
			await server.close();
			throw error;
		}
		return { review, server };
	};

	pi.registerTool({
		name: "open_code_review",
		label: "Open Code Review",
		description: "Open a frozen browser review of all staged, unstaged, and untracked changes against HEAD. Start with an extremely concise review overview, then supply every changed file in the most logical review order with a concise file summary, review/reference classification, and optional line-anchored commentary. Reference files stay inspectable in a collapsed sidebar group. Omitted changed files are appended automatically; binary contents and oversized diffs are not rendered. The reviewer's browser posts live comment threads as code-review-thread messages; answer each with reply_review_thread, and treat the code-review-pass message as the signal that the pass is complete.",
		promptSnippet: "Open an ordered, agent-commented browser review of current Git changes",
		promptGuidelines: [
			"Use open_code_review when the user asks to be walked through or interactively review the agent's current code changes.",
			"Keep the open_code_review overview extremely concise: under 150 words, one-sentence intent, two to four outcome bullets, one or two validation bullets, and only material optional review focus or risks.",
			"Use open_code_review reviewMode='reference' conservatively for visible files that do not merit focused review, such as binaries or deterministic generated artifacts; never use it to hide substantive source changes.",
		],
		parameters: openCodeReviewSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Collecting a frozen review snapshot…" }], details: {} });
			const { review, server } = await openReview(ctx, params, signal);
			return {
				content: [{ type: "text", text: `Opened code review ${review.id.slice(0, 12)} with ${review.files.length} changed file(s). The browser posts live comment threads; reply with reply_review_thread and wait for the reviewer's code-review-pass message.` }],
				details: { snapshot: review.id, files: review.files.map((file: { path: string }) => file.path), url: server.url.replace(/\?.*$/, "") },
			};
		},
	});

	pi.registerTool({
		name: "reply_review_thread",
		label: "Reply Review Thread",
		description: "Reply inside a live comment thread of the open browser code review. Use the thread id from the code-review-thread message. Set resolves=true to propose resolution; only the reviewer's explicit resolve action closes a thread.",
		promptSnippet: "Reply to a live browser code-review comment thread",
		promptGuidelines: [
			"When a code-review-thread message arrives, answer promptly with reply_review_thread using that thread id.",
			"Answer each thread message inside exactly the thread that raised it, taking the thread id from the incoming message; never post placeholder or cross-reference replies into other threads.",
			"Keep review-thread replies concise and specific to the anchored code; use chat for broader discussion.",
			"Set resolves=true only when the concern is fully addressed, and never treat a proposal as a resolution.",
			"Never edit code in response to an individual review thread; keep the worktree identical to the open snapshot until the code-review-pass message arrives, then apply feedback as one batch and open a fresh review.",
		],
		parameters: replyReviewThreadSchema,
		async execute(_toolCallId, params) {
			for (const server of servers) {
				if (!server.getThread(params.threadId)) continue;
				const thread: ReviewThread | undefined = server.postPiReply(params.threadId, params.body, params.resolves === true);
				if (!thread) throw new Error(`Reply to thread ${params.threadId} was rejected; the thread may have reached its turn limit.`);
				const summary = server.threadSummary();
				return {
					content: [{ type: "text", text: `Replied in thread ${thread.id} (${thread.status}${thread.piProposedResolve ? ", resolution proposed" : ""}). Review now has ${summary.open} open and ${summary.resolved} resolved thread(s).` }],
					details: { thread: thread.id, status: thread.status, piProposedResolve: thread.piProposedResolve },
				};
			}
			throw new Error(`No open code review contains thread ${params.threadId}.`);
		},
	});

	pi.registerCommand("review-browser", {
		description: "Open a static browser review of staged, unstaged, and untracked changes against HEAD (--help for usage)",
		handler: async (args, ctx) => {
			const normalized = args.trim();
			if (normalized === "--help" || normalized === "-h") {
				ctx.ui.notify("Usage: /review-browser\n\nOpens one frozen unified-diff snapshot of all staged, unstaged, and untracked changes against HEAD. For Pi-authored ordering and commentary, ask Pi to use open_code_review.", "info");
				return;
			}
			if (normalized) {
				ctx.ui.notify("Unknown arguments. Usage: /review-browser [--help]", "warning");
				return;
			}
			try {
				const { review } = await openReview(ctx, { files: [] });
				ctx.ui.notify(`Opened static review ${review.id.slice(0, 12)} (${review.files.length} files).`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			queue.flush(ctx.isIdle());
		} catch {
			// A failed delivery keeps the batch queued; retry at the next settle.
		}
	});

	pi.on("session_shutdown", async () => {
		const active = [...servers];
		servers.clear();
		await Promise.all(active.map((server) => server.close()));
	});
}
