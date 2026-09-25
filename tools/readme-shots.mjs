// Regenerates the README screenshots into docs/. Requires a local Chrome.
// Usage: node tools/readme-shots.mjs
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import { collectReviewSnapshot, applyReviewManifest } from "../shared/git-review.js";
import { buildPlanReview } from "../shared/plan-review.js";
import { createCodeReviewServer } from "../shared/server.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "docs");
await mkdir(out, { recursive: true });

const sh = (cwd, command) => new Promise((resolvePromise, rejectPromise) => {
	const proc = spawn("/bin/sh", ["-c", command], { cwd });
	proc.on("exit", (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} -> ${code}`))));
});

// A believable little repo: one modified module, one new test.
const fixture = await mkdtemp(join(tmpdir(), "marginalia-shots-"));
await mkdir(join(fixture, "src"), { recursive: true });
await writeFile(join(fixture, "src/retry.js"), [
	"export async function withRetry(fn, attempts = 3) {",
	"  let lastError;",
	"  for (let i = 0; i < attempts; i++) {",
	"    try {",
	"      return await fn();",
	"    } catch (error) {",
	"      lastError = error;",
	"      await sleep(2 ** i * 100);",
	"    }",
	"  }",
	"  throw lastError;",
	"}",
	"",
	"const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
	"",
].join("\n"));
await sh(fixture, "git init -q && git -c user.email=demo@example.com -c user.name=demo add -A && git -c user.email=demo@example.com -c user.name=demo commit -qm base");
await writeFile(join(fixture, "src/retry.js"), [
	"export async function withRetry(fn, { attempts = 3, baseMs = 100, jitter = true } = {}) {",
	"  let lastError;",
	"  for (let i = 0; i < attempts; i++) {",
	"    try {",
	"      return await fn();",
	"    } catch (error) {",
	"      lastError = error;",
	"      if (i === attempts - 1) break;",
	"      const backoff = 2 ** i * baseMs;",
	"      await sleep(jitter ? backoff * (0.5 + Math.random()) : backoff);",
	"    }",
	"  }",
	"  throw lastError;",
	"}",
	"",
	"const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
	"",
].join("\n"));
await mkdir(join(fixture, "test"), { recursive: true });
await writeFile(join(fixture, "test/retry.test.js"), [
	"import { test } from \"node:test\";",
	"import assert from \"node:assert\";",
	"import { withRetry } from \"../src/retry.js\";",
	"",
	"test(\"gives up after the last attempt\", async () => {",
	"  let calls = 0;",
	"  await assert.rejects(() => withRetry(() => { calls++; throw new Error(\"nope\"); }, { attempts: 2, baseMs: 1 }));",
	"  assert.equal(calls, 2);",
	"});",
	"",
].join("\n"));

const snapshot = await collectReviewSnapshot(fixture);
const review = applyReviewManifest(snapshot, {
	title: "Add jitter to retry backoff",
	overview: {
		intent: "Retries currently synchronize across clients and stampede the upstream; jittered exponential backoff spreads them out.",
		changes: ["withRetry accepts an options object with attempts, baseMs, and jitter.", "The final failed attempt no longer sleeps before rethrowing."],
		validation: ["New unit test covers exhaustion; suite passes."],
		reviewFocus: "Whether the jitter range (0.5x to 1.5x) is the right spread.",
	},
	proposedCommitMessage: "Add jitter to retry backoff",
	files: [
		{ path: "src/retry.js", summary: "The retry loop itself: options object replaces the bare attempts argument, and backoff gains multiplicative jitter.", commentary: [
			{ id: "jitter-range", body: "Jitter multiplies by 0.5–1.5 rather than 0–1 so a retry never fires immediately.", side: "new", startLine: 9, endLine: 10 },
			{ id: "last-attempt", body: "Breaking before the sleep means the caller sees the final error without waiting one extra backoff.", side: "new", startLine: 8, endLine: 8 },
		] },
		{ path: "test/retry.test.js", summary: "Exhaustion coverage: the loop stops at exactly `attempts` calls." },
	],
});
const server = await createCodeReviewServer(review, {
	onThreadPost: async () => {},
	onFinishPass: async () => ({ stale: false }),
	onApprove: async () => {},
});
// Reviewer posts travel the real HTTP path; entry tokens are single-use, so
// mint one per consumer.
const reviewerPost = async (srv, payload) => {
	const entry = await fetch(srv.entryUrl(), { redirect: "manual" });
	const origin = new URL(srv.url).origin;
	const cookie = (entry.headers.get("set-cookie") ?? "").split(";", 1)[0];
	const response = await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify(payload) });
	return (await response.json()).thread;
};
const posted = await reviewerPost(server, { source: "selection", file: "src/retry.js", side: "new", newStart: 9, newEnd: 10, highlight: "const backoff = 2 ** i * baseMs;", body: "Should the jitter factor be configurable too, or is that overfitting?" });
server.postPiReply(posted.id, "I'd leave it fixed until a caller needs it — every knob here is one more thing to reason about under incident pressure. The 0.5–1.5 spread is the textbook decorrelated range.", false);

const planMarkdown = [
	"Search latency is dominated by cold index shards. This plan rolls out a warm-standby tier without a stop-the-world reindex.",
	"",
	"## Goals",
	"- p99 search latency under 400ms during shard failover",
	"- Zero write downtime during the rollout",
	"",
	"## Rollout steps",
	"1. Mirror writes to the standby tier behind a flag",
	"2. Backfill historical shards in reverse-recency order",
	"3. Flip reads shard-by-shard, watching the latency dashboard",
	"4. Decommission the cold tier after one full traffic week",
	"",
	"## Risks",
	"- Double-write amplification during the mirror phase",
	"- Backfill contending with live traffic for shard locks",
	"",
].join("\n");
const plan = buildPlanReview({
	title: "Warm-standby search rollout",
	markdown: planMarkdown,
	sections: [
		{ heading: "Rollout steps", commentary: [{ id: "backfill-order", body: "Reverse-recency backfill means the shards most likely to be read are warm first — the flip in step 3 can start before the backfill finishes.", startLine: 9, endLine: 9 }] },
		{ heading: "Risks", summary: "Both risks are bounded by the flag in step 1: mirroring can be turned off without data loss at any point before the flip." },
	],
});
const planServer = await createCodeReviewServer(plan, {
	onThreadPost: async () => {},
	onFinishPass: async () => ({ stale: false }),
	onApprove: async () => {},
});
const planPosted = await reviewerPost(planServer, { source: "selection", file: "rollout-steps", side: "new", newStart: 10, newEnd: 10, highlight: "Flip reads shard-by-shard, watching the latency dashboard", body: "What's the rollback if p99 regresses mid-flip?" });
planServer.postPiReply(planPosted.id, "Each shard flip is independently reversible — reads fall back to the cold tier per shard, so rollback is the same dashboard-watching loop in reverse.", false);

const executablePath = await (async () => {
	for (const candidate of [process.env.PUPPETEER_EXECUTABLE_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)) {
		try { await access(candidate); return candidate; } catch {}
	}
	throw new Error("No Chrome found for screenshots.");
})();
const browser = await puppeteer.launch({ headless: true, executablePath, args: ["--no-sandbox", "--force-device-scale-factor=2"] });
const shoot = async (url, file, { dark, viewport, prepare }) => {
	const page = await browser.newPage();
	await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
	await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.querySelector("[data-thread-card], .agent-note"), { polling: 100 });
	if (prepare) await prepare(page);
	await new Promise((r) => setTimeout(r, 400));
	await page.screenshot({ path: join(out, file) });
	await page.close();
};
await shoot(server.entryUrl(), "code-review.png", {
	dark: true,
	viewport: { width: 1440, height: 860 },
	prepare: async (page) => {
		await page.keyboard.press("]");
		await page.waitForFunction(() => document.querySelector('[data-review-file="0"]')?.hidden === false);
	},
});
await shoot(planServer.entryUrl(), "plan-review.png", { dark: false, viewport: { width: 1440, height: 860 } });
await browser.close();
await server.close();
await planServer.close();
console.log("Wrote docs/code-review.png and docs/plan-review.png");
