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
	previousRoundId: Type.Optional(Type.String({ minLength: 8, maxLength: 200, description: "Snapshot id of the current round of an open review session (the snapshot attribute of the code-review-pass message). Opens the revised changes as the next round in the same browser session instead of a fresh review." })),
	threadResponses: Type.Optional(Type.Array(Type.Object({
		respondsTo: Type.String({ minLength: 1, maxLength: 200, description: "Open thread id from the previous round's code-review-pass message." }),
		resolution: Type.String({ pattern: "^(addressed|declined|needs-discussion)$", description: "Whether the concern was addressed in this round, declined with rationale, or needs further discussion." }),
		body: Type.String({ minLength: 1, maxLength: 20_000, description: "Resolution commentary shown at the top of the carried thread." }),
		file: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000, description: "File in this round where the reviewer should verify the response. Omit only when the anchor is truly gone." })),
		side: Type.Optional(Type.String({ pattern: "^(old|new|both)$" })),
		startLine: Type.Optional(Type.Integer({ minimum: 1 })),
		endLine: Type.Optional(Type.Integer({ minimum: 1 })),
	}), { maxItems: 400, description: "Required with previousRoundId when the previous round has open threads: exactly one response per open thread, carrying the conversation into this round at an explicitly designated anchor." })),
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

	type ReviewRound = { number: number; review: { id: string; root: string } };
	const openReview = async (ctx: ExtensionContext, manifest: OpenCodeReviewInput | { title?: string; overview?: undefined; files: [] }, signal?: AbortSignal) => {
		const snapshot = await collectReviewSnapshot(ctx.cwd, { signal });
		const review = applyReviewManifest(snapshot, manifest);
		const previousRoundId = "previousRoundId" in manifest ? manifest.previousRoundId : undefined;
		if (!previousRoundId && "threadResponses" in manifest && manifest.threadResponses !== undefined) {
			throw new Error("threadResponses requires previousRoundId; fresh reviews have no threads to respond to.");
		}
		if (previousRoundId) {
			const server = [...servers].find((candidate) => candidate.hasRound(previousRoundId));
			if (!server) throw new Error(`No open review session contains round ${previousRoundId.slice(0, 12)}. Open a fresh review without previousRoundId.`);
			const added = server.addRound(review, previousRoundId, "threadResponses" in manifest ? manifest.threadResponses : undefined);
			if (added.error === "superseded") throw new Error(`Round ${previousRoundId.slice(0, 12)} is already superseded; the current round is ${added.currentRoundId?.slice(0, 12)} (round ${added.currentRound}).`);
			if (added.error === "wrong-root") throw new Error("The new snapshot belongs to a different repository than the open review session.");
			if (added.error === "invalid-responses") throw new Error(`Thread responses are invalid: ${added.message}`);
			if (added.error) throw new Error("Could not open the next review round.");
			if (server.clientCount() === 0) await openBrowser(server.entryUrl());
			return { review, server, round: added.round, identical: added.identical === true };
		}
		for (const stale of [...servers].filter((existing) => existing.root === review.root)) {
			servers.delete(stale);
			await stale.close();
		}
		const server = await createCodeReviewServer(review, {
			onThreadPost: async (round: ReviewRound, thread: ReviewThread, turns: ReviewThreadTurn[]) => {
				const queued = queue.post(formatThreadMessageXml(round.review, thread, turns, round.number), ctx.isIdle());
				ctx.ui.notify(`Review thread ${thread.id}: ${turns.length === 1 ? "new reviewer message" : `${turns.length} reviewer messages`}${queued ? " (queued until Pi settles)" : ""}.`, "info");
			},
			onFinishPass: async (round: ReviewRound, note: string | undefined, threads: ReviewThread[], summary: ReviewThreadSummary) => {
				let stale = true;
				try {
					stale = (await collectReviewSnapshot(round.review.root)).id !== round.review.id;
				} catch {}
				const queued = queue.post(formatReviewPassXml(round.review, threads, summary, stale, note, round.number), ctx.isIdle());
				ctx.ui.notify(`Review round ${round.number} pass finished: ${summary.open} open and ${summary.resolved} resolved thread(s)${queued ? " (queued until Pi settles)" : ""}.`, "info");
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
		return { review, server, round: 1, identical: false };
	};

	pi.registerTool({
		name: "open_code_review",
		label: "Open Code Review",
		description: "Open a frozen browser review of all staged, unstaged, and untracked changes against HEAD. Start with a concise review overview, then supply every changed file in the most logical review order with a concise file summary, review/reference classification, and optional line-anchored commentary. Reference files stay inspectable in a collapsed sidebar group. Omitted changed files are appended automatically; binary contents and oversized diffs are not rendered. The reviewer's browser posts live comment threads as code-review-thread messages; answer each with reply_review_thread, and treat the code-review-pass message as the signal that the pass is complete. After a pass, apply the feedback as one batch and call this tool again with previousRoundId set to that pass's snapshot id: the revised changes open as the next round of the same session and the reviewer's browser advances automatically. The next round must include threadResponses: exactly one {respondsTo, resolution, body} per open thread of the pass, each with an explicitly designated anchor (file plus optional lines) into the new snapshot, or no file only when the anchor is truly gone.",
		promptSnippet: "Open an ordered, agent-commented browser review of current Git changes",
		promptGuidelines: [
			"Use open_code_review when the user asks to be walked through or interactively review the agent's current code changes.",
			"Keep the open_code_review overview concise: under 500 words, one-sentence intent, two to four outcome bullets, one or two validation bullets, and only material optional review focus or risks.",
			"Use open_code_review reviewMode='reference' conservatively for visible files that do not merit focused review, such as binaries or deterministic generated artifacts; never use it to hide substantive source changes.",
			"After a code-review-pass message, apply the feedback as one batch, then reopen with previousRoundId set to that pass's snapshot id so the revised changes appear as the next round in the reviewer's open browser session.",
			"When opening a next round, answer every open thread from the pass in threadResponses with an honest resolution (addressed, declined, or needs-discussion) and anchor each response to the exact new code that proves it; never anchor somewhere unrelated to close a thread.",
		],
		parameters: openCodeReviewSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Collecting a frozen review snapshot…" }], details: {} });
			const { review, server, round, identical } = await openReview(ctx, params, signal);
			if (identical) {
				const ignoredResponses = "threadResponses" in params && params.threadResponses !== undefined ? " Your threadResponses were ignored: with no code change there is nothing to re-anchor, so answer those threads in place with reply_review_thread instead." : "";
				return {
					content: [{ type: "text", text: `The snapshot is identical to round ${round} — nothing changed since the reviewer's pass. The session stays on that round (unlocked if it was awaiting revision); continue answering its threads.${ignoredResponses}` }],
					details: { snapshot: review.id, round, identical: true },
				};
			}
			return {
				content: [{ type: "text", text: `Opened code review ${review.id.slice(0, 12)}${round && round > 1 ? ` as round ${round}; the reviewer's browser advances automatically` : ""} with ${review.files.length} changed file(s). The browser posts live comment threads; reply with reply_review_thread and wait for the reviewer's code-review-pass message.` }],
				details: { snapshot: review.id, round, files: review.files.map((file: { path: string }) => file.path), url: server.url.replace(/\?.*$/, "") },
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
			"Never edit code in response to an individual review thread; keep the worktree identical to the open snapshot until the code-review-pass message arrives, then apply feedback as one batch and open the next round with open_code_review previousRoundId set to that pass's snapshot id.",
		],
		parameters: replyReviewThreadSchema,
		async execute(_toolCallId, params) {
			for (const server of servers) {
				const location = server.locateThread(params.threadId);
				if (!location) continue;
				if (!location.current) throw new Error(`Thread ${params.threadId} belongs to superseded round ${location.round}; it is read-only. Respond to the reviewer in round ${server.currentRoundNumber()} instead.`);
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
