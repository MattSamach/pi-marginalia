import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { applyReviewManifest, collectReviewSnapshot, computeWorktreeFingerprint, createPinnedBlobContextReader, currentSnapshotId, currentSnapshotProbe } from "./shared/git-review.js";
import { createReviewMessageQueue } from "./shared/delivery-queue.js";
import { formatReviewApprovedXml, formatReviewPassXml, formatThreadContextXml, formatThreadMessageXml } from "./shared/feedback.js";
import { createCodeReviewServer } from "./shared/server.js";
import { buildDiagramReview, buildPlanReview, resolvePlanResponses } from "./shared/plan-review.js";
import { BOOT_HEAL_MAX_AGE_MS, deleteSession, isClaimed, listSessions, saveSession, sweepSessions } from "./shared/persistence.js";

type ReviewThreadTurn = { author: "user" | "pi"; body: string; ts: number; seq?: number; delivered?: boolean };
type ReviewThread = {
	id: string;
	source: "selection" | "commentary" | "overview";
	status: "open" | "resolved";
	piProposedResolve: boolean;
	file?: string;
	commentaryId?: string;
	highlight?: string;
	queued?: boolean;
	pending?: number;
	side?: string;
	startLine?: number;
	endLine?: number;
	oldStart?: number;
	oldEnd?: number;
	newStart?: number;
	newEnd?: number;
	carried?: { fromRound: number; resolution: string; placement: string; side?: string; startLine?: number; endLine?: number };
	replyState?: "sent" | "working" | "seen";
	turns: ReviewThreadTurn[];
};
type ReviewThreadSummary = { open: number; awaitingUser: number; awaitingPi: number; resolved: number };
type SessionNotice = { title: string; kind: string; round: number; open: number; ageMinutes: number; url?: string };
type SessionNoticeDetails = { mode: "resumed" | "resumable"; sessions: SessionNotice[] };

const SESSION_NOTICE_TYPE = "marginalia-sessions";
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const formatAge = (minutes: number) => (minutes < 1 ? "active just now" : minutes < 60 ? `active ${minutes}m ago` : `active ${Math.round(minutes / 60)}h ago`);

function formatSessionNoticeXml({ mode, sessions }: SessionNoticeDetails): string {
	const describe = (s: SessionNotice) => `"${s.title}" (${s.kind}, round ${s.round}, ${s.open} open thread(s), last active ${s.ageMinutes}m ago${s.url ? `, ${s.url}` : ""})`;
	const list = sessions.map(describe).join(" · ");
	return mode === "resumed"
		? `<marginalia-sessions resumed="${sessions.length}">Marginalia resumed ${sessions.length} review session(s) from before the restart: ${list}. Open browser tabs reconnect on their own; the links mint fresh entry tokens if a tab was closed.</marginalia-sessions>`
		: `<marginalia-sessions resumable="${sessions.length}">Marginalia found ${sessions.length} resumable review session(s) on disk (bootHeal is off): ${list}. Open the next round with previousRoundId to resume one.</marginalia-sessions>`;
}

const commentarySchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 20_000, description: "Stable ID unique within this file; used to identify user replies." }),
	body: Type.String({ minLength: 1, maxLength: 20_000, description: "Pi's explanation of this code or decision." }),
	side: Type.Optional(Type.String({ pattern: "^(old|new|both)$", description: "Diff side for an anchored note; defaults to both." })),
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	endLine: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const reviewFileSchema = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 20_000, description: "Repository-relative changed file path. Files are displayed in this array order." }),
	summary: Type.Optional(Type.String({ maxLength: 20_000, description: "File-level purpose, design rationale, suggested review focus, or why a reference file needs no focused review. On a next round, omit it to carry the previous round's summary, classification, and commentary forward — allowed only while the file's content is byte-identical; changed files must be re-authored." })),
	reviewMode: Type.Optional(Type.String({ pattern: "^(review|reference)$", description: "Use reference only for visible but low-value review artifacts such as binaries or deterministic generated output; defaults to review." })),
	commentary: Type.Optional(Type.Array(commentarySchema, { maxItems: 100 })),
}, { additionalProperties: false });
const reviewOverviewSchema = Type.Object({
	intent: Type.String({ minLength: 1, maxLength: 500, description: "One sentence stating the problem and resulting behavior." }),
	changes: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 2, maxItems: 4, description: "Outcome-level changes; do not enumerate files." }),
	validation: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 2, description: "Meaningful automated or manual checks performed." }),
	reviewFocus: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "At most one area where human judgment is especially useful." })),
	risks: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "At most one material risk, limitation, or deferred gap." })),
}, { additionalProperties: false });
const planCommentarySchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 20_000, description: "Stable ID unique within this plan; used to identify user replies." }),
	body: Type.String({ minLength: 1, maxLength: 20_000, description: "Pi's note on this part of the plan — rationale, tradeoff, open question." }),
	startLine: Type.Optional(Type.Integer({ minimum: 1, description: "Absolute 1-based source line in the plan markdown this note anchors to; must fall inside its section." })),
	endLine: Type.Optional(Type.Integer({ minimum: 1 })),
	element: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Diagram element this note anchors to: \"node:<id>\" or \"edge:<from>-><to>\" from a mermaid fence in the same section. May accompany or replace a line anchor." })),
}, { additionalProperties: false });
const planSectionSchema = Type.Object({
	heading: Type.String({ minLength: 1, maxLength: 500, description: "Exact heading text of a plan section (case-insensitive match)." }),
	commentary: Type.Optional(Type.Array(planCommentarySchema, { maxItems: 20 })),
}, { additionalProperties: false });
const openPlanReviewSchema = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 200 }),
	markdown: Type.String({ minLength: 1, maxLength: 1_048_576, description: "The full plan document as markdown. It is sliced into sections at its shallowest heading level; the reviewer annotates the rendered document." }),
	proposedApprovalNote: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000, description: "Prefilled on the reviewer's Approve screen as the approval note; the reviewer may edit it. Omitted next rounds keep the previous proposal." })),
	sections: Type.Optional(Type.Array(planSectionSchema, { maxItems: 200, description: "Optional per-section summaries and anchored commentary, referenced by heading text." })),
	previousRoundId: Type.Optional(Type.String({ minLength: 8, maxLength: 200, description: "Snapshot id of the current round of an open plan session (the snapshot attribute of the plan-review-pass message). Opens the revised plan as the next round in the same browser session." })),
	threadResponses: Type.Optional(Type.Array(Type.Object({
		respondsTo: Type.String({ minLength: 1, maxLength: 200, description: "Open thread id from the previous round's plan-review-pass message." }),
		resolution: Type.String({ pattern: "^(addressed|declined|needs-discussion)$" }),
		body: Type.String({ minLength: 1, maxLength: 20_000, description: "Resolution commentary shown at the top of the carried thread. It renders in the same narrow rail as thread replies — lead with the answer and keep it under ~80 words; the anchor, not the prose, carries the proof." }),
		file: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Section of the new plan (heading text or slug) where the reviewer should verify the response. Omit only when the anchor is truly gone." })),
		startLine: Type.Optional(Type.Integer({ minimum: 1, description: "Absolute source line in the NEW plan markdown." })),
		endLine: Type.Optional(Type.Integer({ minimum: 1 })),
		element: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Diagram element in the NEW plan the response re-anchors to (\"node:<id>\" or \"edge:<from>-><to>\"); requires file." })),
	}), { maxItems: 400, description: "Required with previousRoundId when the previous round has threads awaiting you (reviewer spoke last): exactly one response per awaiting thread; threads you answered last carry forward automatically when omitted." })),
});
type OpenPlanReviewInput = Static<typeof openPlanReviewSchema>;
const openDiagramReviewSchema = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 200 }),
	diagrams: Type.Array(Type.Object({
		name: Type.String({ minLength: 1, maxLength: 200, description: "Unique diagram name; becomes its section heading in the sidebar. No newlines, hashes, or backticks." }),
		source: Type.String({ minLength: 1, maxLength: 100_000, description: "Mermaid source rendered as a live, clickable diagram. Use stable semantic element ids — they are the thread anchor contract across rounds." }),
		caption: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, description: "Optional one-paragraph framing rendered beneath the diagram." })),
		commentary: Type.Optional(Type.Array(planCommentarySchema, { maxItems: 20, description: "Margin notes; anchor to diagram elements with element: \"node:<id>\" or \"edge:<from>-><to>\"." })),
	}), { minItems: 1, maxItems: 40, description: "Ordered diagrams; each becomes one section of the generated document." }),
	proposedApprovalNote: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000, description: "Prefilled on the reviewer's Approve screen; the reviewer may edit it." })),
	previousRoundId: Type.Optional(Type.String({ minLength: 8, maxLength: 200, description: "Snapshot id of the current round of an open session (from the plan-review-pass message). Opens the revised diagrams as the next round." })),
	threadResponses: openPlanReviewSchema.properties.threadResponses,
});
type OpenDiagramReviewInput = Static<typeof openDiagramReviewSchema>;

const openCodeReviewSchema = Type.Object({
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
	proposedCommitMessage: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000, description: "Proposed commit message prefilled on the reviewer's Approve screen; the reviewer may edit it before approving. Omitted next rounds keep the previous proposal." })),
	overview: reviewOverviewSchema,
	repoPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096, description: "Directory of (or inside) the Git repository to review. Defaults to the session working directory. Rounds of one session must all use the same repository." })),
	files: Type.Array(reviewFileSchema, { maxItems: 500, description: "Ordered changed files. Any changed files omitted here are appended automatically." }),
	previousRoundId: Type.Optional(Type.String({ minLength: 8, maxLength: 200, description: "Snapshot id of the current round of an open review session (the snapshot attribute of the code-review-pass message). Opens the revised changes as the next round in the same browser session instead of a fresh review." })),
	threadResponses: Type.Optional(Type.Array(Type.Object({
		respondsTo: Type.String({ minLength: 1, maxLength: 200, description: "Open thread id from the previous round's code-review-pass message." }),
		resolution: Type.String({ pattern: "^(addressed|declined|needs-discussion)$", description: "Whether the concern was addressed in this round, declined with rationale, or needs further discussion." }),
		body: Type.String({ minLength: 1, maxLength: 20_000, description: "Resolution commentary shown at the top of the carried thread. It renders in the same narrow rail as thread replies — lead with the answer and keep it under ~80 words; the anchor, not the prose, carries the proof." }),
		file: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000, description: "File in this round where the reviewer should verify the response. Omit only when the anchor is truly gone." })),
		side: Type.Optional(Type.String({ pattern: "^(old|new|both)$" })),
		startLine: Type.Optional(Type.Integer({ minimum: 1 })),
		endLine: Type.Optional(Type.Integer({ minimum: 1 })),
	}), { maxItems: 400, description: "Required with previousRoundId when the previous round has threads awaiting you (reviewer spoke last): exactly one response per awaiting thread. Threads you answered last may be omitted — they carry forward automatically; voluntary responses to them are also accepted." })),
});
export type OpenCodeReviewInput = Static<typeof openCodeReviewSchema>;
const listReviewThreadsSchema = Type.Object({
	includeResolved: Type.Optional(Type.Boolean({ description: "Also list resolved threads (default: open threads only)." })),
});

