import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { applyReviewManifest, collectReviewSnapshot, parseUnifiedPatch, REVIEW_LIMITS } from "../shared/git-review.js";
import { formatCodeReviewFeedbackXml, parseCodeReviewFeedback } from "../shared/feedback.js";
import { renderReviewHtml } from "../shared/render.js";
import { createCodeReviewServer } from "../shared/server.js";

const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
const fixture = await mkdtemp(join(tmpdir(), "pi-code-review-"));
try {
	await git(fixture, "init", "-q");
	await git(fixture, "config", "user.email", "test@example.com");
	await git(fixture, "config", "user.name", "Test");
	await writeFile(join(fixture, "staged.txt"), "baseline\n");
	await writeFile(join(fixture, "unstaged.txt"), "baseline\n");
	await writeFile(join(fixture, "deleted.txt"), "remove me\n");
	await writeFile(join(fixture, "old-name.txt"), "renamed\n");
	await writeFile(join(fixture, "binary.dat"), Buffer.from([0, 1, 2, 3]));
	await git(fixture, "add", ".");
	await git(fixture, "commit", "-qm", "baseline");

	await writeFile(join(fixture, "staged.txt"), "baseline\nstaged addition\n");
	await git(fixture, "add", "staged.txt");
	await writeFile(join(fixture, "unstaged.txt"), "baseline\nunstaged addition\n");
	await rm(join(fixture, "deleted.txt"));
	await git(fixture, "mv", "old-name.txt", "new-name.txt");
	await writeFile(join(fixture, "untracked.txt"), "new text\nsecond line\n");
	await writeFile(join(fixture, "untracked.bin"), Buffer.from([65, 0, 66]));
	await writeFile(join(fixture, "binary.dat"), Buffer.from([0, 1, 9, 3]));

	const snapshot = await collectReviewSnapshot(fixture);
	const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
	assert.equal(byPath.get("staged.txt")?.status, "modified");
	assert.ok(byPath.get("staged.txt")?.lines.some((line) => line.kind === "add" && line.content === "staged addition"), "Staged content should be included against HEAD.");
	assert.ok(byPath.get("unstaged.txt")?.lines.some((line) => line.kind === "add" && line.content === "unstaged addition"), "Unstaged content should be included against HEAD.");
	assert.equal(byPath.get("deleted.txt")?.status, "deleted");
	assert.equal(byPath.get("new-name.txt")?.status, "renamed");
	assert.equal(byPath.get("new-name.txt")?.oldPath, "old-name.txt");
	assert.equal(byPath.get("untracked.txt")?.status, "untracked");
	assert.ok(byPath.get("untracked.txt")?.lines.every((line) => !["context", "del"].includes(line.kind)), "Untracked files should render as all-addition diffs.");
	assert.equal(byPath.get("untracked.bin")?.binary, true);
	assert.equal(byPath.get("binary.dat")?.binary, true);
	assert.equal((await collectReviewSnapshot(fixture)).id, snapshot.id, "Unchanged working-tree content should produce a stable fingerprint.");
	await writeFile(join(fixture, "binary.dat"), Buffer.from([0, 1, 8, 3]));
	assert.notEqual((await collectReviewSnapshot(fixture)).id, snapshot.id, "Changing tracked binary bytes must change the snapshot fingerprint even though the textual binary diff marker is unchanged.");
	await writeFile(join(fixture, "binary.dat"), Buffer.from([0, 1, 9, 3]));
	assert.equal((await collectReviewSnapshot(fixture)).id, snapshot.id, "Restoring tracked binary bytes should restore the frozen fingerprint.");

	const ordered = applyReviewManifest(snapshot, {
		title: "Safe <review>",
		overview: {
			intent: "Make local code review faster before opening a pull request.",
			changes: ["Add a guided overview.", "Keep file-level review focused."],
			validation: ["Run automated regression checks."],
			reviewFocus: "Check whether the overview is sufficiently concise.",
		},
		files: [{
			path: "untracked.txt",
			summary: "Review this first <script>alert(1)</script>",
			commentary: [{ id: "new-file", body: "Why this exists", side: "new", startLine: 1, endLine: 2 }],
		}],
	});
	assert.equal(ordered.files[0].path, "untracked.txt", "Agent-provided order should lead.");
	assert.equal(ordered.files.length, snapshot.files.length, "Changed files omitted by the manifest must be appended.");
	assert.equal(ordered.overview.intent, "Make local code review faster before opening a pull request.");
	assert.throws(() => applyReviewManifest(snapshot, { overview: { intent: "Too sparse", changes: ["Only one"], validation: ["Checked"] }, files: [] }), /changes must contain 2 to 4 entries/);
	assert.throws(() => applyReviewManifest(snapshot, { overview: { intent: "word ".repeat(95), changes: ["one two three", "four five six"], validation: ["seven eight"] }, files: [] }), /at most 100 words/);
	assert.throws(() => applyReviewManifest(snapshot, { files: [{ path: "../secret", summary: "bad" }] }), /not changed against HEAD/);
	assert.throws(() => applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", commentary: [{ id: "end-only", body: "bad", endLine: 2 }] }] }), /cannot set endLine without startLine/, "Commentary endLine requires a startLine.");
	assert.throws(() => applyReviewManifest(snapshot, { files: [{ path: "binary.dat", commentary: [{ id: "binary-anchor", body: "bad", side: "new", startLine: 1 }] }] }), /cannot anchor to binary file/, "Binary commentary cannot claim a visible line anchor.");
	assert.throws(
		() => applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", commentary: [{ id: "omitted-anchor", body: "bad", side: "new", startLine: 1 }] }] }, { ...REVIEW_LIMITS, overallPatchBytes: 0, overallDiffLines: 0 }),
		/does not anchor to a visible new line/,
		"Commentary anchors must be checked after overall caps omit rendered lines.",
	);
	assert.throws(
		() => applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", commentary: [{ id: "partially-visible", body: "bad", side: "new", startLine: 1, endLine: 9999 }] }] }),
		/does not anchor to a visible complete new range/,
		"Both commentary range boundaries must remain visible after rendering caps.",
	);

	const anchored = parseUnifiedPatch("@@ -10,2 +10,3 @@\n same\n-old\n+new\n+extra\n", REVIEW_LIMITS);
	assert.deepEqual(anchored.lines.slice(1).map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine })), [
		{ kind: "context", oldLine: 10, newLine: 10 },
		{ kind: "del", oldLine: 11, newLine: undefined },
		{ kind: "add", oldLine: undefined, newLine: 11 },
		{ kind: "add", oldLine: undefined, newLine: 12 },
	], "Unified diff parsing should retain old/new line anchors.");
	const tiny = { ...REVIEW_LIMITS, perFilePatchBytes: 30, perFileDiffLines: 2 };
	assert.equal(parseUnifiedPatch("@@ -1 +1 @@\n-old\n+new\n", tiny).truncated, true, "Per-file byte/line boundaries should truncate visibly.");
	const overallTiny = applyReviewManifest(snapshot, { files: [] }, { ...REVIEW_LIMITS, overallPatchBytes: 1, overallDiffLines: 1 });
	assert.ok(overallTiny.files.filter((file) => !file.binary).every((file) => file.omitted), "Overall caps should omit files that cannot fit.");

	const feedback = {
		overviewFeedback: "The direction looks right ]]> overall.",
		comments: [{ file: "untracked.txt", side: "new", newStart: 1, newEnd: 2, highlight: "A ]]> marker", feedback: "Explain <this>." }],
		replies: [{ file: "untracked.txt", commentaryId: "new-file", feedback: "Makes sense ]]> mostly." }],
	};
	assert.deepEqual(parseCodeReviewFeedback(feedback, ordered), feedback);
	assert.deepEqual(parseCodeReviewFeedback({ overviewFeedback: "General note.", comments: [], replies: [] }, ordered), { overviewFeedback: "General note.", comments: [], replies: [] });
	assert.equal(parseCodeReviewFeedback({ overviewFeedback: "General note.", comments: [], replies: [] }, { ...ordered, overview: undefined }), undefined, "Overview feedback requires a rendered overview.");
	assert.equal(parseCodeReviewFeedback({ comments: [], replies: [{ file: "untracked.txt", commentaryId: "missing", feedback: "x" }] }, ordered), undefined);
	assert.equal(parseCodeReviewFeedback({ comments: [{ ...feedback.comments[0], newStart: 999, newEnd: 999 }], replies: [] }, ordered), undefined, "Forged line anchors outside the frozen diff must be rejected.");
	assert.equal(parseCodeReviewFeedback({ comments: Array.from({ length: 101 }, () => feedback.comments[0]), replies: [] }, ordered), undefined, "Feedback comment counts must be bounded.");
	assert.equal(parseCodeReviewFeedback({ comments: [{ ...feedback.comments[0], feedback: "x".repeat(20_001) }], replies: [] }, ordered), undefined, "Feedback strings must be bounded.");
	const xml = formatCodeReviewFeedbackXml(snapshot.id, false, feedback);
	assert.match(xml, /^<code-review-feedback snapshot="[a-f0-9]{64}" stale="false">/);
	assert.match(xml, /<overview-feedback>[\s\S]*direction looks right \]\]\]\]><!\[CDATA\[> overall/, "Overview feedback must be serialized safely.");
	assert.match(xml, /A \]\]\]\]><!\[CDATA\[> marker/, "CDATA terminators must be split safely.");
	assert.doesNotMatch(xml, /Why this exists/, "The feedback payload must not include agent commentary or the diff.");
	const html = renderReviewHtml(ordered, "safe-nonce");
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "Manifest text must be escaped.");
	assert.match(html, /Review this first &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /data-review-overview/, "Agent-guided reviews should begin with an overview page.");
	assert.match(html, /data-overview-feedback/, "The overview should accept general change-set feedback.");
	assert.match(html, /script nonce="safe-nonce"/);
	const plainHtml = renderReviewHtml(applyReviewManifest(snapshot, { files: [] }), "plain-nonce");
	assert.doesNotMatch(plainHtml, /<section class="review-overview|<button[^>]+data-overview-nav/, "The commentary-free slash command should continue to open directly on the diff.");
	assert.match(plainHtml, /class="review-file active"[^>]*data-review-file="0"/, "A review without an overview should show its first file initially.");

	let received;
	const server = await createCodeReviewServer(ordered, { onFeedback: async (value) => { received = value; return { stale: false }; } });
	try {
		const origin = new URL(server.url).origin;
		assert.equal((await fetch(origin)).status, 403, "Unauthenticated review requests should be rejected.");
		const bootstrap = await fetch(server.url, { redirect: "manual" });
		assert.equal(bootstrap.status, 302);
		assert.equal(bootstrap.headers.get("location"), "/", "Bootstrap should remove the token from the address bar.");
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		assert.match(bootstrap.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
		const pageResponse = await fetch(origin, { headers: { cookie } });
		const pageBody = await pageResponse.text();
		assert.equal(pageResponse.status, 200);
		assert.match(pageResponse.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
		assert.ok(!pageBody.includes(new URL(server.url).searchParams.get("token")), "Bootstrap token must not be embedded in served HTML.");
		const endpoint = `${origin}/__pi_code_review_feedback__`;
		assert.equal((await fetch(endpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://example.com" }, body: JSON.stringify(feedback) })).status, 403);
		assert.equal((await fetch(endpoint, { method: "POST", headers: { cookie, "content-type": "text/plain", origin }, body: "{}" })).status, 415);
		assert.equal((await fetch(endpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ comments: [], replies: [] }) })).status, 400);
		assert.equal((await fetch(endpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ padding: "x".repeat(256 * 1024), comments: [], replies: [] }) })).status, 413, "Feedback request bodies must be bounded.");
		const accepted = await fetch(endpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify(feedback) });
		assert.equal(accepted.status, 200);
		assert.deepEqual(received, feedback);
		assert.equal((await fetch(endpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify(feedback) })).status, 409, "Static v1 should accept only one feedback batch.");
	} finally {
		await server.close();
	}

	let releaseConcurrentFeedback;
	let concurrentCallbackCalls = 0;
	let markConcurrentCallbackEntered;
	const concurrentCallbackEntered = new Promise((resolvePromise) => { markConcurrentCallbackEntered = resolvePromise; });
	const concurrentServer = await createCodeReviewServer(ordered, {
		onFeedback: async () => {
			concurrentCallbackCalls++;
			markConcurrentCallbackEntered();
			await new Promise((resolvePromise) => { releaseConcurrentFeedback = resolvePromise; });
			return { stale: false };
		},
	});
	try {
		const origin = new URL(concurrentServer.url).origin;
		const bootstrap = await fetch(concurrentServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const request = { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify(feedback) };
		const firstSubmission = fetch(`${origin}/__pi_code_review_feedback__`, request);
		await concurrentCallbackEntered;
		const secondSubmission = await fetch(`${origin}/__pi_code_review_feedback__`, request);
		assert.equal(secondSubmission.status, 409, "A concurrent feedback submission must be rejected while the first callback is pending.");
		releaseConcurrentFeedback();
		assert.equal((await firstSubmission).status, 200);
		assert.equal(concurrentCallbackCalls, 1, "Concurrent POSTs must invoke Pi feedback delivery exactly once.");
	} finally {
		releaseConcurrentFeedback?.();
		await concurrentServer.close();
	}

	const browserCandidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
	let executablePath;
	for (const candidate of browserCandidates) {
		try { await access(candidate); executablePath = candidate; break; } catch {}
	}
	if (executablePath) {
		let browserFeedback;
		const browserServer = await createCodeReviewServer(ordered, { onFeedback: async (value) => { browserFeedback = value; return { stale: false }; } });
		const browser = await puppeteer.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
		try {
			const page = await browser.newPage();
			await page.goto(browserServer.url, { waitUntil: "domcontentloaded" });
			assert.equal(await page.$eval('[data-review-overview]', (section) => section.hidden), false, "Agent-guided reviews should open on the overview.");
			await page.type('[data-overview-feedback]', "Keep the introduction quick.");
			await page.click('[data-file-nav="0"]');
			await page.evaluate(() => {
				const code = document.querySelector('[data-review-file="0"] .diff-add .diff-code span');
				const range = document.createRange();
				range.selectNodeContents(code);
				const selection = window.getSelection();
				selection.removeAllRanges(); selection.addRange(range);
				code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			});
			await page.waitForFunction(() => document.querySelector('[data-review-file="0"] [data-selection-composer]')?.hidden === false);
			await page.type('[data-review-file="0"] [data-selection-feedback]', "Please rename this.");
			await page.$eval('[data-review-file="0"] [data-selection-feedback]', (textarea) => {
				textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
			});
			assert.equal(await page.$eval('[data-review-file="0"] [data-selection-composer]', (composer) => composer.hidden), true, "Command+Enter should add the active diff comment without submitting the review.");
			assert.equal(await page.$$eval('[data-review-file="0"] .user-comment', (comments) => comments.length), 1);
			assert.equal(await page.evaluate(() => CSS.highlights.get("pi-code-review-feedback")?.size), 1);
			await page.type('[data-review-file="0"] [data-commentary-reply="new-file"]', "Why not generate this?");
			await page.evaluate(() => {
				const code = document.querySelectorAll('[data-review-file="0"] .diff-add .diff-code span')[1];
				const range = document.createRange();
				range.selectNodeContents(code);
				const selection = window.getSelection();
				selection.removeAllRanges(); selection.addRange(range);
				code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			});
			await page.waitForFunction(() => document.querySelector('[data-review-file="0"] [data-selection-composer]')?.hidden === false);
			await page.type('[data-review-file="0"] [data-selection-feedback]', "Unfinished second comment.");
			assert.equal(await page.$eval("[data-submit]", (button) => button.disabled), true, "Submit must remain disabled while a selection comment draft is active.");
			page.once("dialog", async (dialog) => { await dialog.dismiss(); });
			await page.click('[data-file-nav="1"]');
			assert.equal(await page.$eval('[data-review-file="0"]', (section) => section.hidden), false, "Dismissing the draft warning must keep the current file and draft visible.");
			page.once("dialog", async (dialog) => { await dialog.accept(); });
			await page.click('[data-file-nav="1"]');
			assert.equal(await page.$eval('[data-review-file="1"]', (section) => section.hidden), false, "Confirming draft discard should allow explicit file navigation.");
			await page.click('[data-file-nav="0"]');
			await page.click("[data-submit]");
			await page.waitForFunction(() => document.querySelector("[data-submit]")?.textContent === "Submitted");
			assert.equal(browserFeedback.overviewFeedback, "Keep the introduction quick.");
			assert.equal(browserFeedback.comments.length, 1);
			assert.equal(browserFeedback.comments[0].file, "untracked.txt");
			assert.equal(browserFeedback.comments[0].side, "new");
			assert.equal(browserFeedback.replies[0].commentaryId, "new-file");
			assert.equal(await page.$eval('[data-commentary-reply="new-file"]', (element) => element.disabled), true, "Submitted controls should lock.");
			console.log("Headless browser feedback flow passed.");
		} finally {
			await browser.close();
			await browserServer.close();
		}
	} else {
		console.log("Headless browser feedback flow skipped: Chrome/Chromium not found.");
	}

	const largeFixture = await mkdtemp(join(tmpdir(), "pi-code-review-large-"));
	try {
		await git(largeFixture, "init", "-q");
		await git(largeFixture, "config", "user.email", "test@example.com");
		await git(largeFixture, "config", "user.name", "Test");
		await writeFile(join(largeFixture, "tracked-large.txt"), "baseline\n");
		await git(largeFixture, "add", ".");
		await git(largeFixture, "commit", "-qm", "baseline");
		const largeText = "large changed line with enough content\n".repeat(12_000);
		await writeFile(join(largeFixture, "tracked-large.txt"), largeText);
		await writeFile(join(largeFixture, "untracked-large.txt"), largeText);
		const largeSnapshot = await collectReviewSnapshot(largeFixture);
		for (const path of ["tracked-large.txt", "untracked-large.txt"]) {
			const file = largeSnapshot.files.find((entry) => entry.path === path);
			assert.ok(file, `${path} should be collected.`);
			assert.equal(file.truncated, true, `${path} should open as a truncated review rather than failing collection.`);
			assert.ok(file.patchBytes > REVIEW_LIMITS.perFilePatchBytes, `${path} should report its full patch size.`);
			assert.ok(file.lines.length <= REVIEW_LIMITS.perFileDiffLines, `${path} should retain only the configured render window.`);
			assert.ok(file.renderedBytes <= REVIEW_LIMITS.perFilePatchBytes, `${path} retained rendering must obey the byte cap.`);
		}
		await writeFile(join(largeFixture, "untracked-large.txt"), `${largeText.slice(0, -2)}tail changed\n`);
		assert.notEqual((await collectReviewSnapshot(largeFixture)).id, largeSnapshot.id, "Untracked content beyond the retained render window must remain fingerprinted.");
		await writeFile(join(largeFixture, "untracked-large.txt"), largeText);
		await writeFile(join(largeFixture, "tracked-large.txt"), `${largeText.slice(0, -2)}tail changed\n`);
		assert.notEqual((await collectReviewSnapshot(largeFixture)).id, largeSnapshot.id, "Tracked patch content beyond the retained render window must remain fingerprinted.");
	} finally {
		await rm(largeFixture, { recursive: true, force: true });
	}

	await writeFile(join(fixture, "untracked.txt"), "changed after snapshot\n");
	assert.notEqual((await collectReviewSnapshot(fixture)).id, snapshot.id, "Changed frozen content must change the snapshot fingerprint.");
	console.log("pi-code-review regression checks passed.");
} finally {
	await rm(fixture, { recursive: true, force: true });
}
