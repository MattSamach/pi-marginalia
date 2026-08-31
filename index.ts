import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { spawn } from "node:child_process";
import { applyReviewManifest, collectReviewSnapshot } from "./shared/git-review.js";
import { formatCodeReviewFeedbackXml } from "./shared/feedback.js";
import { createCodeReviewServer } from "./shared/server.js";

const commentarySchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 20_000, description: "Stable ID unique within this file; used to identify user replies." }),
	body: Type.String({ minLength: 1, maxLength: 20_000, description: "Pi's explanation of this code or decision." }),
	side: Type.Optional(Type.String({ pattern: "^(old|new|both)$", description: "Diff side for an anchored note; defaults to both." })),
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	endLine: Type.Optional(Type.Integer({ minimum: 1 })),
});
const reviewFileSchema = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 20_000, description: "Repository-relative changed file path. Files are displayed in this array order." }),
	summary: Type.String({ maxLength: 20_000, description: "File-level purpose, design rationale, and suggested review focus." }),
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

	const openReview = async (ctx: ExtensionContext, manifest: OpenCodeReviewInput | { title?: string; overview?: undefined; files: [] }, signal?: AbortSignal) => {
		const snapshot = await collectReviewSnapshot(ctx.cwd, { signal });
		const review = applyReviewManifest(snapshot, manifest);
		const server = await createCodeReviewServer(review, {
			onFeedback: async (feedback: Parameters<typeof formatCodeReviewFeedbackXml>[2]) => {
			let stale = true;
			try {
				stale = (await collectReviewSnapshot(review.root)).id !== review.id;
			} catch {}
			const xml = formatCodeReviewFeedbackXml(review.id, stale, feedback);
			if (ctx.isIdle()) pi.sendUserMessage(xml);
			else pi.sendUserMessage(xml, { deliverAs: "followUp" });
			const overviewCount = feedback.overviewFeedback ? 1 : 0;
			ctx.ui.notify(`Received ${overviewCount} overview comment(s), ${feedback.comments.length} diff comment(s), and ${feedback.replies.length} commentary reply/replies.`, "info");
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
		description: "Open a frozen browser review of all staged, unstaged, and untracked changes against HEAD. Start with an extremely concise review overview, then supply every changed file in the most logical review order with a concise file summary and optional line-anchored commentary. Omitted changed files are appended automatically; binary contents and oversized diffs are not rendered.",
		promptSnippet: "Open an ordered, agent-commented browser review of current Git changes",
		promptGuidelines: [
			"Use open_code_review when the user asks to be walked through or interactively review the agent's current code changes.",
			"Keep the open_code_review overview extremely concise: under 100 words, one-sentence intent, two to four outcome bullets, one or two validation bullets, and only material optional review focus or risks.",
		],
		parameters: openCodeReviewSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Collecting a frozen review snapshot…" }], details: {} });
			const { review, server } = await openReview(ctx, params, signal);
			return {
				content: [{ type: "text", text: `Opened code review ${review.id.slice(0, 12)} with ${review.files.length} changed file(s). The browser may now submit one static feedback batch.` }],
				details: { snapshot: review.id, files: review.files.map((file: { path: string }) => file.path), url: server.url.replace(/\?.*$/, "") },
			};
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

	pi.on("session_shutdown", async () => {
		const active = [...servers];
		servers.clear();
		await Promise.all(active.map((server) => server.close()));
	});
}