const getReviewThreadSchema = Type.Object({
	threadId: Type.String({ minLength: 1, maxLength: 200, description: "Thread id from any code-review message or list_review_threads." }),
	lastTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Return only the newest N messages — a cheaper context lever for long threads." })),
});

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
	// The freshest tool/event context, for sessions healed from disk that have
	// no originating tool call to borrow idle-state and notifications from.
	let lastCtx: ExtensionContext | undefined;
	type PersistedSession = {
		id: string;
		kind?: string;
		title?: string;
		root?: string;
		scopePath?: string;
		lastActive?: number;
		pid?: number;
		port?: number;
		phase?: string;
		rounds: { number: number; review: { id: string; title?: string }; store: { threads: { status: string }[] } }[];
	};
	const persistState = async (state: { id: string; phase?: string }) => {
		if (state.phase === "approved" || state.phase === "closed") await deleteSession(state.id);
		else await saveSession(state);
	};

	type ReviewRound = { number: number; review: { id: string; root: string } };
	// Optional appearance defaults from ~/.pi/agent/marginalia.json ({"theme","scheme"}).
	// Read per session open so edits apply to the next review without a restart;
	// invalid or missing values fall back to the built-in defaults, and a
	// reviewer's in-browser picker choice still wins over both.
	const loadAppearance = async (): Promise<{ theme?: string; scheme?: string; bootHeal?: boolean } | undefined> => {
		try {
			const parsed = JSON.parse(await readFile(resolve(homedir(), ".pi/agent/marginalia.json"), "utf8"));
			if (parsed && typeof parsed === "object") return { theme: parsed.theme, scheme: parsed.scheme, bootHeal: parsed.bootHeal };
		} catch {}
		return undefined;
	};
	const buildCallbacks = (kind: string | undefined, getCtx: () => ExtensionContext | undefined) => {
		const noun = kind === "plan" ? "Plan" : "Review";
		const idleNow = () => {
			const ctx = getCtx();
			try {
				return ctx ? ctx.isIdle() : false;
			} catch {
				return false;
			}
		};
		const notify = (text: string) => {
			try {
				getCtx()?.ui.notify(text, "info");
			} catch {}
		};
		return {
			isTurnActive: () => {
				const ctx = getCtx();
				try {
					return ctx ? !ctx.isIdle() : false;
				} catch {
					return false;
				}
			},
			onThreadPost: async (round: ReviewRound, thread: ReviewThread, turns: ReviewThreadTurn[]) => {
				// Same-thread turns queued during one busy stretch coalesce into a
				// single envelope at flush; the payload freezes copies at post time
				// (matching the old pre-formatted-string behavior), and merge keeps
				// the newest thread attributes with all turns in post order.
				const queued = queue.post({
					key: `${round.review.id}:${thread.id}`,
					payload: { review: round.review, thread: { ...thread }, turns: turns.map((turn) => ({ ...turn })), round: round.number },
					merge: (prev: { turns: ReviewThreadTurn[] }, next: { turns: ReviewThreadTurn[] }) => ({ ...next, turns: [...prev.turns, ...next.turns] }),
					render: (payload: { review: ReviewRound["review"]; thread: ReviewThread; turns: ReviewThreadTurn[]; round: number }) => formatThreadMessageXml(payload.review, payload.thread, payload.turns, payload.round),
				}, idleNow());
				// The message is accepted once queue.post returns; a notify failure must
				// not be reported as a delivery failure (the server would requeue an
				// escalation whose content is already on its way).
				notify(`${noun} thread ${thread.id}: ${turns.length === 1 ? "new reviewer message" : `${turns.length} reviewer messages`}${queued ? " (queued until Pi settles)" : ""}.`);
				// The server stamps the thread's reply-state from this verdict: queued
				// content is sent (awaiting the settle flush), immediate is working.
				return { queued };
			},
			onFinishPass: async (round: ReviewRound, note: string | undefined, threads: ReviewThread[], summary: ReviewThreadSummary) => {
				// Plans have no worktree to drift from; only code snapshots re-check.
				let stale = false;
				if (kind !== "plan") {
					stale = true;
					try {
						stale = (await currentSnapshotId(round.review.root)) !== round.review.id;
					} catch {}
				}
				const queued = queue.post(formatReviewPassXml(round.review, threads, summary, stale, note, round.number), idleNow());
				notify(`${noun} round ${round.number} pass finished: ${summary.open} open and ${summary.resolved} resolved thread(s)${queued ? " (queued until Pi settles)" : ""}.`);
				// queued tells the server how to stamp the reply-state of the threads
				// this pass delivers: sent while the pass waits, working once in context.
				return { stale, queued };
			},
			onApprove: async (round: ReviewRound, message: string, staleNow: boolean) => {
				const queued = queue.post(formatReviewApprovedXml(round.review, round.number, message, staleNow), idleNow());
				notify(`${noun} round ${round.number} approved${staleNow ? " (worktree has drifted)" : ""}${queued ? " (queued until Pi settles)" : ""}.`);
			},
		};
	};
	// Resurrect a persisted session so a previousRoundId or a reconnecting tab
	// keeps working across pi restarts. The healed server prefers its old port
	// (the tab's EventSource retry loop then reconnects unaided) and reuses its
	// persisted cookie material so the reviewer's session stays authenticated.
	const healFromState = async (state: PersistedSession) => {
		const kind = state.kind === "plan" ? "plan" : "code";
		const extras: Record<string, unknown> = kind === "code" && state.root
			? {
				staleness: { fingerprint: () => computeWorktreeFingerprint(state.root as string), snapshot: () => currentSnapshotProbe(state.root as string) },
				contextLines: createPinnedBlobContextReader(),
			}
			: {};
		const server = await createCodeReviewServer(state.rounds[state.rounds.length - 1].review, {
			appearance: await loadAppearance(),
			...buildCallbacks(kind, () => lastCtx),
			...extras,
			restore: state,
			preferredPort: state.port,
			scopePath: state.scopePath,
			onPersist: persistState,
		});
		servers.add(server);
		return server;
	};
	const findSessionWithRound = async (roundId: string) => {
		const live = [...servers].find((candidate) => candidate.hasRound(roundId));
		if (live) return live;
		for (const state of await listSessions()) {
			if (state.phase === "approved" || state.phase === "closed") continue;
			if (!state.rounds?.some((round: { review?: { id?: string } }) => round.review?.id === roundId)) continue;
			if (isClaimed(state)) throw new Error(`Round ${roundId.slice(0, 12)} belongs to a review session live in another pi process.`);
			return healFromState(state);
		}
		return undefined;
	};
	const openSession = async (ctx: ExtensionContext, review: { kind?: string; id: string; root: string; title: string; files: { path: string }[] }, previousRoundId: string | undefined, threadResponses: unknown, serverExtras: Record<string, unknown>) => {
		lastCtx = ctx;
		if (previousRoundId) {
			const server = await findSessionWithRound(previousRoundId);
			if (!server) throw new Error(`No open review session contains round ${previousRoundId.slice(0, 12)}. Open a fresh review without previousRoundId.`);
			const added = server.addRound(review, previousRoundId, threadResponses);
			if (added.error === "approved") throw new Error("This review session was approved and is closed; open a fresh review without previousRoundId if another unit needs review.");
			if (added.error === "closed") throw new Error("This review session was closed; open a fresh review without previousRoundId if another unit needs review.");
			if (added.error === "superseded") throw new Error(`Round ${previousRoundId.slice(0, 12)} is already superseded; the current round is ${added.currentRoundId?.slice(0, 12)} (round ${added.currentRound}).`);
			if (added.error === "wrong-root") throw new Error("The new snapshot belongs to a different repository than the open review session.");
			if (added.error === "invalid-responses") throw new Error(`Thread responses are invalid: ${added.message}`);
			if (added.error) throw new Error("Could not open the next review round.");
			if (server.clientCount() === 0) await openBrowser(server.entryUrl());
			return { review, server, round: added.round, identical: added.identical === true };
		}
		for (const stale of [...servers].filter((existing) => existing.root === review.root)) {
			servers.delete(stale);
			// A same-root replacement supersedes the old session: its close writes
			// a final state, then the file is removed so no boot resurrects it.
			const staleId = stale.serializeSession().id;
			await stale.close();
			await deleteSession(staleId);
		}
		const server = await createCodeReviewServer(review, {
			appearance: await loadAppearance(),
			...buildCallbacks(review.kind, () => ctx),
			...serverExtras,
			scopePath: review.kind === "plan" ? ctx.cwd : review.root,
			onPersist: persistState,
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
	const resolveRepoArg = async (ctx: ExtensionContext, value: string): Promise<string> => {
		const expanded = value === "~" || value.startsWith("~/") ? homedir() + value.slice(1) : value;
		const root = isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
		const probe = await stat(root).catch(() => undefined);
		if (!probe?.isDirectory()) throw new Error(`${root} is not a directory.`);
		return root;
	};
	const openReview = async (ctx: ExtensionContext, manifest: OpenCodeReviewInput | { title?: string; overview?: undefined; files: [] }, signal?: AbortSignal, root?: string) => {
		const repoPath = "repoPath" in manifest && typeof manifest.repoPath === "string" ? await resolveRepoArg(ctx, manifest.repoPath) : undefined;
		const snapshot = await collectReviewSnapshot(root ?? repoPath ?? ctx.cwd, { signal });
		const previousRoundId = "previousRoundId" in manifest ? manifest.previousRoundId : undefined;
		if (!previousRoundId && "threadResponses" in manifest && manifest.threadResponses !== undefined) {
			throw new Error("threadResponses requires previousRoundId; fresh reviews have no threads to respond to.");
		}
		// Agent calls always carry a previous-files context ([] on round 1) so
		// omitted summaries carry forward on identical content or fail loudly;
		// the empty round-1 context makes a missing first summary an error.
		let previousFiles: { path: string }[] = [];
		if (previousRoundId) {
			const host = await findSessionWithRound(previousRoundId);
			if (!host) throw new Error(`No open review session contains round ${previousRoundId.slice(0, 12)}. Open a fresh review without previousRoundId.`);
			previousFiles = host.roundFiles(previousRoundId) ?? [];
		}
		const review = applyReviewManifest(snapshot, manifest, undefined, previousFiles);
		return openSession(ctx, review, previousRoundId, "threadResponses" in manifest ? manifest.threadResponses : undefined, {
			staleness: {
				fingerprint: () => computeWorktreeFingerprint(review.root),
				snapshot: () => currentSnapshotProbe(review.root),
			},
			contextLines: createPinnedBlobContextReader(),
		});
	};
	// The latest assistant markdown in the current branch, for reviewing Pi's
	// own response as a document.
	const lastAssistantMarkdown = (ctx: ExtensionContext): string | undefined => {
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (!("role" in message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
			const text = message.content
				.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" && !!block.text.trim())
				.map((block) => block.text)
				.join("\n\n");
			if (text) return text;
		}
		return undefined;
	};
	const openPlan = async (ctx: ExtensionContext, manifest: OpenPlanReviewInput) => {
		if (!manifest.previousRoundId && manifest.threadResponses !== undefined) {
			throw new Error("threadResponses requires previousRoundId; fresh plans have no threads to respond to.");
		}
		// Next rounds carry the previous round's commentary for sections whose
		// content is byte-identical and whose manifest entry authors nothing.
		let previousFiles;
		if (manifest.previousRoundId) {
			previousFiles = (await findSessionWithRound(manifest.previousRoundId))?.roundFiles(manifest.previousRoundId);
		}
		const review = buildPlanReview(manifest, undefined, previousFiles);
		return openSession(ctx, review, manifest.previousRoundId, resolvePlanResponses(review, manifest.threadResponses), {});
	};

	const openDiagram = async (ctx: ExtensionContext, manifest: OpenDiagramReviewInput) => {
		const review = buildDiagramReview(manifest);
		if (!manifest.previousRoundId && manifest.threadResponses !== undefined) {
			throw new Error("threadResponses requires previousRoundId; fresh diagram reviews have no threads to respond to.");
		}
		return openSession(ctx, review, manifest.previousRoundId, resolvePlanResponses(review, manifest.threadResponses), {});
	};

	pi.registerTool({
		name: "open_code_review",
		label: "Open Code Review",
		description: "Open a frozen browser review of all staged, unstaged, and untracked changes against HEAD. Start with a concise review overview, then supply every changed file in the most logical review order with a concise file summary, review/reference classification, and optional line-anchored commentary. Reference files stay inspectable in a collapsed sidebar group. Omitted changed files are appended automatically; binary contents and oversized diffs are not rendered. On next rounds, files whose content is byte-identical to the previous round carry their summary, classification, and commentary forward when listed without a summary or omitted entirely — re-author only what changed. The reviewer's browser posts live comment threads as code-review-thread messages; answer each with reply_review_thread, and treat the code-review-pass message as the signal that the pass is complete. After a pass, apply the feedback as one batch and call this tool again with previousRoundId set to that pass's snapshot id: the revised changes open as the next round of the same session and the reviewer's browser advances automatically. The next round must include threadResponses: exactly one {respondsTo, resolution, body} per open thread AWAITING you (the reviewer spoke after your last reply), each with an explicitly designated anchor (file plus optional lines) into the new snapshot, or no file only when the anchor is truly gone. Open threads where you spoke last may be omitted entirely: they carry forward automatically with their conversation, proposed-resolve state, and revalidated anchors (moved anchors land in the outdated group); you may still respond to one voluntarily to re-anchor it. Open threads whose content never reached you (still queued/pending drafts) are carried into the new round automatically — do not respond to them. When the reviewer approves the review, a code-review-approved message carries their final commit message and the session closes terminally — no further rounds.",
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
		name: "open_plan_review",
		label: "Open Plan Review",
		description: "Open a browser review of a markdown plan document. The plan is sliced into sections at its shallowest heading level; the reviewer reads the rendered document, selects text to open comment threads, and replies to your per-section commentary. Threads arrive as plan-review-thread messages; answer each with reply_review_thread, and treat the plan-review-pass message as the signal that the pass is complete. To revise, call this tool again with the FULL updated markdown and previousRoundId set to that pass's snapshot id: the new plan opens as the next round in the same browser session. Sections left unlisted (or listed without a commentary value) keep the previous round's commentary while their content is byte-identical — re-author only sections whose notes should change. The next round must include threadResponses: exactly one {respondsTo, resolution, body} per open thread whose reviewer content you have received, anchored to a section (heading text) and absolute source lines of the NEW markdown, or no section only when the concern's home is truly gone. When the reviewer approves, a plan-review-approved message carries their approval note and the session closes terminally.",
		promptSnippet: "Open a browser review of a markdown plan with sections, threads, and rounds",
		promptGuidelines: [
			"Use open_plan_review when the user wants to iterate on a plan, proposal, or design document interactively — draft the full plan as markdown with clear headings, then open it for annotation.",
			"Give plan sections real headings; the document is sliced into sections at its shallowest heading level and the sidebar becomes that outline.",
			"Use open_plan_review sections[].commentary for rationale and open questions anchored to specific plan lines — the reviewer replies in place.",
			"After a plan-review-pass message, revise the plan as one batch and reopen with previousRoundId and the full updated markdown; answer every open thread in threadResponses with an honest resolution anchored into the new document.",
			"Plan approval is not an instruction to start coding; it closes the planning session with the reviewer's approval note. Follow the session's own workflow for what happens next.",
		],
		parameters: openPlanReviewSchema,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Building the plan review…" }], details: {} });
			const { review, server, round, identical } = await openPlan(ctx, params);
			if (identical) {
				return {
					content: [{ type: "text", text: `The plan is identical to round ${round} — nothing changed. The session stays on that round; continue answering its threads with reply_review_thread.` }],
					details: { snapshot: review.id, round, identical: true },
				};
			}
			return {
				content: [{ type: "text", text: `Opened plan review ${review.id.slice(0, 12)}${round && round > 1 ? ` as round ${round}; the reviewer's browser advances automatically` : ""} with ${review.files.length} section(s). The browser posts live comment threads; reply with reply_review_thread and wait for the reviewer's plan-review-pass message.` }],
				details: { snapshot: review.id, round, sections: review.files.map((file: { path: string }) => file.path), url: server.url.replace(/\?.*$/, "") },
			};
		},
	});

	pi.registerTool({
		name: "open_diagram_review",
		label: "Open Diagram Review",
		description: "Open a browser review of one or more mermaid architecture diagrams, without authoring a plan document. Each diagram becomes a section: its name heads the sidebar, the diagram renders live and clickable, and an optional caption frames it. The reviewer clicks nodes and edges to open comment threads anchored to element identity; threads arrive as plan-review-thread messages with an element attribute — answer with reply_review_thread. To revise, call this tool again with the FULL updated diagram set and previousRoundId from the plan-review-pass message: element-anchored threads carry to the new round while their ids exist. Approval closes the session terminally. Under the hood this is a plan session; use open_plan_review instead when the diagrams belong inside a written plan.",
		promptSnippet: "Open a browser review of mermaid diagrams with element-anchored threads",
		promptGuidelines: [
			"Use open_diagram_review when the user wants to iterate on architecture diagrams themselves — no surrounding plan document; use open_plan_review with mermaid fences when diagrams accompany a written plan.",
			"Give every meaningful node a stable, semantic id (api, orders_db): ids are the anchor contract, and renaming one orphans its threads. Revise diagrams by changing sources, keeping ids for elements whose discussions should survive.",
			"Anchor open_diagram_review commentary to specific elements with element: \"node:<id>\" or \"edge:<from>-><to>\" rather than leaving notes section-wide.",
		],
		parameters: openDiagramReviewSchema,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Building the diagram review…" }], details: {} });
			const { review, server, round, identical } = await openDiagram(ctx, params);
			if (identical) {
				return {
					content: [{ type: "text", text: `The diagrams are identical to round ${round} — nothing changed. The session stays on that round; continue answering its threads with reply_review_thread.` }],
					details: { snapshot: review.id, round, identical: true },
				};
			}
			return {
				content: [{ type: "text", text: `Opened diagram review ${review.id.slice(0, 12)}${round && round > 1 ? ` as round ${round}; the reviewer's browser advances automatically` : ""} with ${review.files.length} diagram(s). The browser posts live comment threads; reply with reply_review_thread and wait for the reviewer's plan-review-pass message.` }],
				details: { snapshot: review.id, round, sections: review.files.map((file: { path: string }) => file.path), url: server.url.replace(/\?.*$/, "") },
			};
		},
	});

	pi.registerTool({
		name: "reply_review_thread",
		label: "Reply Review Thread",
		description: "Reply inside a live comment thread of the open browser code review. Use the thread id from the code-review-thread message. Set resolves=true to propose resolution; only the reviewer's explicit resolve action closes a thread. Markdown links to prior rounds render as clickable same-origin navigation: /round/N#loc=<file>:L<line> lands on a location, /round/N#thread=<id> on a thread — reference earlier states instead of pasting old code into the rail.",
		promptSnippet: "Reply to a live browser code-review comment thread",
		promptGuidelines: [
			"When a code-review-thread message arrives, answer promptly with reply_review_thread using that thread id.",
			"Answer each thread message inside exactly the thread that raised it, taking the thread id from the incoming message; never post placeholder or cross-reference replies into other threads.",
			"Keep review-thread replies short \u2014 they render in a narrow rail beside the anchored code, so a long reply pushes that code off screen. Lead with the answer, aim for under ~80 words, and move longer discussion to chat or the next round.",
			"Set resolves=true only when the concern is fully addressed, and never treat a proposal as a resolution.",
			"Never edit code in response to an individual review thread; keep the worktree identical to the open snapshot until the code-review-pass message arrives, then apply feedback as one batch and open the next round with open_code_review previousRoundId set to that pass's snapshot id.",
		],
		parameters: replyReviewThreadSchema,
		async execute(_toolCallId, params) {
			for (const server of servers) {
				const location = server.locateThread(params.threadId);
				if (!location) continue;
				if (!location.current) throw new Error(`Thread ${params.threadId} belongs to superseded round ${location.round}; it is read-only. Respond to the reviewer in round ${server.currentRoundNumber()} instead.`);
				const result: ReviewThread | { error: string } | undefined = server.postPiReply(params.threadId, params.body, params.resolves === true);
				if (result && "error" in result && result.error === "approved") {
					throw new Error("This review session was approved and is closed; its threads are read-only. If another unit needs review, open a fresh review.");
				}
				if (result && "error" in result && result.error === "closed") {
					throw new Error("This review session was closed; its threads are read-only. If another unit needs review, open a fresh review.");
				}
				const thread = result as ReviewThread | undefined;
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

	pi.registerTool({
		name: "close_review",
		label: "Close Review Session",
		description: "Close an open browser review, plan, or diagram session that concluded outside the browser — verbally approved, superseded, or abandoned. The reviewer's pages stay readable, but posting, thread replies, further rounds, and approval are disabled, and the browser shows a closed banner with the reason. Takes any round's snapshot id from the session.",
		promptSnippet: "Close a browser review session that concluded outside the browser",
		promptGuidelines: [
			"Use close_review when a review or plan session's outcome was decided outside the browser (for example approved in chat) so the reviewer's open tab shows a truthful terminal state instead of live-looking controls.",
			"Give close_review a short reviewer-facing reason; it appears verbatim in the browser banner.",
		],
		parameters: Type.Object({
			roundId: Type.String({ minLength: 8, maxLength: 200, description: "Any round's snapshot id from the session to close." }),
			reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Short reviewer-visible reason shown in the closed banner." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			const server = [...servers].find((candidate) => candidate.hasRound(params.roundId));
			if (!server) throw new Error(`No open review session contains round ${params.roundId.slice(0, 12)}.`);
			const result = server.closeSession(params.reason);
			if ("error" in result) throw new Error(result.error === "approved" ? "This session was approved; approval is already terminal." : "This session is already closed.");
			return {
				content: [{ type: "text", text: `Closed the review session (round ${result.round} was current). Pages stay readable; posting, rounds, and approval are disabled.` }],
				details: { round: result.round },
			};
		},
	});

	pi.registerTool({
		name: "list_review_threads",
		label: "List Review Threads",
		description: "List the comment threads of the open browser code review: id, kind, file, anchor, status, queued/pending state, delivered-message counter, and the newest message. Prior thread context is normally already in your conversation — every message arrived when it was posted. Use this as the deliberate fallback when threads become confusing or hard to track (after compaction, long gaps, or many parallel threads), then get_review_thread for one thread's full history.",
		promptSnippet: "List the open code review's comment threads",
		promptGuidelines: [
			"Use list_review_threads only when review threads become confusing or hard to track — after compaction, a long gap, or many parallel threads; prior messages are normally already in your context.",
		],
		parameters: listReviewThreadsSchema,
		async execute(_toolCallId, params) {
			const sections: string[] = [];
			for (const server of servers) {
				const review = server.currentReview();
				const summary = server.threadSummary();
				const threads = server.threads().filter((thread: ReviewThread) => params.includeResolved === true || thread.status === "open");
				const rows = threads.map((thread: ReviewThread) => {
					const anchor = thread.carried?.startLine !== undefined
						? `${thread.carried.side}:${thread.carried.startLine}-${thread.carried.endLine}`
						: thread.startLine !== undefined
							? `${thread.side}:${thread.startLine}-${thread.endLine}`
							: thread.newStart !== undefined
								? `new:${thread.newStart}-${thread.newEnd}`
								: thread.oldStart !== undefined
									? `old:${thread.oldStart}-${thread.oldEnd}`
									: "file";
					const last = thread.turns[thread.turns.length - 1];
					const deliveredCount = thread.turns.filter((turn: ReviewThreadTurn) => turn.author === "user" && turn.delivered === true).length;
					const flags = [thread.status === "resolved" ? "resolved" : undefined, thread.queued ? "queued" : undefined, (thread.pending ?? 0) > 0 && !thread.queued ? `${thread.pending} pending` : undefined, thread.carried ? `carried r${thread.carried.fromRound}/${thread.carried.resolution}` : undefined].filter(Boolean).join(", ");
					const location = thread.source === "overview" ? "overview" : thread.file ?? "(anchor gone)";
					const snippetSource = last ? [...last.body.replace(/\s+/g, " ").trim()] : [];
					const snippet = snippetSource.length > 90 ? `${snippetSource.slice(0, 90).join("")}…` : snippetSource.join("");
					const draft = last?.author === "user" && last.delivered === false ? "(draft) " : "";
					return `  ${thread.id} [${thread.source}] ${location} @${anchor} delivered=${deliveredCount}${flags ? ` (${flags})` : ""} — ${last ? `${last.author} t${last.seq}: ${draft}${snippet}` : "no messages"}`;
				});
				sections.push(`Review "${review.title}" snapshot ${review.id.slice(0, 12)} round ${server.currentRoundNumber()}: ${summary.open} open, ${summary.resolved} resolved.\n${rows.join("\n") || "  (no matching threads)"}`);
			}
			if (sections.length === 0) throw new Error("No open code review session.");
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: { reviews: sections.length } };
		},
	});

	pi.registerTool({
		name: "get_review_thread",
		label: "Get Review Thread",
		description: "Fetch one review thread's full unified context: anchor, highlight, and complete message history with turn numbers and per-message delivery state. Prior turns are normally already in your conversation; use this as the deliberate recovery path when a thread's context is no longer in your attention window (after compaction or a long gap). lastTurns limits the fetch to the newest N messages when you only need the recent tail.",
		promptSnippet: "Fetch one code-review thread's full history",
		promptGuidelines: [
			"Use get_review_thread when a thread message arrives whose earlier context you can no longer see (post-compaction, long gaps) instead of guessing; prefer lastTurns when only the recent tail is needed.",
		],
		parameters: getReviewThreadSchema,
		async execute(_toolCallId, params) {
			for (const server of servers) {
				const context = server.threadContext(params.threadId);
				if (!context) continue;
				const xml = formatThreadContextXml(context.review, context.thread, context.round, params.lastTurns);
				// Carried ids always resolve to the living copy (newest-first lookup), so
				// reaching a superseded round means the thread was NOT carried forward.
				const note = context.current ? "" : `\nNote: this thread lives in superseded round ${context.round} and is read-only; it was not carried into current round ${server.currentRoundNumber()}. Answer the reviewer in the current round's threads or in chat.`;
				return { content: [{ type: "text", text: `${xml}${note}` }], details: { thread: params.threadId, round: context.round, current: context.current } };
			}
			throw new Error(`No open code review contains thread ${params.threadId}.`);
		},
	});

	pi.registerCommand("margin-code", {
		description: "Open a static browser review of a repo's staged, unstaged, and untracked changes against HEAD (/margin-code [repo-path])",
		handler: async (args, ctx) => {
			const normalized = args.trim();
			if (normalized === "--help" || normalized === "-h") {
				ctx.ui.notify("Usage: /margin-code [repo-path]\n\nOpens one frozen unified-diff snapshot of all staged, unstaged, and untracked changes against HEAD.\nBare: reviews the repository at the session's working directory.\nWith a path: reviews the Git repository at (or containing) that directory.\nFor Pi-authored ordering and commentary, ask Pi to use open_code_review.", "info");
				return;
			}
			let root: string | undefined;
			if (normalized) {
				try {
					root = await resolveRepoArg(ctx, normalized);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
			}
			try {
				const { review } = await openReview(ctx, { files: [] }, undefined, root);
				ctx.ui.notify(`Opened static review ${review.id.slice(0, 12)} (${review.files.length} files${root ? ` in ${root}` : ""}).`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("margin-doc", {
		description: "Open a browser document review of Pi's latest response, or of any markdown file (/margin-doc [path])",
		handler: async (args, ctx) => {
			const normalized = args.trim();
			if (normalized === "--help" || normalized === "-h") {
				ctx.ui.notify("Usage: /margin-doc [path]\n\nBare: reviews Pi's latest response as a rendered document.\nWith a path: reviews that markdown file.\nComments you post arrive in this session as plan-review threads; Pi answers with reply_review_thread.", "info");
				return;
			}
			try {
				let markdown: string;
				let title: string;
				if (normalized) {
					const expanded = normalized === "~" || normalized.startsWith("~/") ? homedir() + normalized.slice(1) : normalized;
					const filePath = isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
					markdown = await readFile(filePath, "utf8");
					title = basename(filePath);
				} else {
					const found = lastAssistantMarkdown(ctx);
					if (!found) {
						ctx.ui.notify("No assistant markdown found in the current branch.", "warning");
						return;
					}
					markdown = found;
					const heading = /^#{1,6}\s+(.+)$/m.exec(found);
					title = (heading ? heading[1].trim() : "Pi's latest response") || "Pi's latest response";
				}
				const { review } = await openPlan(ctx, { title: title.slice(0, 200), markdown });
				ctx.ui.notify(`Opened document review "${title.slice(0, 80)}" (${review.files.length} section(s)).`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		await bootHealTask;
		deliverBootAnnouncement(ctx.isIdle());
		// Pi's turn is over: threads whose delivered reviewer message drew no reply
		// were seen, not answered. This runs BEFORE the flush below so a message
		// that only now reaches Pi's context is never marked seen by the very
		// settle that delivers it.
		for (const server of servers) server.markTurnEnd();
		try {
			if (queue.flush(ctx.isIdle()) > 0) {
				// The flushed batch is in Pi's context now; sent threads are working.
				for (const server of servers) server.markQueueDelivered();
			}
		} catch {
			// A failed delivery keeps the batch queued; retry at the next settle.
		}
	});

	pi.on("session_shutdown", async () => {
		const active = [...servers];
		servers.clear();
		await Promise.all(active.map((server) => server.close()));
	});

	pi.registerTool({
		name: "list_review_sessions",
		label: "List Review Sessions",
		description: "List marginalia review sessions: live servers in this pi process and resumable persisted sessions on disk, with ports, phases, and ages.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params) {
			const liveIds = new Set<string>();
			const lines: string[] = [];
			for (const server of [...servers]) {
				const state = server.serializeSession() as PersistedSession;
				liveIds.add(state.id);
				const open = state.rounds[state.rounds.length - 1].store.threads.filter((thread) => thread.status === "open").length;
				lines.push(`live  ${state.id.slice(0, 12)}  "${state.title}"  ${state.kind}  round ${state.rounds.length}  ${open} open thread(s)  port ${state.port}  phase ${state.phase}`);
			}
			for (const state of await listSessions()) {
				if (liveIds.has(state.id)) continue;
				const age = Math.round((Date.now() - (state.lastActive ?? 0)) / 60_000);
				const claimed = isClaimed(state) ? `claimed by pid ${state.pid}` : "resumable";
				lines.push(`disk  ${state.id.slice(0, 12)}  "${state.title ?? "untitled"}"  ${state.kind ?? "code"}  round ${state.rounds?.length ?? "?"}  ${claimed}  last active ${age}m ago  phase ${state.phase}`);
			}
			return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No live or persisted review sessions." }], details: { live: liveIds.size } };
		},
	});

	// Boot heal: resurrect this project's recent non-terminal sessions at
	// extension load so an open reviewer tab reconnects on its own, without
	// touching any pi session. The chat announcement waits for session_start —
	// the session the user actually resumed — so no message ever conjures a
	// session at pi boot.
	pi.registerMessageRenderer<SessionNoticeDetails>(SESSION_NOTICE_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details;
		if (!details?.sessions?.length) return undefined;
		const count = details.sessions.length;
		const headline = details.mode === "resumed" ? `resumed ${plural(count, "review session")}` : `${plural(count, "resumable review session")} on disk`;
		const lines = [`${theme.fg("success", "◆")} ${theme.bold("Marginalia")} ${theme.fg("muted", headline)}`];
		for (const session of details.sessions) {
			const meta = [session.kind, `round ${session.round}`, plural(session.open, "open thread"), formatAge(session.ageMinutes)].join(" · ");
			lines.push("", `  ${theme.fg("text", session.title)}`, `  ${theme.fg("dim", meta)}`);
			if (session.url) lines.push(`  ${theme.fg("mdLinkUrl", session.url)}`);
		}
		if (expanded) {
			const hint = details.mode === "resumed"
				? "Open tabs reconnect on their own; links mint fresh entry tokens if a tab was closed."
				: "Boot heal is off. Open the next round with previousRoundId to resume one.";
			lines.push("", theme.fg("dim", hint));
		}
		const greenBg = theme.getColorMode() === "truecolor" ? "\x1b[48;2;22;52;40m" : "\x1b[48;5;22m";
		const box = new Box(outputPad, 1, (text) => `${greenBg}${text}\x1b[49m`);
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	let bootAnnouncement: SessionNoticeDetails | undefined;
	const bootHealTask = (async () => {
		try {
			await sweepSessions();
			const cwd = process.cwd();
			const scopeMatches = (scopePath?: string) => typeof scopePath === "string" && (cwd.startsWith(scopePath) || scopePath.startsWith(cwd));
			const resumable = (await listSessions()).filter((state: PersistedSession) =>
				state.phase !== "approved" && state.phase !== "closed"
				&& !isClaimed(state)
				&& Date.now() - (state.lastActive ?? 0) < BOOT_HEAL_MAX_AGE_MS
				&& scopeMatches(state.scopePath));
			if (!resumable.length) return;
			const describe = (state: PersistedSession, url?: string): SessionNotice => ({
				title: state.title ?? "untitled",
				kind: state.kind ?? "code",
				round: state.rounds.length,
				open: state.rounds[state.rounds.length - 1].store.threads.filter((thread) => thread.status === "open").length,
				ageMinutes: Math.round((Date.now() - (state.lastActive ?? 0)) / 60_000),
				url,
			});
			if ((await loadAppearance())?.bootHeal === false) {
				bootAnnouncement = { mode: "resumable", sessions: resumable.map((state: PersistedSession) => describe(state)) };
				return;
			}
			const healed: SessionNotice[] = [];
			for (const state of resumable) {
				try {
					const server = await healFromState(state);
					healed.push(describe(state, server.entryUrl()));
				} catch {}
			}
			if (healed.length) bootAnnouncement = { mode: "resumed", sessions: healed };
		} catch {}
	})();
	// The notice belongs to a session the user deliberately entered. pi
	// auto-creates a session at launch (reason "startup") before any human
	// choice — announcing there conjures a stray session and wakes its agent.
	const deliverBootAnnouncement = (idle: boolean) => {
		if (!bootAnnouncement) return;
		const details = bootAnnouncement;
		bootAnnouncement = undefined;
		pi.sendMessage<SessionNoticeDetails>(
			{ customType: SESSION_NOTICE_TYPE, content: formatSessionNoticeXml(details), display: true, details },
			idle ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" },
		);
	};
	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		if (event.reason === "startup") return;
		// A fast resume must not outrun the async heal and lose the notice.
		await bootHealTask;
		deliverBootAnnouncement(true);
	});
}
