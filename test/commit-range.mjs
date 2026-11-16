import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyReviewManifest, collectReviewSnapshot, createPinnedBlobContextReader } from "../shared/git-review.js";
import { formatReviewApprovedXml, formatReviewPassXml, formatThreadMessageXml } from "../shared/feedback.js";
import { renderReviewHtml } from "../shared/render.js";
import { createCodeReviewServer } from "../shared/server.js";
import { parseCodeReviewArgs } from "../shared/review-args.js";

assert.deepEqual(parseCodeReviewArgs(""), { repoPath: undefined });
assert.deepEqual(parseCodeReviewArgs("--help"), { help: true });
assert.deepEqual(parseCodeReviewArgs("/tmp/repo with spaces"), { repoPath: "/tmp/repo with spaces" });
assert.deepEqual(parseCodeReviewArgs('"/tmp/repo with spaces"'), { repoPath: "/tmp/repo with spaces" });
assert.deepEqual(parseCodeReviewArgs('"/tmp/repo with spaces" --base HEAD~1 --head=HEAD'), { baseRef: "HEAD~1", headRef: "HEAD", repoPath: "/tmp/repo with spaces" });
for (const args of ["--base HEAD", "--head HEAD", "--base --head HEAD", "--base= --head HEAD", "--base HEAD --base HEAD --head HEAD", "--base HEAD --head HEAD --unknown", '"unclosed']) {
	assert.throws(() => parseCodeReviewArgs(args));
}

const temp = await mkdtemp(join(tmpdir(), "marginalia-commits-"));
const repo = join(temp, "repo with spaces");
await mkdir(repo);
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const commit = (message) => { git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
const previousSessionsDir = process.env.PI_MARGINALIA_SESSIONS_DIR;
process.env.PI_MARGINALIA_SESSIONS_DIR = join(temp, "sessions");
let server;
try {
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	const canary = join(temp, "textconv-ran");
	git("config", "diff.hostile.textconv", `touch ${canary}`);
	const baseline = Array.from({ length: 100 }, (_, index) => "line " + (index + 1));
	await writeFile(join(repo, ".gitattributes"), "*.txt diff=hostile\n");
	await writeFile(join(repo, "changed.txt"), baseline.join("\n") + "\n");
	await writeFile(join(repo, "old [one].txt"), "renamed content\n");
	await writeFile(join(repo, "deleted.txt"), "deleted content\n");
	await writeFile(join(repo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
	const base = commit("base");
	const updated = [...baseline];
	updated[39] = "UPDATED 40";
	await writeFile(join(repo, "changed.txt"), updated.join("\n") + "\n");
	await rename(join(repo, "old [one].txt"), join(repo, "new [two].txt"));
	await rm(join(repo, "deleted.txt"));
	await writeFile(join(repo, "added.txt"), "committed addition\n");
	await writeFile(join(repo, "binary.dat"), Buffer.from([0, 5, 6, 7]));
	const head = commit("feature");
	git("tag", "range-head", head);
	await writeFile(join(repo, "only-latest.txt"), "not in the requested range\n");
	await writeFile(join(repo, "binary.dat"), Buffer.from([0, 9, 10, 11]));
	const later = commit("later work");
	await writeFile(join(repo, "changed.txt"), "DIRTY worktree content\n");
	git("add", "changed.txt");
	await writeFile(join(repo, "changed.txt"), "UNSTAGED worktree content\n");
	await writeFile(join(repo, "untracked-only.txt"), "not committed\n");
	await writeFile(join(repo, ".gitattributes"), "*.txt -diff\n");
	const before = { head: git("rev-parse", "HEAD"), index: git("write-tree"), status: git("status", "--porcelain"), text: await readFile(join(repo, "changed.txt"), "utf8") };

	const snapshot = await collectReviewSnapshot(repo, { baseRef: base.slice(0, 10), headRef: "range-head" });
	assert.deepEqual(snapshot.commitRange, { base, head });
	assert.equal(snapshot.head, head);
	assert.deepEqual(snapshot.files.map(file => file.path).sort(), ["added.txt", "binary.dat", "changed.txt", "deleted.txt", "new [two].txt"]);
	const changed = snapshot.files.find(file => file.path === "changed.txt");
	assert.equal(changed.binary, false, "Dirty attributes must not change a committed comparison's rendering.");
	assert.ok(changed.lines.some(line => line.kind === "add" && line.content === "UPDATED 40"));
	assert.ok(!changed.lines.some(line => line.content.includes("worktree content")));
	assert.equal(snapshot.files.find(file => file.path === "new [two].txt").oldPath, "old [one].txt");
	assert.equal(snapshot.files.find(file => file.path === "binary.dat").binary, true);
	const reversed = await collectReviewSnapshot(repo, { baseRef: head, headRef: base });
	assert.equal(reversed.files.find(file => file.path === "added.txt").status, "deleted");
	assert.ok(reversed.files.find(file => file.path === "changed.txt").lines.some(line => line.kind === "add" && line.content === "line 40"), "The requested direction is respected, not replaced by a merge-base comparison.");
	await assert.rejects(access(canary), "Text conversion commands must not execute.");
	const context = createPinnedBlobContextReader();
	assert.deepEqual(await context(snapshot, changed, 40, 40), ["line 40"], "Context comes from the base commit, not the head commit or worktree.");
	assert.deepEqual(await context(snapshot, snapshot.files.find(file => file.oldPath), 1, 1), ["renamed content"]);
	assert.deepEqual({ head: git("rev-parse", "HEAD"), index: git("write-tree"), status: git("status", "--porcelain"), text: await readFile(join(repo, "changed.txt"), "utf8") }, before, "Collecting a commit range never checks out, stages, or edits anything.");

	git("tag", "-f", "range-head", later);
	const pinned = await collectReviewSnapshot(repo, { baseRef: snapshot.commitRange.base, headRef: snapshot.commitRange.head });
	assert.equal(pinned.id, snapshot.id, "Resolved SHAs pin the range after a branch or tag moves.");
	const clone = join(temp, "clone");
	execFileSync("git", ["clone", "-q", repo, clone]);
	const cloned = await collectReviewSnapshot(clone, { baseRef: base, headRef: head });
	assert.notEqual(cloned.id, snapshot.id, "Separate repositories must not collide in persisted-session lookup.");
	assert.deepEqual(cloned.files.map(file => file.contentSha256), snapshot.files.map(file => file.contentSha256));
	const next = await collectReviewSnapshot(repo, { baseRef: base, headRef: "range-head" });
	assert.notEqual(next.id, snapshot.id);
	assert.notEqual(next.files.find(file => file.path === "binary.dat").contentSha256, snapshot.files.find(file => file.path === "binary.dat").contentSha256);
	for (const options of [{ baseRef: base }, { headRef: head }, { baseRef: "missing-commit", headRef: head }, { baseRef: "--help", headRef: head }, { baseRef: git("rev-parse", `${base}:changed.txt`), headRef: head }]) {
		await assert.rejects(collectReviewSnapshot(repo, options), /required|resolve to a commit/);
	}
	await assert.rejects(collectReviewSnapshot(repo, { baseRef: base, headRef: base }), /No changes found between commits/);
	assert.throws(() => applyReviewManifest(snapshot, { files: [], proposedCommitMessage: "Do not commit this again" }), /proposedApprovalNote/);
	const review = applyReviewManifest(snapshot, { files: [], proposedApprovalNote: "Existing commits look good." });
	const html = renderReviewHtml(review, "nonce");
	assert.match(html, /<body[^>]*data-review-source="commits"/);
	assert.match(html, new RegExp(`data-commit-range title="${base} → ${head}"`));
	assert.match(html, /Approve these commits/);
	assert.match(html, /<label class="approve-message-label">Approval note<textarea/);
	assert.doesNotMatch(html, /<span[^>]*data-stale-badge/);
	const passXml = formatReviewPassXml(review, [], { open: 0, awaitingUser: 0, awaitingPi: 0, resolved: 0 }, false, undefined, 1);
	assert.ok(passXml.includes(`comparison="commits" base="${base}" head="${head}"`));

	let probes = 0;
	let approvedXml;
	const callbacks = {
		onThreadPost: async () => {},
		onFinishPass: async () => ({ stale: false }),
		onApprove: async (round, message, stale) => { assert.equal(stale, false); approvedXml = formatReviewApprovedXml(round.review, round.number, message, stale); },
		contextLines: context,
		staleness: { fingerprint: async () => { probes++; return "dirty"; }, snapshot: async () => ({ id: "different", files: [] }) },
	};
	server = await createCodeReviewServer(review, callbacks);
	assert.equal(await server.checkStaleness(true), false);
	assert.equal(probes, 0, "Commit comparisons never probe the worktree, even when stale callbacks are supplied.");
	assert.deepEqual(server.addRound({ ...review, root: "elsewhere" }, review.id), { error: "wrong-root" });
	assert.deepEqual(server.addRound({ ...review, id: "worktree", commitRange: undefined }, review.id), { error: "wrong-comparison" });
	assert.deepEqual(server.addRound({ ...review, id: "other-base", commitRange: { base: head, head: later } }, review.id), { error: "wrong-comparison" });
	const nextReview = applyReviewManifest(next, { files: [] });
	assert.equal(server.addRound(nextReview, review.id).round, 2);
	const saved = server.serializeSession();
	await server.close();
	server = await createCodeReviewServer(nextReview, { ...callbacks, restore: saved });
	assert.deepEqual(server.currentReview().commitRange, { base, head: later });
	assert.equal(await server.checkStaleness(true), false);
	assert.equal(probes, 0);
	const origin = new URL(server.url).origin;
	const entry = await fetch(server.url, { redirect: "manual" });
	const cookie = (entry.headers.get("set-cookie") ?? "").split(";", 1)[0];
	const headers = { cookie, origin, "content-type": "application/json" };
	const gap = await fetch(`${origin}/__pi_code_review_context__?round=2&path=changed.txt&oldStart=10&oldEnd=12`, { headers });
	assert.equal(gap.status, 200);
	assert.deepEqual((await gap.json()).lines.map(line => line.content), ["line 10", "line 11", "line 12"]);
	const posted = await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ source: "selection", file: "changed.txt", side: "new", newStart: 40, newEnd: 40, highlight: "UPDATED 40", body: "Check this change.", quiet: true }) });
	assert.equal(posted.status, 200);
	const { thread } = await posted.json();
	assert.ok(formatThreadMessageXml(server.currentReview(), thread, [thread.turns[0]], 2).includes(`base="${base}" head="${later}"`));
	assert.equal((await fetch(`${origin}/__pi_code_review_approve__`, { method: "POST", headers, body: JSON.stringify({ message: "Approved" }) })).status, 409);
	assert.equal((await fetch(`${origin}/__pi_code_review_resolve__`, { method: "POST", headers, body: JSON.stringify({ threadId: thread.id, resolved: true }) })).status, 200);
	const approved = await fetch(`${origin}/__pi_code_review_approve__`, { method: "POST", headers, body: JSON.stringify({ message: "Approved existing commits" }) });
	assert.equal(approved.status, 200);
	assert.match(approvedXml, /^<commit-review-approved /);
	assert.match(approvedXml, /<approval-note><!\[CDATA\[Approved existing commits\]\]><\/approval-note>/);
	assert.doesNotMatch(approvedXml, /<commit-message>|<code-review-approved/);
	assert.match(approvedXml, /not authorization to create, amend, rewrite, or push/);
	assert.equal(probes, 0);
	console.log("Commit-range collector, rendering, context, rounds, restoration, and approval checks passed.");
} finally {
	await server?.close();
	if (previousSessionsDir === undefined) delete process.env.PI_MARGINALIA_SESSIONS_DIR;
	else process.env.PI_MARGINALIA_SESSIONS_DIR = previousSessionsDir;
	await rm(temp, { recursive: true, force: true });
}
