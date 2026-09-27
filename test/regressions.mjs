import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { applyReviewManifest, collectReviewSnapshot, computeContextGaps, computeWorktreeFingerprint, createPinnedBlobContextReader, currentSnapshotId, currentSnapshotProbe, parseUnifiedPatch, readHeadBlobLines, REVIEW_LIMITS, reviewFileDriftKey } from "../shared/git-review.js";
import { formatReviewApprovedXml, formatReviewPassXml, formatThreadContextXml, formatThreadMessageXml } from "../shared/feedback.js";
import { renderReviewHtml } from "../shared/render.js";
import { renderMarkdown } from "../shared/markdown.js";
import { computeIntraline } from "../shared/render.js";
import { createCodeReviewServer } from "../shared/server.js";
import { buildCarriedThreads, buildHeldThreads, createThreadStore, THREAD_LIMITS, threadsAwaitingResponse } from "../shared/threads.js";
import { createReviewMessageQueue } from "../shared/delivery-queue.js";
import { buildPlanReview, PLAN_LIMITS, resolvePlanResponses, sectionizePlan } from "../shared/plan-review.js";

const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
const fixture = await mkdtemp(join(tmpdir(), "pi-code-review-"));
let contextRepo;
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

	const worktreeFingerprint = await computeWorktreeFingerprint(fixture);
	assert.equal(await computeWorktreeFingerprint(fixture), worktreeFingerprint, "The cheap worktree fingerprint is stable while nothing changes.");
	assert.equal(await currentSnapshotId(fixture), snapshot.id, "currentSnapshotId matches a fresh snapshot of the same tree.");
	await writeFile(join(fixture, "unstaged.txt"), "baseline\nunstaged addition\ndrift\n");
	assert.notEqual(await computeWorktreeFingerprint(fixture), worktreeFingerprint, "Editing an already-changed file moves the cheap fingerprint.");
	assert.notEqual(await currentSnapshotId(fixture), snapshot.id, "Edited content produces a different snapshot id.");
	await writeFile(join(fixture, "unstaged.txt"), "baseline\nunstaged addition\n");
	assert.equal(await currentSnapshotId(fixture), snapshot.id, "Restoring the tree restores the snapshot id.");
	{
		const cleanRepo = await mkdtemp(join(tmpdir(), "pi-code-review-clean-"));
		try {
			await git(cleanRepo, "init", "-q");
			await git(cleanRepo, "config", "user.email", "test@example.com");
			await git(cleanRepo, "config", "user.name", "Test");
			await writeFile(join(cleanRepo, "only.txt"), "committed\n");
			await git(cleanRepo, "add", ".");
			await git(cleanRepo, "commit", "-qm", "baseline");
			assert.equal(await currentSnapshotId(cleanRepo), "", "A tree with no changes against HEAD reads as empty — never equal to any snapshot id.");
		} finally {
			await rm(cleanRepo, { recursive: true, force: true });
		}
	}

	const ordered = applyReviewManifest(snapshot, {
		title: "Safe <review>",
		overview: {
			intent: "Make local code review faster before opening a pull request.",
			changes: ["Add a guided overview.", "Keep file-level review focused."],
			validation: ["Run automated regression checks."],
			reviewFocus: "Check whether the overview is sufficiently concise.",
		},
		files: [
			{
				path: "untracked.txt",
				summary: "Review this first <script>alert(1)</script>",
				commentary: [
					{ id: "new-file", body: "Why this exists", side: "new", startLine: 1, endLine: 2 },
					{ id: "second-note", body: "Also check the tail of this file." },
				],
			},
			{
				path: "unstaged.txt",
				summary: "Deterministic fixture output covered by its source test.",
				reviewMode: "reference",
			},
		],
	});
	assert.equal(ordered.files[0].path, "untracked.txt", "Agent-provided order should lead.");
	assert.equal(ordered.files.length, snapshot.files.length, "Changed files omitted by the manifest must be appended.");
	assert.equal(ordered.overview.intent, "Make local code review faster before opening a pull request.");
	assert.equal(ordered.files.find((file) => file.path === "unstaged.txt")?.reviewMode, "reference", "Pi should be able to classify textual artifacts as reference files.");
	assert.equal(ordered.files.find((file) => file.path === "binary.dat")?.reviewMode, "reference", "Binary files should be reference files automatically.");

	// Drift keys must agree across the two layers that compute them: the frozen
	// round's manifest-normalized files and a fresh worktree probe of the same
	// tree. Divergence here would fabricate or mask per-file drift.
	const driftProbe = await currentSnapshotProbe(fixture);
	assert.equal(driftProbe.id, ordered.id, "An untouched worktree probes to the frozen snapshot id.");
	for (const file of ordered.files) {
		const probed = driftProbe.files.find((candidate) => candidate.path === file.path);
		assert.ok(probed, `The probe must cover ${file.path}.`);
		assert.equal(reviewFileDriftKey(file), probed.key, `Drift keys must agree across manifest and probe for ${file.path}.`);
	}
	const binaryFile = ordered.files.find((file) => file.path === "binary.dat");
	assert.notEqual(reviewFileDriftKey({ ...binaryFile, contentSha256: "changed" }), reviewFileDriftKey(binaryFile), "A content change moves the drift key even when the rendering is identical.");
	assert.equal(reviewFileDriftKey({ ...binaryFile, omitted: true, lines: [] }), reviewFileDriftKey(binaryFile), "Render-layer capping must not move a file's drift key.");
	assert.throws(() => applyReviewManifest(snapshot, { overview: { intent: "Too sparse", changes: ["Only one"], validation: ["Checked"] }, files: [] }), /changes must contain 2 to 4 entries/);
	assert.throws(() => applyReviewManifest(snapshot, { overview: { intent: "a ".repeat(240), changes: ["a ".repeat(240), "a ".repeat(240)], validation: ["seven eight"] }, files: [] }), /at most 500 words/);
	assert.throws(() => applyReviewManifest(snapshot, { files: [{ path: "../secret", summary: "bad" }] }), /not changed against HEAD/);
	assert.throws(() => applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", reviewMode: "skip" }] }), /must be review or reference/, "Unknown review classifications must be rejected.");
	assert.throws(() => applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", commentary: [{ id: "end-only", body: "bad", endLine: 2 }] }] }), /cannot set endLine without startLine/, "Commentary endLine requires a startLine.");
	assert.throws(() => applyReviewManifest(snapshot, { files: [{ path: "binary.dat", commentary: [{ id: "binary-anchor", body: "bad", side: "new", startLine: 1 }] }] }), /cannot anchor to binary file/, "Binary commentary cannot claim a visible line anchor.");
	assert.throws(
		() => applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", commentary: [{ id: "omitted-anchor", body: "bad", side: "new", startLine: 1 }] }] }, { ...REVIEW_LIMITS, overallPatchBytes: 0, overallDiffLines: 0 }),
		/does not anchor to a visible new line/,
		"Commentary anchors must be checked after overall caps omit rendered lines.",
	);
	assert.throws(
		() => applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", commentary: [{ id: "partially-visible", body: "bad", side: "new", startLine: 1, endLine: 9999 }] }] }),
		/does not anchor to a visible complete new range in [^ ]+ \(visible new lines: [\d, -]+\)/,
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
	const primarySource = snapshot.files.find((file) => file.path === "untracked.txt");
	assert.ok(primarySource);
	const prioritizedCaps = applyReviewManifest(snapshot, {
		files: [
			{ path: "unstaged.txt", reviewMode: "reference" },
			{ path: "untracked.txt", reviewMode: "review" },
		],
	}, { ...REVIEW_LIMITS, overallPatchBytes: primarySource.renderedBytes, overallDiffLines: primarySource.lines.length });
	assert.equal(prioritizedCaps.files.find((file) => file.path === "untracked.txt")?.omitted, false, "Primary review files must receive rendering capacity before references.");
	assert.equal(prioritizedCaps.files.find((file) => file.path === "unstaged.txt")?.omitted, true, "References should yield rendering capacity to primary review files regardless of manifest order.");

	const store = createThreadStore(ordered);
	const seeded = store.list();
	assert.deepEqual(seeded.map((thread) => thread.commentaryId), ["new-file", "second-note"], "Commentary notes seed threads at store creation.");
	assert.deepEqual(store.summary(), { open: 2, awaitingUser: 2, awaitingPi: 0, resolved: 0 }, "Unread notes await the reviewer from the start.");
	assert.equal(store.postUserTurn({ source: "selection", file: "untracked.txt", side: "new", newStart: 999, newEnd: 999, highlight: "x", body: "y" }).error, "invalid", "Forged line anchors outside the frozen diff must be rejected.");
	assert.equal(store.postUserTurn({ source: "selection", file: "binary.dat", side: "new", newStart: 1, newEnd: 1, highlight: "x", body: "y" }).error, "invalid", "Binary files cannot host selection threads.");
	assert.equal(store.postUserTurn({ source: "commentary", file: "untracked.txt", commentaryId: "missing", body: "y" }).error, "invalid", "Unknown commentary ids must be rejected.");
	assert.equal(store.postUserTurn({ threadId: "forged", body: "y" }).error, "unknown-thread", "Forged thread ids must be rejected.");
	assert.equal(store.postUserTurn({ source: "selection", file: "untracked.txt", side: "new", newStart: 1, newEnd: 2, highlight: "x", body: "y".repeat(20_001) }).error, "invalid", "Thread bodies must be bounded.");
	const selectionPost = store.postUserTurn({ source: "selection", file: "untracked.txt", side: "new", newStart: 1, newEnd: 2, highlight: "A ]]> marker", body: "Explain <this>." });
	assert.match(selectionPost.thread.id, /^[a-f0-9]{8}-[a-f0-9]{6}-t3$/, "Thread ids should be scoped to the snapshot and salted per store.");
	assert.equal(selectionPost.thread.turns.length, 1);
	assert.equal(store.postUserTurn({ threadId: selectionPost.thread.id, body: "More detail." }).thread.turns.length, 2, "Reviewer replies append to the thread.");
	const commentaryPost = store.postUserTurn({ source: "commentary", file: "untracked.txt", commentaryId: "new-file", body: "Why not generate this?" });
	assert.deepEqual(commentaryPost.thread.turns.map((turn) => turn.author), ["pi", "user"], "Commentary threads open with Pi's commentary as the first turn.");
	assert.equal(store.postUserTurn({ source: "commentary", file: "untracked.txt", commentaryId: "new-file", body: "One more question." }).thread.id, commentaryPost.thread.id, "Commentary replies must join the existing thread.");
	const overviewPost = store.postUserTurn({ source: "overview", body: "The direction looks right ]]> overall." });
	assert.notEqual(store.postUserTurn({ source: "overview", body: "Second overview topic." }).thread.id, overviewPost.thread.id, "Each overview post starts its own topic thread.");
	assert.equal(createThreadStore({ ...ordered, overview: undefined }).postUserTurn({ source: "overview", body: "x" }).error, "invalid", "Overview threads require a rendered overview.");
	assert.equal(store.postPiReply(selectionPost.thread.id, "Because it is clearer.", true).piProposedResolve, true, "Pi replies may propose resolution.");
	assert.equal(store.postPiReply("missing", "x", false), undefined, "Pi replies to unknown threads must be rejected.");
	assert.deepEqual(store.summary(), { open: 5, awaitingUser: 2, awaitingPi: 3, resolved: 0 });
	const resolvedThread = store.setResolved(selectionPost.thread.id, true);
	assert.equal(resolvedThread.status, "resolved");
	assert.equal(resolvedThread.piProposedResolve, false, "Resolution clears the pending proposal.");
	assert.equal(store.setResolved("missing", true), undefined);
	assert.equal(store.postUserTurn({ threadId: selectionPost.thread.id, body: "Actually, one more thing." }).thread.status, "open", "A reviewer reply reopens a resolved thread.");
	const seedExempt = createThreadStore(ordered, { ...THREAD_LIMITS, maxThreads: 1 });
	assert.equal(seedExempt.list().length, 2, "Seeded notes are exempt from the reviewer-thread cap.");
	assert.equal(seedExempt.postUserTurn({ source: "overview", body: "allowed" }).error, undefined, "Seeds must not consume the reviewer's thread budget.");
	const cramped = createThreadStore(ordered, { ...THREAD_LIMITS, maxThreads: 3 });
	assert.equal(cramped.postUserTurn({ source: "overview", body: "first" }).error, undefined);
	assert.equal(cramped.postUserTurn({ source: "overview", body: "second" }).error, undefined);
	assert.equal(cramped.postUserTurn({ source: "overview", body: "third" }).error, undefined, "The reviewer budget is fully available despite seeds.");
	assert.equal(cramped.postUserTurn({ source: "selection", file: "untracked.txt", side: "new", newStart: 1, newEnd: 1, highlight: "x", body: "y" }).error, "too-many-threads", "Reviewer-created thread counts must be bounded.");
	const shallow = createThreadStore(ordered, { ...THREAD_LIMITS, maxTurnsPerThread: 1 });
	const shallowThread = shallow.postUserTurn({ source: "overview", body: "only" }).thread;
	assert.equal(shallow.postUserTurn({ threadId: shallowThread.id, body: "again" }).error, "thread-full", "Turn counts must be bounded.");
	assert.notEqual(
		createThreadStore(ordered).postUserTurn({ source: "overview", body: "x" }).thread.id,
		createThreadStore(ordered).postUserTurn({ source: "overview", body: "x" }).thread.id,
		"Independent stores over one snapshot must mint globally distinct thread ids.",
	);
	const lateStore = createThreadStore(ordered);
	const lateThread = lateStore.postUserTurn({ source: "overview", body: "resolve me" }).thread;
	lateStore.setResolved(lateThread.id, true);
	const lateReply = lateStore.postPiReply(lateThread.id, "Late addendum.", true);
	assert.equal(lateReply.status, "resolved", "Pi replies must not reopen resolved threads.");
	assert.equal(lateReply.piProposedResolve, false, "Resolution proposals do not apply to resolved threads.");
	assert.deepEqual(lateStore.summary(), { open: 2, awaitingUser: 2, awaitingPi: 0, resolved: 1 }, "Seeded notes coexist with resolved reviewer threads.");

	const selectionThread = store.getThread(selectionPost.thread.id);
	const threadXml = formatThreadMessageXml(ordered, selectionThread, selectionThread.turns[selectionThread.turns.length - 1]);
	assert.match(threadXml, /^<code-review-thread snapshot="[a-f0-9]{64}" thread="[a-f0-9]{8}-[a-f0-9]{6}-t3" kind="selection" status="open" file="untracked.txt" delivered-user-turns="\d+" side="new" new-start="1" new-end="2">/);
	assert.match(threadXml, /A \]\]\]\]><!\[CDATA\[> marker/, "CDATA terminators must be split safely.");
	assert.match(threadXml, /<message author="user" turn="\d+"><!\[CDATA\[Actually, one more thing\.\]\]><\/message>/, "Messages carry their creation-time turn number.");
	const noteThread = seeded.find((thread) => thread.commentaryId === "new-file");
	const noteXml = formatThreadMessageXml(ordered, noteThread, noteThread.turns[0]);
	assert.match(noteXml, / commentary-id="new-file" delivered-user-turns="0" side="new" start-line="1" end-line="2">/, "Commentary messages carry the note's anchor, never just its id.");
	const passXml = formatReviewPassXml(ordered, store.list(), store.summary(), false, "Note ]]> here");
	assert.match(passXml, /^<code-review-pass snapshot="[a-f0-9]{64}" stale="false" open="5" awaiting-user="1" awaiting-pi="4" resolved="0" unread-notes="1" queued="0" pending="0">/, "Header counts must reconcile with the omitted untouched notes.");
	assert.match(passXml, /<note><!\[CDATA\[Note \]\]\]\]><!\[CDATA\[> here\]\]><\/note>/, "Finish notes must be serialized safely.");
	assert.match(passXml, /<open-thread thread="[a-f0-9]{8}-[a-f0-9]{6}-t1" kind="commentary" status="open" file="untracked.txt" commentary-id="new-file" delivered-user-turns="\d+" side="new" start-line="1" end-line="2" last-author="user">/, "Pass blocks are self-contained: the note's anchor rides along.");
	assert.match(passXml, /<last-message turn="\d+">/, "Last-message blocks carry the turn number for the audit ledger.");
	{
		// A thread Pi answered last: attributes carry the whole signal; the body
		// would be Pi's own words echoed back — never serialized.
		const echoStore = createThreadStore(ordered);
		const echoThread = echoStore.postUserTurn({ source: "overview", body: "Reviewer asks." }).thread;
		echoStore.postPiReply(echoThread.id, "Pi's own resolution prose.", false);
		const echoPass = formatReviewPassXml(ordered, echoStore.list(), echoStore.summary(), false, undefined);
		const echoBlock = echoPass.split("<open-thread ").find((block) => block.includes(`thread="${echoThread.id}"`));
		assert.match(echoBlock, /last-author="pi"/);
		assert.doesNotMatch(echoBlock, /<last-message/, "Pi's own newest turn is never echoed back in the pass digest.");
		assert.doesNotMatch(echoPass, /resolution prose/, "No copy of Pi's reply body survives anywhere in the digest.");
	}
	assert.doesNotMatch(passXml, /Why this exists/, "Pass summaries carry only the last message of each open thread.");
	assert.doesNotMatch(passXml, /commentary-id="second-note"/, "Untouched notes are never echoed back to Pi.");

	const noteThreadId = seeded.find((thread) => thread.commentaryId === "second-note").id;
	assert.equal(store.setResolved(noteThreadId, true).status, "resolved", "Notes resolve without composing a reply.");
	assert.deepEqual(store.summary(), { open: 4, awaitingUser: 0, awaitingPi: 4, resolved: 1 });
	assert.equal(store.setResolved(noteThreadId, false).status, "open", "Resolved notes can be reopened.");
	assert.deepEqual(store.summary(), { open: 5, awaitingUser: 1, awaitingPi: 4, resolved: 0 }, "Reopened notes await the reviewer again.");
	assert.doesNotMatch(formatReviewPassXml(ordered, store.list(), store.summary(), false, undefined), /commentary-id="second-note"/, "Reviewer-untouched notes never appear in pass summaries even when reopened.");
	assert.match(formatThreadMessageXml(ordered, selectionThread, selectionThread.turns[0], 3), /^<code-review-thread snapshot="[a-f0-9]{64}" round="3" /, "Thread messages must carry their round number when provided.");
	assert.match(formatReviewPassXml(ordered, store.list(), store.summary(), false, undefined, 2), /^<code-review-pass snapshot="[a-f0-9]{64}" round="2" /, "Pass summaries must carry their round number when provided.");

	const carrySource = createThreadStore(ordered);
	const carryTopic = carrySource.postUserTurn({ source: "overview", body: "Please split this function." }).thread;
	const carrySelection = carrySource.postUserTurn({ source: "selection", file: "untracked.txt", side: "new", newStart: 1, newEnd: 2, highlight: "A marker", body: "Rename?" }).thread;
	const carryResolved = carrySource.postUserTurn({ source: "overview", body: "Settled topic." }).thread;
	carrySource.setResolved(carryResolved.id, true);
	const untouchedSeedId = carrySource.list().find((thread) => thread.source === "commentary").id;
	assert.throws(() => buildCarriedThreads([], carrySource.list(), ordered, 1), /missing: .*-t/, "Every open thread must receive a response.");
	assert.throws(() => buildCarriedThreads([{ respondsTo: untouchedSeedId, resolution: "addressed", body: "x" }], carrySource.list(), ordered, 1), /does not match an open thread/, "Untouched notes are not respondable; they die with their round.");
	assert.throws(() => buildCarriedThreads([{ respondsTo: carryResolved.id, resolution: "addressed", body: "x" }], carrySource.list(), ordered, 1), /does not match an open thread/, "Resolved threads do not carry forward.");
	const validPair = [
		{ respondsTo: carryTopic.id, resolution: "needs-discussion", body: "Still deciding on the split." },
		{ respondsTo: carrySelection.id, resolution: "addressed", body: "Renamed here.", file: "untracked.txt", side: "new", startLine: 1, endLine: 2 },
	];
	assert.throws(() => buildCarriedThreads([validPair[0], validPair[0], validPair[1]], carrySource.list(), ordered, 1), /more than one response/);
	assert.throws(() => buildCarriedThreads([validPair[0], { ...validPair[1], resolution: "done" }], carrySource.list(), ordered, 1), /resolution of addressed, declined, or needs-discussion/);
	assert.throws(() => buildCarriedThreads([validPair[0], { ...validPair[1], file: "missing.txt" }], carrySource.list(), ordered, 1), /not part of this round/);
	assert.throws(() => buildCarriedThreads([validPair[0], { ...validPair[1], startLine: 999, endLine: 999 }], carrySource.list(), ordered, 1), /visible complete new range/);
	assert.throws(() => buildCarriedThreads([validPair[0], { respondsTo: carrySelection.id, resolution: "addressed", body: "x", startLine: 1 }], carrySource.list(), ordered, 1), /without a file/);
	assert.throws(() => buildCarriedThreads([validPair[0], { respondsTo: carrySelection.id, resolution: "addressed", body: "x", file: "untracked.txt", side: "new" }], carrySource.list(), ordered, 1), /without startLine/, "Partial anchors must be rejected, not downgraded to file placement.");
	assert.throws(() => buildCarriedThreads([validPair[0], { respondsTo: carrySelection.id, resolution: "addressed", body: "x", file: "untracked.txt", endLine: 2 }], carrySource.list(), ordered, 1), /without startLine/);
	assert.throws(() => buildCarriedThreads([validPair[0], { ...validPair[1], file: "binary.dat" }], carrySource.list(), ordered, 1), /cannot line-anchor/, "Binary files reject line anchors for carried threads.");
	const capSource = createThreadStore(ordered, { ...THREAD_LIMITS, maxTurnsPerThread: 2 });
	const capThread = capSource.postUserTurn({ source: "overview", body: "cap me" }).thread;
	capSource.postPiReply(capThread.id, "at cap", false);
	const capCarried = buildCarriedThreads([{ respondsTo: capThread.id, resolution: "needs-discussion", body: "carrying" }], capSource.list(), ordered, 1);
	const capStore = createThreadStore(ordered, { ...THREAD_LIMITS, maxTurnsPerThread: 2 }, capCarried);
	assert.equal(capStore.postUserTurn({ threadId: capThread.id, body: "reply" }).error, "thread-full", "Over-cap carried threads reject replies without crashing.");
	assert.equal(capStore.setResolved(capThread.id, true).status, "resolved", "Resolution remains the exit for over-cap carried threads.");
	const carriedRecords = buildCarriedThreads(validPair, carrySource.list(), ordered, 1);
	assert.deepEqual(carriedRecords.map((record) => record.id), [carryTopic.id, carrySelection.id], "Carried threads keep their round-of-origin ids.");
	assert.equal(carriedRecords[0].carried.placement, "overview", "A file-less response to an overview thread carries it home, not to the outdated group.");
	assert.equal(carriedRecords[1].carried.placement, "anchored");
	assert.equal(carriedRecords[1].piProposedResolve, true, "Addressed responses arrive as resolution proposals.");
	assert.equal(carriedRecords[1].highlight, "A marker", "The origin highlight travels with the carried thread.");
	assert.equal(carriedRecords[1].turns.length, carrySelection.turns.length + 1);
	assert.equal(carriedRecords[1].turns[carriedRecords[1].turns.length - 1].resolution, "addressed");
	const carryStore = createThreadStore(ordered, { ...THREAD_LIMITS, maxThreads: 1 }, carriedRecords);
	assert.equal(carryStore.list().length, 4, "Seeds and carried threads coexist in the next round's store.");
	assert.equal(carryStore.postUserTurn({ source: "overview", body: "fresh topic" }).error, undefined, "Carried threads must not consume the reviewer's thread budget.");
	assert.deepEqual(carryStore.summary(), { open: 5, awaitingUser: 4, awaitingPi: 1, resolved: 0 }, "Carried threads await the reviewer like any Pi reply.");
	assert.equal(carryStore.postUserTurn({ threadId: carrySelection.id, body: "Verified, thanks." }).thread.turns.length, carriedRecords[1].turns.length + 1, "Reviewers reply to the carried copy by its original id.");
	assert.equal(carryStore.setResolved(carryTopic.id, true).status, "resolved");
	const carryPassXml = formatReviewPassXml(ordered, carryStore.list(), carryStore.summary(), false, undefined, 2);
	assert.match(carryPassXml, /carried-from-round="1" resolution="addressed"/, "Pass summaries must identify carried threads and their resolutions.");
	const carryHtml = renderReviewHtml(ordered, "carry-nonce", { round: 2, currentRound: 2, phase: "reviewing" }, { carried: carryStore.list().filter((thread) => thread.carried), archive: [{ round: 1, resolved: [{ id: "abc-t9", source: "selection", file: "untracked.txt", highlight: "A marker" }] }] });
	{
		const feedbackSection = /<section class="overview-feedback">[\s\S]*?<\/section>/.exec(carryHtml)[0];
		assert.ok(feedbackSection.includes(`data-carried-thread="${carryTopic.id}"`), "A carried overview thread renders in the overview's General feedback section.");
		assert.doesNotMatch(carryHtml, /data-outdated-threads/, "No thread with a live home lands in the outdated group.");
	}
	assert.match(carryHtml, new RegExp(`data-carried-thread="${carriedRecords[1].id}"[^>]*data-anchor-side="new" data-anchor-start="1"`), "Anchored carried shells must expose their jump anchor.");
	assert.match(carryHtml, new RegExp(`data-carried-thread="${carriedRecords[1].id}"[^]*?class="agent-note-anchor">new lines 1–2<span class="anchor-preview">A marker</span></button>`), "Carried anchor chips quote the origin selection's highlight.");
	assert.match(carryHtml, new RegExp(`href="/round/1#thread=${carriedRecords[1].id}"`), "Carried shells must deep-link to their origin round.");
	{
		// A file-less response to a FILE-anchored thread is genuinely outdated —
		// its home is gone; only those land in the outdated group.
		const outdatedSource = createThreadStore(ordered);
		const lostThread = outdatedSource.postUserTurn({ source: "selection", file: "untracked.txt", side: "new", newStart: 1, newEnd: 1, highlight: "x", body: "Where did this go?" }).thread;
		const lostRecords = buildCarriedThreads([{ respondsTo: lostThread.id, resolution: "declined", body: "That file was removed." }], outdatedSource.list(), ordered, 1);
		assert.equal(lostRecords[0].carried.placement, "outdated");
		const lostHtml = renderReviewHtml(ordered, "lost-nonce", { round: 2, currentRound: 2, phase: "reviewing" }, { carried: lostRecords, archive: [] });
		assert.match(lostHtml, /Outdated threads/, "Truly homeless carried threads land in the overview's outdated group.");
		assert.match(lostHtml, /outdated — anchored to round 1/);
	}
	assert.match(carryHtml, /Resolved in earlier rounds \(1\)/, "Prior-round resolutions collect in the overview archive.");
	assert.match(carryHtml, /href="\/round\/1#thread=abc-t9"/);
	{
		// Anchor chips carry a ~40-character preview of the anchored content:
		// longer highlights truncate with an ellipsis, multi-line ones collapse.
		const previewHtml = renderReviewHtml(ordered, "preview-nonce", { round: 2, currentRound: 2, phase: "reviewing" }, {
			carried: [
				{ id: "prev-t1", source: "selection", file: "untracked.txt", highlight: "y".repeat(60), carried: { fromRound: 1, resolution: "addressed", placement: "anchored", side: "new", startLine: 1, endLine: 2 }, turns: [] },
				{ id: "prev-t2", source: "selection", file: "untracked.txt", highlight: "alpha\n   beta", carried: { fromRound: 1, resolution: "declined", placement: "anchored", side: "new", startLine: 1, endLine: 1 }, turns: [] },
			],
			archive: [],
		});
		assert.match(previewHtml, /<span class="anchor-preview">y{40}…<\/span>/, "Anchor previews truncate to 40 characters with an ellipsis.");
		assert.match(previewHtml, /<span class="anchor-preview">alpha beta<\/span>/, "Multi-line highlights collapse to a single preview line.");
	}

	const quietStore = createThreadStore(ordered);
	const quietThread = quietStore.postUserTurn({ source: "overview", body: "First quiet.", quiet: true }).thread;
	assert.equal(quietThread.queued, true, "Quiet posts stay undelivered.");
	assert.equal(quietStore.postUserTurn({ threadId: quietThread.id, body: "Second quiet.", quiet: true }).thread.queued, true, "Quiet replies keep the thread queued.");
	const escalatedResult = quietStore.postUserTurn({ threadId: quietThread.id, body: "Answer now." });
	assert.equal(escalatedResult.escalated, true, "A live reply escalates the queued backlog.");
	assert.equal(escalatedResult.thread.queued, false);
	assert.equal(quietStore.postUserTurn({ source: "commentary", file: "untracked.txt", commentaryId: "new-file", body: "Quiet note reply.", quiet: true }).thread.queued, true, "Quiet replies to Pi notes queue as well.");
	const quietTwo = quietStore.postUserTurn({ source: "overview", body: "Still quiet.", quiet: true }).thread;
	const quietPassXml = formatReviewPassXml(ordered, quietStore.list(), quietStore.summary(), false, undefined, 1);
	assert.match(quietPassXml, / queued="2" pending="0">/, "The pass header counts queued threads.");
	assert.match(quietPassXml, /<open-thread [^>]*queued="true"[^>]*>\n {4}<message author="user" turn="\d+"><!\[CDATA\[Still quiet\.\]\]><\/message>/, "Queued threads carry their full reviewer content in the pass.");
	assert.match(quietPassXml, /<open-thread [^>]*delivered-user-turns="1"[^>]*queued="true"[^>]*>\n {4}<message author="user" turn="\d+"><!\[CDATA\[Still quiet\.\]\]>/, "A queued block's counter reports the state after this pass delivers it.");
	assert.match(quietPassXml, /<open-thread [^>]*delivered-user-turns="3"[^>]*last-author="user">\n {4}<last-message turn="\d+"><!\[CDATA\[Answer now\.\]\]>/, "Plain blocks report the exact lifetime delivered count.");
	assert.match(quietPassXml, /Quiet note reply\./, "Queued note replies reach Pi through the pass.");
	assert.doesNotMatch(quietPassXml, /Second quiet\./, "Escalated threads were already delivered; the pass keeps only their last message.");
	assert.doesNotMatch(quietPassXml, /Why this exists/, "Queued note threads must not echo Pi's own note back.");
	const quietOnLive = quietStore.postUserTurn({ threadId: quietThread.id, body: "Quiet on live.", quiet: true }).thread;
	assert.equal(quietOnLive.queued, false, "Live threads never revert to queued.");
	assert.equal(quietOnLive.pending, 1, "A quiet reply on a live thread becomes a pending message.");
	assert.match(quietPassXml, / awaiting-pi="1" resolved="0" unread-notes="1" queued="2" pending="0">/, "The pass header excludes queued threads from awaiting-pi.");
	const pendingPassXml = formatReviewPassXml(ordered, quietStore.list(), quietStore.summary(), false, undefined, 1);
	assert.match(pendingPassXml, / queued="2" pending="1">/, "The pass header counts pending messages on live threads.");
	assert.match(pendingPassXml, /<open-thread [^>]*pending="1"[^>]*>\n {4}<message author="user" pending="true" turn="\d+"><!\[CDATA\[Quiet on live\.\]\]><\/message>/, "Live threads deliver exactly their pending tail through the pass.");
	assert.match(pendingPassXml, /<open-thread [^>]*delivered-user-turns="4"[^>]*pending="1"[^>]*>/, "A pending block's counter includes the tail this pass delivers (3 delivered + 1 pending).");
	assert.doesNotMatch(pendingPassXml, /<last-message><!\[CDATA\[Quiet on live\.\]\]>/, "Pending tails replace last-message serialization.");
	assert.equal(quietStore.markAllDelivered().length, 3, "Sending the round delivers every thread with undelivered messages.");
	assert.equal(quietStore.getThread(quietTwo.id).queued, false, "Delivered threads leave the queued state.");
	assert.equal(quietStore.getThread(quietThread.id).pending, 0, "Pending tails are delivered by the round send.");
	const sendStore = createThreadStore(ordered);
	const liveBase = sendStore.postUserTurn({ source: "overview", body: "Live base." }).thread;
	assert.equal(sendStore.deliverPending(liveBase.id).error, "nothing-pending");
	sendStore.postUserTurn({ threadId: liveBase.id, body: "Tail one.", quiet: true });
	sendStore.postUserTurn({ threadId: liveBase.id, body: "Tail two.", quiet: true });
	const sendResult = sendStore.deliverPending(liveBase.id);
	assert.deepEqual(sendResult.deliveredTurns.map((turn) => turn.body), ["Tail one.", "Tail two."], "Send now delivers the whole pending backlog in order.");
	assert.equal(sendResult.thread.pending, 0);
	assert.equal(sendResult.prevLive, true);
	sendStore.requeue(liveBase.id, sendResult.deliveredTurns.map((turn) => turn.seq), sendResult.prevLive);
	assert.equal(sendStore.getThread(liveBase.id).pending, 2, "A failed send-now restores the pending tail.");
	assert.equal(sendStore.getThread(liveBase.id).queued, false, "A failed send-now keeps the thread live.");
	const tailSeq = sendStore.getThread(liveBase.id).turns.find((turn) => turn.delivered === false).seq;
	assert.equal(sendStore.amendQueuedTurn(liveBase.id, tailSeq, "Tail one, sharper.").thread.turns.find((turn) => turn.seq === tailSeq).body, "Tail one, sharper.", "Pending messages on live threads are amendable.");
	const deliveredSeq = sendStore.getThread(liveBase.id).turns.find((turn) => turn.author === "user" && turn.delivered === true).seq;
	assert.equal(sendStore.amendQueuedTurn(liveBase.id, deliveredSeq, "rewrite").error, "not-queued", "Delivered messages on the same thread stay immutable.");
	const liveReply = sendStore.postUserTurn({ threadId: liveBase.id, body: "And go." });
	assert.deepEqual(liveReply.deliveredTurns.map((turn) => turn.body), ["Tail one, sharper.", "Tail two.", "And go."], "A live reply delivers the pending backlog plus itself, in order.");
	assert.equal(liveReply.escalated, true);
	const escalationXml = formatThreadMessageXml(ordered, liveReply.thread, liveReply.deliveredTurns, 1);
	const escalationTurns = [...escalationXml.matchAll(/<message author="user" turn="(\d+)">/g)].map((match) => Number(match[1]));
	assert.equal(escalationTurns.length, 3, "Every escalated turn carries its own turn attribute.");
	assert.deepEqual([...escalationTurns].sort((left, right) => left - right), escalationTurns, "Escalated turns are serialized in seq order.");
	const liveBaseDelivered = liveReply.thread.turns.filter((turn) => turn.author === "user" && turn.delivered === true).length;
	assert.match(escalationXml, new RegExp(` delivered-user-turns="${liveBaseDelivered}"`), "The escalation counter equals Pi's tally after processing all its turns.");

	const seqStore = createThreadStore(ordered);
	const seqThread = seqStore.postUserTurn({ source: "overview", body: "one", quiet: true }).thread;
	seqStore.postUserTurn({ threadId: seqThread.id, body: "two", quiet: true });
	seqStore.postUserTurn({ threadId: seqThread.id, body: "three", quiet: true });
	seqStore.amendQueuedTurn(seqThread.id, 1);
	seqStore.amendQueuedTurn(seqThread.id, 2);
	seqStore.postUserTurn({ threadId: seqThread.id, body: "four" });
	const seqCarried = buildCarriedThreads([{ respondsTo: seqThread.id, resolution: "needs-discussion", body: "resp" }], seqStore.list(), ordered, 1);
	const seqNextStore = createThreadStore(ordered, THREAD_LIMITS, seqCarried);
	assert.deepEqual(seqNextStore.getThread(seqThread.id).turns.map((turn) => turn.seq), [3, 4, 5], "Carried turns keep their original seqs; deleted gaps are never compacted away.");
	assert.equal(seqNextStore.postUserTurn({ threadId: seqThread.id, body: "five" }).thread.turns.at(-1).seq, 6, "New turns never reuse a seq Pi may have tallied.");

	sendStore.postUserTurn({ threadId: liveBase.id, body: "After-answer tail.", quiet: true });
	sendStore.postPiReply(liveBase.id, "Answering the delivered part.", false);
	const piTailPass = formatReviewPassXml(ordered, sendStore.list(), sendStore.summary(), false, undefined, 1);
	assert.match(piTailPass, /<open-thread [^>]*pending="1"[^>]*last-author="pi">\n {4}<message author="user" pending="true" turn="\d+"><!\[CDATA\[After-answer tail\.\]\]><\/message>/, "A pending block records when Pi answered without seeing the tail.");
	assert.match(piTailPass, / awaiting-user="3" /, "A pi-answered pending thread counts as awaiting the reviewer, not as pending-awaiting.");

	const contextXml = formatThreadContextXml(ordered, sendStore.getThread(liveBase.id), 1);
	assert.match(contextXml, /^<review-thread snapshot="[a-f0-9]{64}" round="1" thread=/, "Thread context opens with the snapshot and round.");
	assert.match(contextXml, /<message author="user" turn="\d+" pending="true"><!\[CDATA\[After-answer tail\.\]\]>/, "Undelivered messages are marked pending in the fetched context.");
	assert.match(contextXml, /<message author="pi" turn="\d+"><!\[CDATA\[Answering the delivered part\.\]\]>/, "Pi turns appear in the fetched context.");
	const tailXml = formatThreadContextXml(ordered, sendStore.getThread(liveBase.id), 1, 2);
	assert.match(tailXml, / omitted-turns="4"/, "lastTurns reports how many older messages were cut.");
	assert.equal([...tailXml.matchAll(/<message /g)].length, 2, "lastTurns returns exactly the newest N messages.");
	assert.doesNotMatch(tailXml, /Live base\./, "Cut messages are absent from the tail fetch.");
	assert.doesNotMatch(formatThreadContextXml(ordered, sendStore.getThread(liveBase.id), 1, 999), / omitted-turns=/, "lastTurns beyond the history returns everything without an omitted marker.");
	const resolvedContextThread = sendStore.postUserTurn({ source: "overview", body: "Resolve then fetch." }).thread;
	sendStore.setResolved(resolvedContextThread.id, true);
	assert.match(formatThreadContextXml(ordered, sendStore.getThread(resolvedContextThread.id), 1), / status="resolved"/, "Fetched context reports resolved threads honestly.");

	const amendStore = createThreadStore(ordered);
	const amendThread = amendStore.postUserTurn({ source: "overview", body: "First quiet.", quiet: true }).thread;
	amendStore.postUserTurn({ threadId: amendThread.id, body: "Second quiet.", quiet: true });
	const [firstTurn, secondTurn] = amendStore.getThread(amendThread.id).turns;
	assert.notEqual(firstTurn.seq, secondTurn.seq, "Turns carry distinct sequence numbers.");
	assert.equal(amendStore.amendQueuedTurn(amendThread.id, firstTurn.seq, "Edited quiet.").thread.turns[0].body, "Edited quiet.");
	assert.equal(amendStore.amendQueuedTurn(amendThread.id, 99, "x").error, "unknown-turn");
	assert.equal(amendStore.amendQueuedTurn(amendThread.id, firstTurn.seq, "  ").error, "invalid");
	assert.equal(amendStore.amendQueuedTurn(amendThread.id, secondTurn.seq).thread.turns.length, 1, "Deleting one queued message keeps the rest.");
	const thirdTurn = amendStore.postUserTurn({ threadId: amendThread.id, body: "Third quiet.", quiet: true }).thread.turns.at(-1);
	assert.notEqual(thirdTurn.seq, secondTurn.seq, "Deleted sequence numbers are never reused.");
	amendStore.amendQueuedTurn(amendThread.id, firstTurn.seq);
	assert.deepEqual(amendStore.amendQueuedTurn(amendThread.id, thirdTurn.seq), { removed: true, threadId: amendThread.id });
	assert.equal(amendStore.getThread(amendThread.id), undefined, "Deleting the last queued message removes the thread.");
	const seedReply = amendStore.postUserTurn({ source: "commentary", file: "untracked.txt", commentaryId: "new-file", body: "Quiet note reply.", quiet: true }).thread;
	const revertedSeed = amendStore.amendQueuedTurn(seedReply.id, seedReply.turns.at(-1).seq).thread;
	assert.equal(revertedSeed.queued, false, "Deleting the only quiet reply reverts the note to a virgin seed.");
	assert.equal(revertedSeed.turns.length, 1);
	assert.equal(amendStore.amendQueuedTurn(seedReply.id, revertedSeed.turns[0].seq, "hack").error, "unknown-turn", "Pi's own note is not amendable.");
	const liveAmendThread = amendStore.postUserTurn({ source: "overview", body: "Live now." }).thread;
	assert.equal(amendStore.amendQueuedTurn(liveAmendThread.id, liveAmendThread.turns[0].seq, "rewrite").error, "not-queued", "Delivered messages are immutable.");
	const withdrawnAmend = amendStore.postUserTurn({ source: "overview", body: "Withdraw me.", quiet: true }).thread;
	amendStore.setResolved(withdrawnAmend.id, true);
	assert.equal(amendStore.amendQueuedTurn(withdrawnAmend.id, withdrawnAmend.turns[0].seq, "edit").error, "thread-resolved");
	const tinyStore = createThreadStore(ordered, { ...THREAD_LIMITS, maxThreads: 1 });
	const tinyThread = tinyStore.postUserTurn({ source: "overview", body: "One.", quiet: true }).thread;
	assert.equal(tinyStore.postUserTurn({ source: "overview", body: "Two." }).error, "too-many-threads");
	tinyStore.amendQueuedTurn(tinyThread.id, tinyThread.turns[0].seq);
	assert.equal(tinyStore.postUserTurn({ source: "overview", body: "Two." }).error, undefined, "Deleting a queued thread frees its slot.");

	const heldNext = { ...ordered, files: ordered.files.map((file) => (file.path === "untracked.txt" ? { ...file, lines: file.lines.filter((line) => line.newLine !== 2) } : file)) };
	const heldSource = createThreadStore(ordered);
	const keepAnchor = heldSource.postUserTurn({ source: "selection", file: "untracked.txt", side: "new", newStart: 1, newEnd: 1, highlight: "keep", body: "keep me", quiet: true }).thread;
	const loseAnchor = heldSource.postUserTurn({ source: "selection", file: "untracked.txt", side: "new", newStart: 2, newEnd: 2, highlight: "lose", body: "lose me", quiet: true }).thread;
	heldSource.postUserTurn({ source: "commentary", file: "untracked.txt", commentaryId: "new-file", body: "note quiet", quiet: true });
	assert.equal(threadsAwaitingResponse(heldSource.list()).length, 0, "Undelivered threads are never awaiting a response.");
	assert.throws(() => buildCarriedThreads([{ respondsTo: keepAnchor.id, resolution: "addressed", body: "x" }], heldSource.list(), ordered, 1), /does not match an open thread awaiting a response/, "Pi cannot respond to a thread it never received.");
	const heldRecords = buildHeldThreads(heldSource.list(), heldNext, 1);
	assert.equal(heldRecords.length, 3, "Every undelivered open thread is held over.");
	const heldKeep = heldRecords.find((record) => record.id === keepAnchor.id);
	assert.equal(heldKeep.newStart, 1, "A still-visible anchor survives the hold.");
	const heldLose = heldRecords.find((record) => record.id === loseAnchor.id);
	assert.equal(heldLose.newStart, undefined, "A vanished anchor is dropped.");
	assert.equal(heldLose.file, "untracked.txt", "The file association survives an anchor drop.");
	const heldNote = heldRecords.find((record) => record.source === "commentary");
	assert.equal(heldNote.commentaryId, undefined, "Held note threads never collide with the new round's commentary ids.");
	assert.equal(heldNote.turns.length, 2, "Pi's note travels with the held conversation.");
	assert.equal(heldNote.startLine, undefined, "The note's anchor is revalidated like any other.");
	const heldStore = createThreadStore(heldNext, THREAD_LIMITS, [], heldRecords);
	const heldImported = heldStore.getThread(keepAnchor.id);
	assert.equal(heldImported.queued, true, "Held threads arrive still queued.");
	assert.equal(heldImported.heldFrom, 1);
	assert.equal(threadsAwaitingResponse(heldStore.list()).length, 0, "Held threads stay outside the response contract until delivered.");
	const heldEscalation = heldStore.postUserTurn({ threadId: keepAnchor.id, body: "now live" });
	assert.deepEqual(heldEscalation.deliveredTurns.map((turn) => turn.body), ["keep me", "now live"], "Delivering a held thread carries its full backlog in order.");
	const heldEscalationXml = formatThreadMessageXml(heldNext, heldEscalation.thread, heldEscalation.deliveredTurns, 2);
	assert.match(heldEscalationXml, / held-from-round="1"/, "Delivered held threads disclose their origin round.");
	assert.match(heldEscalationXml, / new-start="1" new-end="1" anchor-from-round="1"/, "Held anchors never claim the current snapshot's authority.");
	const heldLoseXml = formatThreadMessageXml(heldNext, heldStore.getThread(loseAnchor.id), heldStore.getThread(loseAnchor.id).turns.filter((turn) => turn.author === "user"), 2);
	assert.doesNotMatch(heldLoseXml, /anchor-from-round=/, "An anchorless held thread emits no stale-coordinate marker.");
	assert.equal(threadsAwaitingResponse(heldStore.list()).length, 1, "Once delivered, a held thread joins the response contract.");

	const withdrawn = quietStore.postUserTurn({ source: "overview", body: "Withdrawn quiet.", quiet: true }).thread;
	quietStore.setResolved(withdrawn.id, true);
	assert.equal(quietStore.markAllDelivered().length, 0, "Resolved quiet threads are withdrawn, not delivered.");
	assert.equal(quietStore.setResolved(withdrawn.id, false).queued, true, "Reopening a withdrawn quiet thread restores its queued state.");

	const deliveredBatches = [];
	const messageQueue = createReviewMessageQueue((batch) => deliveredBatches.push(batch));
	assert.equal(messageQueue.post("a", true), false, "Idle posts deliver immediately.");
	assert.deepEqual(deliveredBatches, [["a"]]);
	assert.equal(messageQueue.post("b", false), true, "Busy posts queue.");
	assert.equal(messageQueue.post("c", true), true, "Posts queue behind pending messages to preserve order.");
	assert.equal(messageQueue.flush(false), 0, "Flushing while busy must wait.");
	assert.equal(messageQueue.flush(true), 2, "Settling delivers the queued batch at once.");
	assert.deepEqual(deliveredBatches[1], ["b", "c"]);
	assert.equal(messageQueue.size(), 0);
	let failDeliver = true;
	const flakyQueue = createReviewMessageQueue((batch) => {
		if (failDeliver) throw new Error("deliver boom");
		deliveredBatches.push(batch);
	});
	flakyQueue.post("x", false);
	assert.throws(() => flakyQueue.flush(true), /deliver boom/);
	assert.equal(flakyQueue.size(), 1, "A failed flush must keep the batch queued.");
	failDeliver = false;
	assert.equal(flakyQueue.flush(true), 1, "The kept batch delivers on the next settle.");
	{
		// Every invalid anchor is reported in ONE rejection, each with the
		// ranges that are visible — one corrected resubmission fixes them all.
		let aggregated;
		try {
			applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", commentary: [
				{ id: "bad-one", body: "x", side: "new", startLine: 900, endLine: 901 },
				{ id: "bad-two", body: "y", side: "new", startLine: 500, endLine: 500 },
			] }] });
		} catch (error) { aggregated = error.message; }
		assert.ok(aggregated.includes("bad-one") && aggregated.includes("bad-two"), "All invalid anchors surface in a single rejection.");
		assert.match(aggregated, /visible new lines: [\d, -]+/, "The rejection names the ranges that can be anchored.");
	}
	const html = renderReviewHtml(ordered, "safe-nonce");
	{
		// Appearance defaults from config ship as the html baseline; garbage
		// falls back to the built-ins; the pre-paint script still lets a
		// reviewer's stored picker choice win.
		const themed = renderReviewHtml(ordered, "safe-nonce", undefined, { carried: [], archive: [], appearance: { theme: "manuscript", scheme: "dark" } });
		assert.match(themed, /<html lang="en" data-theme="manuscript" data-scheme="dark">/, "Config appearance becomes the served baseline.");
		const garbage = renderReviewHtml(ordered, "safe-nonce", undefined, { carried: [], archive: [], appearance: { theme: "neon<script>", scheme: "blinding" } });
		assert.match(garbage, /<html lang="en" data-theme="slate" data-scheme="auto">/, "Invalid config values fall back to the built-in defaults.");
		assert.match(html, /<html lang="en" data-theme="slate" data-scheme="auto">/, "No config keeps the shipped defaults.");
	}
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "Manifest text must be escaped.");
	assert.match(html, /Review this first &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /data-review-overview/, "Agent-guided reviews should begin with an overview page.");
	assert.match(html, /data-overview-feedback/, "The overview should accept general change-set feedback.");
	assert.match(html, /data-finish/, "The topbar should expose the finish-pass action.");
	assert.match(html, /data-inbox/, "The topbar should expose the awaiting-you inbox strip.");
	assert.match(html, /data-selection-threads/, "Each file should host selection comment threads.");
	assert.match(html, /data-commentary-thread="new-file"/, "Each commentary card should host its live thread.");
	assert.match(html, /data-commentary-resolve="new-file"/, "Commentary cards should offer resolve without a reply.");
	assert.match(html, /<div class="reply-composer collapsed" data-commentary-composer="new-file"><button type="button" class="reply-affordance" data-composer-expand>Reply…<\/button>/, "Commentary composers render collapsed behind a Reply… affordance line.");
	assert.match(html, /new lines 1–2<span class="anchor-preview">new text<\/span>/, "Line-anchored commentary chips quote the first anchored line.");
	assert.doesNotMatch(html, /File note<span class="anchor-preview">/, "Anchorless notes carry no content preview.");
	assert.match(html, /data-shortcuts-overlay/, "The shortcuts guide overlay should be rendered.");
	assert.match(html, /<details class="reference-files"><summary>Reference files \(3\)/, "Reference files should be grouped in a collapsed sidebar section.");
	assert.match(html, /data-reference-unread/, "The reference group summary should carry an awaiting-you badge.");
	assert.match(html, /data-path="unstaged\.txt" data-review-mode="reference"/, "Reference classification should remain visible on the rendered file.");
	assert.match(html, /script nonce="safe-nonce"/);
	const plainReview = applyReviewManifest(snapshot, { files: [] });
	const plainHtml = renderReviewHtml(plainReview, "plain-nonce");
	const firstPlainReviewIndex = plainReview.files.findIndex((file) => file.reviewMode === "review");
	assert.doesNotMatch(plainHtml, /<section class="review-overview|<button[^>]+data-overview-nav/, "The commentary-free slash command should continue to open directly on the diff.");
	assert.match(plainHtml, new RegExp(`class="review-file active"[^>]*data-review-file="${firstPlainReviewIndex}"`), "A review without an overview should show its first primary review file initially.");
	assert.match(plainHtml, /<details class="reference-files"><summary>Reference files \(2\)/, "Commentary-free reviews should group binary files as references automatically.");

	const posts = [];
	const passes = [];
	let failNextPost = false;
	const server = await createCodeReviewServer(ordered, {
		onThreadPost: async (round, thread, turns) => {
			if (failNextPost) {
				failNextPost = false;
				throw new Error("delivery boom");
			}
			posts.push({ round: round.number, thread, turns });
		},
		onFinishPass: async (round, note, threadList, summary) => { passes.push({ round: round.number, note, threadList, summary }); return { stale: false }; },
	});
	try {
		const origin = new URL(server.url).origin;
		assert.equal((await fetch(origin)).status, 403, "Unauthenticated review requests should be rejected.");
		assert.equal((await fetch(`${origin}/__pi_code_review_events__`)).status, 403, "Unauthenticated event streams must be rejected.");
		const bootstrap = await fetch(server.url, { redirect: "manual" });
		assert.equal(bootstrap.status, 302);
		assert.equal(bootstrap.headers.get("location"), "/", "Bootstrap should remove the token from the address bar.");
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		assert.match(bootstrap.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
		assert.equal((await fetch(server.url, { redirect: "manual" })).status, 403, "The bootstrap token must be single-use.");
		assert.equal((await fetch(server.url, { redirect: "manual", headers: { cookie } })).status, 302, "Authenticated visits may still strip the token from the URL.");
		const pageResponse = await fetch(origin, { headers: { cookie } });
		const pageBody = await pageResponse.text();
		assert.equal(pageResponse.status, 200);
		assert.match(pageResponse.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
		assert.ok(!pageBody.includes(new URL(server.url).searchParams.get("token")), "Bootstrap token must not be embedded in served HTML.");
		const postEndpoint = `${origin}/__pi_code_review_post__`;
		const validPost = { source: "selection", file: "untracked.txt", side: "new", newStart: 1, newEnd: 2, highlight: "A marker", body: "Explain this line." };
		assert.equal((await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://example.com" }, body: JSON.stringify(validPost) })).status, 403, "Cross-origin thread posts must be rejected.");
		assert.equal((await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "text/plain", origin }, body: "{}" })).status, 415);
		assert.equal((await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ padding: "x".repeat(256 * 1024), ...validPost }) })).status, 413, "Thread post bodies must be bounded.");
		assert.equal((await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: "forged", body: "x" }) })).status, 404, "Forged thread ids must be rejected.");
		assert.equal((await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ ...validPost, newStart: 999, newEnd: 999 }) })).status, 400, "Forged anchors must be rejected.");
		const acceptedResponse = await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify(validPost) });
		assert.equal(acceptedResponse.status, 200);
		const accepted = await acceptedResponse.json();
		assert.equal(posts.length, 1, "Each reviewer post must be delivered to Pi exactly once.");
		assert.equal(posts[0].thread.id, accepted.thread.id);
		assert.equal(posts[0].turns[0].body, "Explain this line.");

		const eventsResponse = await fetch(`${origin}/__pi_code_review_events__`, { headers: { cookie } });
		assert.equal(eventsResponse.status, 200);
		assert.match(eventsResponse.headers.get("content-type") ?? "", /text\/event-stream/);
		const reader = eventsResponse.body.getReader();
		const decoder = new TextDecoder();
		let sseBuffer = "";
		const readUntil = async (marker) => {
			const deadline = Date.now() + 5_000;
			while (!sseBuffer.includes(marker)) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE marker: ${marker}`);
				const { value, done } = await reader.read();
				if (done) throw new Error("SSE stream ended early.");
				sseBuffer += decoder.decode(value, { stream: true });
			}
		};
		await readUntil("event: init");
		assert.ok(sseBuffer.includes(accepted.thread.id), "The SSE init event must carry existing threads.");
		const piThread = server.postPiReply(accepted.thread.id, "Renaming in the next pass.", true);
		assert.equal(piThread.piProposedResolve, true);
		assert.equal(server.postPiReply("missing", "x", false), undefined, "Pi replies to unknown threads must be rejected.");
		await readUntil('"author":"pi"');
		await reader.cancel();

		const resolveEndpoint = `${origin}/__pi_code_review_resolve__`;
		assert.equal((await fetch(resolveEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: "forged", resolved: true }) })).status, 404);
		assert.equal((await fetch(resolveEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: accepted.thread.id, resolved: "yes" }) })).status, 400, "Resolution must be an explicit boolean.");
		const resolveResponse = await fetch(resolveEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: accepted.thread.id, resolved: true }) });
		assert.equal(resolveResponse.status, 200);
		assert.equal((await resolveResponse.json()).thread.status, "resolved");
		const reopenResponse = await fetch(resolveEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: accepted.thread.id, resolved: false }) });
		assert.equal((await reopenResponse.json()).thread.status, "open", "Reviewers can reopen resolved threads.");
		assert.equal((await (await fetch(resolveEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: accepted.thread.id, resolved: true }) })).json()).thread.status, "resolved");
		assert.equal((await fetch(resolveEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ file: "untracked.txt", commentaryId: "second-note", resolved: true }) })).status, 400, "Resolution requires an explicit thread id.");
		const noteThreadIdHttp = server.threads().find((thread) => thread.commentaryId === "second-note").id;
		const noteResolve = await fetch(resolveEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: noteThreadIdHttp, resolved: true }) });
		assert.equal(noteResolve.status, 200);
		assert.equal((await noteResolve.json()).thread.status, "resolved", "Seeded notes resolve over HTTP without a reply.");

		failNextPost = true;
		const failedDelivery = await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ source: "commentary", file: "untracked.txt", commentaryId: "new-file", body: "Ping" }) });
		assert.equal(failedDelivery.status, 200, "Failed Pi delivery must not look like a rejected post.");
		const failedDeliveryJson = await failedDelivery.json();
		assert.equal(failedDeliveryJson.deliveryFailed, true, "Failed Pi delivery must be reported explicitly.");
		assert.equal(server.getThread(failedDeliveryJson.thread.id).turns.length, 2, "The turn must remain stored when delivery fails.");
		assert.equal(posts.length, 1, "Failed delivery must not record a Pi message.");

		const quietOv = await (await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ source: "overview", body: "Quiet start.", quiet: true }) })).json();
		assert.equal(quietOv.queued, true);
		failNextPost = true;
		const failedEscalation = await (await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: quietOv.thread.id, body: "Escalate now." }) })).json();
		assert.equal(failedEscalation.deliveryFailed, true);
		assert.equal(failedEscalation.escalated, undefined, "A failed escalation must not report success.");
		assert.equal(failedEscalation.thread.queued, true, "A failed escalation requeues the backlog.");
		assert.equal(server.getThread(quietOv.thread.id).queued, true);

		const amendEndpoint = `${origin}/__pi_code_review_amend__`;
		const quietTurns = server.getThread(quietOv.thread.id).turns;
		assert.equal((await fetch(amendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: quietOv.thread.id, seq: "1", body: "x" }) })).status, 400, "Amend seq must be an integer.");
		assert.equal((await fetch(amendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: quietOv.thread.id, seq: quietTurns[0].seq, delete: true, body: "x" }) })).status, 400, "Delete cannot carry a body.");
		const editedQuiet = await (await fetch(amendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: quietOv.thread.id, seq: quietTurns[0].seq, body: "Rewritten quiet start." }) })).json();
		assert.equal(editedQuiet.thread.turns[0].body, "Rewritten quiet start.");
		const liveUserSeq = server.getThread(accepted.thread.id).turns.find((turn) => turn.author === "user").seq;
		assert.equal((await fetch(amendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: accepted.thread.id, seq: liveUserSeq, body: "rewrite history" }) })).status, 409, "Delivered messages are immutable over HTTP.");
		const disposable = await (await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ source: "overview", body: "Disposable.", quiet: true }) })).json();
		const removalEvents = await fetch(`${origin}/__pi_code_review_events__`, { headers: { cookie } });
		const removalReader = removalEvents.body.getReader();
		const removalDecoder = new TextDecoder();
		let removalBuffer = "";
		const readRemoval = async (marker) => {
			const deadline = Date.now() + 5_000;
			while (!removalBuffer.includes(marker)) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE marker: ${marker}`);
				const { value, done } = await removalReader.read();
				if (done) throw new Error("SSE stream ended early.");
				removalBuffer += removalDecoder.decode(value, { stream: true });
			}
		};
		const removedResp = await (await fetch(amendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: disposable.thread.id, seq: disposable.thread.turns[0].seq, delete: true }) })).json();
		assert.equal(removedResp.removed, true);
		assert.equal(server.getThread(disposable.thread.id), undefined, "Deleting the last queued message removes the thread server-side.");
		await readRemoval("event: thread-removed");
		assert.ok(removalBuffer.includes(disposable.thread.id), "Removals must broadcast the thread id to connected tabs.");
		await removalReader.cancel();

		const sendEndpoint = `${origin}/__pi_code_review_send__`;
		const liveOv = await (await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ source: "overview", body: "Live topic." }) })).json();
		const postsBeforeTail = posts.length;
		const tailPost = await (await fetch(postEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: liveOv.thread.id, body: "Pending tail.", quiet: true }) })).json();
		assert.equal(tailPost.pending, true, "A quiet reply on a live thread reports pending, not queued.");
		assert.equal(tailPost.thread.pending, 1);
		assert.equal(posts.length, postsBeforeTail, "Pending replies must not deliver.");
		failNextPost = true;
		const failedSend = await (await fetch(sendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: liveOv.thread.id }) })).json();
		assert.equal(failedSend.deliveryFailed, true);
		assert.equal(failedSend.thread.pending, 1, "A failed send-now restores the pending tail.");
		assert.equal(failedSend.thread.queued, false, "A failed send-now keeps the thread live.");
		const okSend = await (await fetch(sendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: liveOv.thread.id }) })).json();
		assert.equal(okSend.sent, 1);
		assert.equal(okSend.thread.pending, 0);
		assert.equal(posts.at(-1).turns.length, 1);
		assert.equal(posts.at(-1).turns[0].body, "Pending tail.", "Send now delivers the pending message itself.");
		assert.equal((await fetch(sendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: liveOv.thread.id }) })).status, 409, "Send now with nothing pending is rejected.");

		const viewedEndpoint = `${origin}/__pi_code_review_viewed__`;
		assert.equal((await fetch(viewedEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ file: "untracked.txt", viewed: "yes" }) })).status, 400, "Viewed must be an explicit boolean.");
		assert.equal((await fetch(viewedEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ file: "missing.txt", viewed: true }) })).status, 404, "Viewed only tracks files in the snapshot.");
		assert.equal((await fetch(viewedEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ round: 9, file: "untracked.txt", viewed: true }) })).status, 409, "Viewed rejects stale round pages.");
		const viewedResponse = await (await fetch(viewedEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ round: 1, file: "untracked.txt", viewed: true }) })).json();
		assert.deepEqual(viewedResponse.viewedFiles, ["untracked.txt"]);
		assert.deepEqual(server.viewedFiles(), ["untracked.txt"]);

		const finishEndpoint = `${origin}/__pi_code_review_finish__`;
		assert.equal((await fetch(finishEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://example.com" }, body: "{}" })).status, 403);
		assert.equal((await fetch(finishEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ note: "" }) })).status, 400, "Blank finish notes must be rejected.");
		const finishResponse = await fetch(finishEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ note: "Done for now." }) });
		assert.equal(finishResponse.status, 200);
		assert.deepEqual(await finishResponse.json(), { stale: false });
		assert.equal(passes.length, 1);
		assert.equal(passes[0].note, "Done for now.");
		assert.equal(passes[0].round, 1, "The pass must report which round it closes.");
		assert.equal(posts[0].round, 1, "Thread posts must report their round.");
		assert.deepEqual(passes[0].summary, { open: 3, awaitingUser: 0, awaitingPi: 3, resolved: 2 });
		assert.equal(server.getThread(quietOv.thread.id).queued, false, "The pass delivers the requeued backlog in full.");
		const passQuiet = passes[0].threadList.find((thread) => thread.id === quietOv.thread.id);
		assert.equal(passQuiet.turns[0].body, "Rewritten quiet start.", "The pass delivers the edited text, not the original.");
		assert.equal((await fetch(amendEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ threadId: quietOv.thread.id, seq: quietTurns[1].seq, body: "too late" }) })).status, 409, "Round delivery freezes queued messages.");
		assert.equal((await fetch(viewedEndpoint, { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify({ round: 1, file: "unstaged.txt", viewed: true }) })).status, 200, "Viewed bookkeeping stays available while Pi revises.");
	} finally {
		await server.close();
	}

	let releaseConcurrentFinish;
	let concurrentFinishCalls = 0;
	let markConcurrentFinishEntered;
	const concurrentFinishEntered = new Promise((resolvePromise) => { markConcurrentFinishEntered = resolvePromise; });
	const concurrentServer = await createCodeReviewServer(ordered, {
		onThreadPost: async () => {},
		onFinishPass: async () => {
			concurrentFinishCalls++;
			markConcurrentFinishEntered();
			await new Promise((resolvePromise) => { releaseConcurrentFinish = resolvePromise; });
			return { stale: false };
		},
	});
	try {
		const origin = new URL(concurrentServer.url).origin;
		const bootstrap = await fetch(concurrentServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const request = { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: "{}" };
		const jsonRequest = (payload) => ({ method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify(payload) });
		const preQuiet = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ source: "overview", body: "Pre-finish quiet.", quiet: true }))).json();
		const seedReply = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ source: "commentary", file: "untracked.txt", commentaryId: "new-file", body: "Quiet on the note.", quiet: true }))).json();
		const firstFinish = fetch(`${origin}/__pi_code_review_finish__`, request);
		await concurrentFinishEntered;
		const secondFinish = await fetch(`${origin}/__pi_code_review_finish__`, request);
		assert.equal(secondFinish.status, 409, "A concurrent finish must be rejected while the first handoff is pending.");
		assert.equal((await fetch(`${origin}/__pi_code_review_amend__`, jsonRequest({ threadId: preQuiet.thread.id, seq: preQuiet.thread.turns[0].seq, body: "sneaky edit" }))).status, 409, "Amends are serialized against an in-flight finish pass.");
		assert.equal((await fetch(`${origin}/__pi_code_review_send__`, jsonRequest({ threadId: preQuiet.thread.id }))).status, 409, "Send now is serialized against an in-flight finish pass.");
		assert.equal((await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ threadId: preQuiet.thread.id, body: "Escalate mid-finish." }))).status, 409, "A live reply that would re-deliver a captured backlog waits for the handoff.");
		assert.equal((await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ source: "commentary", file: "untracked.txt", commentaryId: "new-file", body: "Live on the note." }))).status, 409, "The commentary path cannot bypass the finishing guard.");
		assert.equal((await fetch(`${origin}/__pi_code_review_resolve__`, jsonRequest({ threadId: preQuiet.thread.id, resolved: true }))).status, 409, "Resolution waits for the handoff to keep capture and stamping in sync.");
		const midTail = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ threadId: preQuiet.thread.id, body: "Mid-finish tail.", quiet: true }))).json();
		assert.equal(midTail.thread.pending, 2, "Quiet replies to captured threads stay possible while the handoff awaits.");
		const midQuiet = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ source: "overview", body: "Mid-finish quiet.", quiet: true }))).json();
		assert.equal(midQuiet.queued, true, "Quiet posts stay possible while the handoff awaits.");
		releaseConcurrentFinish();
		assert.equal((await firstFinish).status, 200);
		assert.equal(concurrentFinishCalls, 1, "Concurrent finish requests must invoke the handoff exactly once.");
		const preAfter = concurrentServer.getThread(preQuiet.thread.id);
		assert.equal(preAfter.queued, false, "Queued threads captured by the pass are delivered.");
		assert.equal(preAfter.pending, 1, "A quiet reply posted during the handoff was not in the pass and must stay pending, not be stamped delivered.");
		assert.equal(preAfter.turns.find((turn) => turn.body === "Mid-finish tail.").delivered, false);
		assert.equal(concurrentServer.getThread(midQuiet.thread.id).queued, true, "A quiet thread created during the handoff was not in the pass and must stay queued.");
		assert.equal(concurrentServer.getThread(seedReply.thread.id).pending, 0, "Captured note replies are delivered by the pass.");
	} finally {
		releaseConcurrentFinish?.();
		await concurrentServer.close();
	}

	let failFinish = true;
	const flakyServer = await createCodeReviewServer(ordered, {
		onThreadPost: async () => {},
		onFinishPass: async () => {
			if (failFinish) {
				failFinish = false;
				throw new Error("finish boom");
			}
			return { stale: false };
		},
	});
	try {
		const origin = new URL(flakyServer.url).origin;
		const bootstrap = await fetch(flakyServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const request = { method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: "{}" };
		assert.equal((await fetch(`${origin}/__pi_code_review_finish__`, request)).status, 500, "A failed handoff must surface an error.");
		assert.equal((await fetch(`${origin}/__pi_code_review_finish__`, request)).status, 200, "A failed handoff must not lock future finishes.");
	} finally {
		await flakyServer.close();
	}

	// Reply-state lifecycle: the per-thread status line tracking what Pi is
	// doing with the thread's latest delivered reviewer message.
	let replyStateQueued = false;
	let replyStateFail = false;
	let replyStateTurnActive = true;
	const replyStateServer = await createCodeReviewServer(ordered, {
		isTurnActive: () => replyStateTurnActive,
		onThreadPost: async () => {
			if (replyStateFail) {
				replyStateFail = false;
				throw new Error("delivery boom");
			}
			return { queued: replyStateQueued };
		},
		onFinishPass: async () => ({ stale: false, queued: true }),
	});
	try {
		const origin = new URL(replyStateServer.url).origin;
		const bootstrap = await fetch(replyStateServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const jsonRequest = (payload) => ({ method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: JSON.stringify(payload) });
		const immediate = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ source: "overview", body: "Immediate live post." }))).json();
		assert.equal(immediate.thread.replyState, "working", "An immediately delivered live post reports Pi working on it.");
		assert.equal(replyStateServer.postPiReply(immediate.thread.id, "Answered.", false).replyState, undefined, "Pi's reply clears the reply state \u2014 the reply itself is the indicator.");
		replyStateQueued = true;
		const queuedLive = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ source: "overview", body: "Busy live post." }))).json();
		assert.equal(queuedLive.thread.replyState, "sent", "A live post queued behind a busy Pi reports sent.");
		const quietDraft = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ source: "overview", body: "Quiet draft.", quiet: true }))).json();
		assert.equal(quietDraft.thread.replyState, undefined, "Quiet drafts show no reply state until delivered.");
		replyStateServer.markQueueDelivered();
		assert.equal(replyStateServer.getThread(queuedLive.thread.id).replyState, "working", "The settle flush moves sent threads to working.");
		assert.equal(replyStateServer.getThread(quietDraft.thread.id).replyState, undefined, "The settle flush must not invent state for undelivered drafts.");
		replyStateServer.markTurnEnd();
		assert.equal(replyStateServer.getThread(queuedLive.thread.id).replyState, "seen", "A turn that ends without a reply marks the thread seen.");
		assert.equal(replyStateServer.getThread(immediate.thread.id).replyState, undefined, "A replied thread never regresses to seen.");
		replyStateQueued = false;
		const reRaised = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ threadId: queuedLive.thread.id, body: "Follow-up." }))).json();
		assert.equal(reRaised.thread.replyState, "working", "A new live message restarts the reply-state cycle.");
		replyStateFail = true;
		const failedDelivery = await (await fetch(`${origin}/__pi_code_review_post__`, jsonRequest({ threadId: queuedLive.thread.id, body: "Doomed follow-up." }))).json();
		assert.equal(failedDelivery.deliveryFailed, true);
		assert.equal(failedDelivery.thread.replyState, undefined, "A failed delivery clears the reply state \u2014 requeued messages track no delivery.");
		const sendNow = await (await fetch(`${origin}/__pi_code_review_send__`, jsonRequest({ threadId: queuedLive.thread.id }))).json();
		assert.equal(sendNow.thread.replyState, "working", "Send now delivers the backlog and reports Pi working.");
		// Restart honesty: an SSE (re)connect with no turn in progress repairs a
		// stranded working state to seen, and the repair persists.
		replyStateTurnActive = false;
		const initEvents = await fetch(`${origin}/__pi_code_review_events__`, { headers: { cookie } });
		const initReader = initEvents.body.getReader();
		const initDecoder = new TextDecoder();
		let initBuffer = "";
		const initDeadline = Date.now() + 5_000;
		while (!initBuffer.includes("event: init") || !initBuffer.includes('"replyState":"seen"')) {
			if (Date.now() > initDeadline) throw new Error("Timed out waiting for the repaired init frame.");
			const { value, done } = await initReader.read();
			if (done) throw new Error("SSE stream ended early.");
			initBuffer += initDecoder.decode(value, { stream: true });
		}
		await initReader.cancel();
		replyStateTurnActive = true;
		assert.equal(replyStateServer.getThread(queuedLive.thread.id).replyState, "seen", "The reconnect repair persists; a later unrelated turn cannot flip seen back to working.");
		assert.equal((await fetch(`${origin}/__pi_code_review_finish__`, jsonRequest({}))).status, 200);
		assert.equal(replyStateServer.getThread(quietDraft.thread.id).replyState, "sent", "A queued finish pass hands its delivered threads to Pi as sent.");
		assert.equal(replyStateServer.getThread(queuedLive.thread.id).replyState, "seen", "The pass delivers nothing new for already-delivered unanswered threads; they stay seen.");
		replyStateServer.markQueueDelivered();
		assert.equal(replyStateServer.getThread(quietDraft.thread.id).replyState, "working", "The flushed pass moves its threads to working.");
	} finally {
		await replyStateServer.close();
	}

	const altId = (id, index) => `${id.slice(0, index)}${id[index] === "0" ? "1" : "0"}${id.slice(index + 1)}`;
	const roundsDeliveries = [];
	const roundsServer = await createCodeReviewServer(ordered, {
		onThreadPost: async (round, thread, turns) => { roundsDeliveries.push(turns.length); },
		onFinishPass: async () => ({ stale: false }),
	});
	try {
		const origin = new URL(roundsServer.url).origin;
		const bootstrap = await fetch(roundsServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const headers = { cookie, "content-type": "application/json", origin };
		const postEndpoint = `${origin}/__pi_code_review_post__`;
		const resolveEndpoint = `${origin}/__pi_code_review_resolve__`;
		const finishEndpoint = `${origin}/__pi_code_review_finish__`;
		const resumeEndpoint = `${origin}/__pi_code_review_resume__`;
		const eventsResponse = await fetch(`${origin}/__pi_code_review_events__?round=1`, { headers: { cookie } });
		const reader = eventsResponse.body.getReader();
		const decoder = new TextDecoder();
		let sseBuffer = "";
		const readUntil = async (marker) => {
			const deadline = Date.now() + 5_000;
			while (!sseBuffer.includes(marker)) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE marker: ${marker}`);
				const { value, done } = await reader.read();
				if (done) throw new Error("SSE stream ended early.");
				sseBuffer += decoder.decode(value, { stream: true });
			}
		};
		await readUntil("event: init");
		assert.match(sseBuffer, /"currentRound":1/, "The init event must carry the session round state.");

		assert.match(await (await fetch(origin, { headers: { cookie } })).text(), /<body data-round="1" data-current-round="1" data-phase="reviewing"/, "The root page serves the current round.");
		assert.equal((await fetch(`${origin}/round/9`, { headers: { cookie } })).status, 404, "Unknown round pages must be rejected.");
		assert.equal((await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 2, source: "overview", body: "x" }) })).status, 409, "Creations tagged with a non-current round must be rejected.");
		const roundsPost = await (await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 1, source: "overview", body: "First round topic." }) })).json();

		assert.equal((await fetch(resumeEndpoint, { method: "POST", headers: { ...headers, origin: "https://example.com" }, body: "{}" })).status, 403, "Cross-origin resume requests must be rejected.");
		assert.equal((await fetch(resumeEndpoint, { method: "POST", headers, body: "{}" })).status, 409, "Resume outside the revising phase must be rejected.");
		assert.equal((await fetch(finishEndpoint, { method: "POST", headers, body: "{}" })).status, 200);
		await readUntil('"phase":"revising"');
		const lockedPost = await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 1, source: "overview", body: "late" }) });
		assert.equal(lockedPost.status, 409, "Posting is locked while Pi revises.");
		assert.match(await lockedPost.text(), /Resume reviewing this round/, "The lock message must teach the way back.");
		assert.equal((await fetch(resolveEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: roundsPost.thread.id, resolved: true }) })).status, 409, "Resolution is locked while Pi revises.");
		assert.equal((await fetch(resumeEndpoint, { method: "POST", headers, body: "{}" })).status, 200);
		await readUntil('"phase":"reviewing"');
		assert.equal((await fetch(resolveEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: roundsPost.thread.id, resolved: true }) })).status, 200, "Resume unlocks the round for mutations.");

		const secondRoundReview = { ...ordered, id: altId(ordered.id, 63) };
		assert.equal(roundsServer.addRound(secondRoundReview, "0".repeat(64)).error, "unknown-round", "Chaining from an unknown round must be rejected.");
		assert.deepEqual(roundsServer.addRound({ ...ordered }, ordered.id), { identical: true, round: 1 }, "An unchanged snapshot must not open a hollow round.");
		const roundsViewedEndpoint = `${origin}/__pi_code_review_viewed__`;
		assert.equal((await fetch(roundsViewedEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 1, file: "untracked.txt", viewed: true }) })).status, 200);
		assert.equal((await fetch(roundsViewedEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 1, file: "binary.dat", viewed: true }) })).status, 200);
		const binaryChangedFiles = secondRoundReview.files.map((file) => (file.path === "binary.dat" ? { ...file, contentSha256: "0".repeat(64) } : file));
		assert.equal(roundsServer.addRound({ ...secondRoundReview, files: binaryChangedFiles }, ordered.id).round, 2);
		assert.deepEqual(roundsServer.viewedFiles(), ["untracked.txt"], "Byte-identical diffs keep their checkmark; changed binary content (identical rendering) drops it; unviewed files stay unviewed.");
		assert.equal((await fetch(roundsViewedEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 1, file: "untracked.txt", viewed: false }) })).status, 409, "Superseded round pages cannot mutate the checklist.");
		await readUntil("event: round-ready");
		assert.match(sseBuffer, /"previousRound":1/, "round-ready must name the superseded round for auto-navigation.");
		assert.match(await (await fetch(origin, { headers: { cookie } })).text(), /<body data-round="2" data-current-round="2"/, "The root page advances to the new round.");
		assert.match(await (await fetch(`${origin}/round/1`, { headers: { cookie } })).text(), /<body data-round="1" data-current-round="2"/, "Prior rounds stay reachable read-only.");
		assert.equal(roundsServer.addRound(secondRoundReview, ordered.id).error, "superseded", "Chaining from a superseded round must be rejected.");
		assert.deepEqual(roundsServer.locateThread(roundsPost.thread.id), { round: 1, current: false });
		assert.equal(roundsServer.postPiReply(roundsPost.thread.id, "late", false), undefined, "Pi replies must not land in superseded rounds.");
		assert.equal((await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: roundsPost.thread.id, body: "stale reply" }) })).status, 409, "Replies into superseded rounds are rejected.");
		assert.equal((await fetch(resolveEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: roundsPost.thread.id, resolved: false }) })).status, 409, "Resolution into superseded rounds is rejected.");
		assert.equal((await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 2, source: "overview", body: "Round two topic." }) })).status, 200, "The new round accepts posts.");
		assert.equal(roundsServer.addRound({ ...secondRoundReview, id: "f".repeat(64), root: "/elsewhere" }, secondRoundReview.id).error, "wrong-root", "Rounds from another repository must be rejected.");
		assert.equal((await fetch(finishEndpoint, { method: "POST", headers, body: "{}" })).status, 200);
		assert.deepEqual(roundsServer.addRound({ ...secondRoundReview }, secondRoundReview.id), { identical: true, round: 2 });
		assert.equal(roundsServer.addRound({ ...secondRoundReview }, secondRoundReview.id, [{ respondsTo: "not-a-thread", resolution: "addressed", body: "x" }]).identical, true, "Identical reopens skip the response contract even with open threads; conversations continue in place.");
		assert.equal((await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 2, source: "overview", body: "unlocked again" }) })).status, 200, "An identical reopen resumes the current round.");
		assert.equal(roundsServer.addRound({ ...ordered, id: altId(ordered.id, 61) }, secondRoundReview.id).error, "invalid-responses", "Open threads demand responses before the next round opens.");
		const eligibleIds = roundsServer.threads().filter((thread) => thread.status === "open" && thread.turns.some((turn) => turn.author === "user" && turn.delivered === true)).map((thread) => thread.id);
		assert.equal(eligibleIds.length, 2);
		assert.equal((await fetch(roundsViewedEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 2, file: "unstaged.txt", viewed: true }) })).status, 200);
		assert.equal((await (await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: eligibleIds[0], body: "Carried pending tail.", quiet: true }) })).json()).thread.pending, 1, "A live thread can hold a pending tail when the round advances.");
		const heldOverview = await (await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 2, source: "overview", body: "Held over.", quiet: true }) })).json();
		const thirdRoundReview = { ...ordered, id: altId(ordered.id, 61), files: ordered.files.map((file) => (file.path === "unstaged.txt" ? { ...file, lines: file.lines.slice(0, -1) } : file)) };
		const carriedAdd = roundsServer.addRound(thirdRoundReview, secondRoundReview.id, eligibleIds.map((id, index) => ({ respondsTo: id, resolution: index === 0 ? "addressed" : "declined", body: `Response ${index}.`, ...(index === 0 ? { file: "untracked.txt", side: "new", startLine: 1 } : {}) })));
		assert.equal(carriedAdd.round, 3, "Complete responses open the next round with carried threads.");
		const carriedThread = roundsServer.getThread(eligibleIds[0]);
		assert.equal(carriedThread.carried.fromRound, 2);
		assert.equal(carriedThread.carried.placement, "anchored");
		assert.equal(carriedThread.piProposedResolve, true);
		assert.deepEqual(roundsServer.locateThread(eligibleIds[0]), { round: 3, current: true }, "Carried ids resolve to the living copy in the newest round.");
		const carriedWithTail = roundsServer.getThread(eligibleIds[0]);
		assert.equal(carriedWithTail.pending, 1, "Carried threads keep their pending tail instead of stamping it delivered.");
		assert.equal(carriedWithTail.turns.find((turn) => turn.body === "Carried pending tail.").delivered, false);
		const deliveredCount = (thread) => thread.turns.filter((turn) => turn.author === "user" && turn.delivered === true).length;
		const deliveredAtCarry = deliveredCount(carriedWithTail);
		assert.match(formatThreadMessageXml(thirdRoundReview, carriedWithTail, carriedWithTail.turns[carriedWithTail.turns.length - 1]), new RegExp(` delivered-user-turns="${deliveredAtCarry}" side="new" start-line="1" end-line="1">`), "Carried messages carry Pi's re-declared anchor and the lifetime delivered counter.");
		assert.ok(roundsServer.postPiReply(eligibleIds[0], "Follow-up.", false), "Pi replies to carried threads in the current round.");
		const carriedReply = await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: eligibleIds[0], body: "Reviewer follow-up." }) });
		assert.equal(carriedReply.status, 200, "Reviewer replies land in the carried copy, not the archived one.");
		assert.equal(roundsDeliveries[roundsDeliveries.length - 1], 2, "The live follow-up delivers the carried pending tail with it, in order.");
		assert.equal(roundsServer.getThread(eligibleIds[0]).pending, 0, "The live follow-up leaves nothing pending.");
		assert.equal(deliveredCount(roundsServer.getThread(eligibleIds[0])), deliveredAtCarry + 2, "The delivered counter is a lifetime count that survives round carry and grows monotonically.");
		assert.equal((await fetch(`${origin}/__pi_code_review_send__`, { method: "POST", headers, body: JSON.stringify({ threadId: roundsPost.thread.id }) })).status, 409, "Send now into superseded rounds is rejected.");
		const supersededContext = roundsServer.threadContext(roundsPost.thread.id);
		assert.equal(supersededContext.current, false, "Thread context reports superseded rounds honestly.");
		assert.equal(supersededContext.round, 1);
		assert.equal(supersededContext.review.id, ordered.id, "Thread context returns the owning round's snapshot, not the newest.");
		assert.equal(roundsServer.threadContext("missing"), undefined);
		assert.equal(roundsServer.threadContext(eligibleIds[0]).current, true, "Carried ids resolve to the living copy.");
		const heldInRound3 = roundsServer.getThread(heldOverview.thread.id);
		assert.equal(heldInRound3.queued, true, "A never-delivered thread crosses the round still queued.");
		assert.equal(heldInRound3.heldFrom, 2, "Held threads disclose the round they were written in.");
		assert.equal(roundsServer.threadContext(heldOverview.thread.id).current, true, "The held copy is the living one.");
		const carriedContextXml = formatThreadContextXml(thirdRoundReview, roundsServer.getThread(eligibleIds[0]), 3);
		assert.match(carriedContextXml, / carried-from-round="2" resolution="addressed"[^>]* side="new" start-line="1" end-line="1"/, "Fetched carried context carries Pi's re-declared anchor and provenance.");
		const outdatedContextXml = formatThreadContextXml(thirdRoundReview, roundsServer.getThread(eligibleIds[1]), 3);
		assert.match(outdatedContextXml, / carried-from-round="2" resolution="declined"/, "Outdated carried context keeps its provenance.");
		assert.doesNotMatch(outdatedContextXml, / side=| start-line=| old-start=| new-start=/, "An anchorless carried thread emits no stale anchor.");
		assert.match(await (await fetch(`${origin}/round/3`, { headers: { cookie } })).text(), /Resolved in earlier rounds/, "Round pages surface the prior-round archive.");
		assert.deepEqual(roundsServer.viewedFiles(), ["untracked.txt"], "A changed diff drops its checkmark while identical files keep theirs.");

		const deliveriesBefore = roundsDeliveries.length;
		const quietPost = await (await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 3, source: "overview", body: "Quiet topic.", quiet: true }) })).json();
		assert.equal(quietPost.queued, true, "Quiet posts report their queued state.");
		assert.equal(roundsDeliveries.length, deliveriesBefore, "Quiet posts must not deliver to Pi.");
		assert.equal((await (await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: quietPost.thread.id, body: "More quiet detail.", quiet: true }) })).json()).thread.queued, true);
		assert.equal(roundsDeliveries.length, deliveriesBefore, "Quiet replies must not deliver either.");
		const escalateJson = await (await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: quietPost.thread.id, body: "Actually, answer now." }) })).json();
		assert.equal(escalateJson.escalated, true);
		assert.equal(roundsDeliveries.length, deliveriesBefore + 1, "Escalation delivers exactly once.");
		assert.equal(roundsDeliveries[roundsDeliveries.length - 1], 3, "Escalation delivers the whole reviewer backlog at once.");
		const quietSecond = await (await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 3, source: "overview", body: "Second quiet topic.", quiet: true }) })).json();
		assert.equal((await fetch(finishEndpoint, { method: "POST", headers, body: "{}" })).status, 200);
		assert.equal(roundsServer.getThread(quietSecond.thread.id).queued, false, "Sending the round delivers queued threads through the pass.");

		const entry = roundsServer.entryUrl();
		assert.equal((await fetch(entry, { redirect: "manual" })).status, 302, "Reissued entry links must authenticate.");
		assert.equal((await fetch(entry, { redirect: "manual" })).status, 403, "Reissued entry links must be single-use.");
		await reader.cancel();
	} finally {
		await roundsServer.close();
	}

	{
		const gapFile = (status, lines, flags = {}) => ({ status, lines, binary: false, omitted: false, truncated: false, ...flags });
		const hunk = (content) => ({ kind: "hunk", content });
		const ctx = { kind: "context", content: "x" };
		assert.deepEqual(computeContextGaps(gapFile("modified", [hunk("@@ -30,7 +30,8 @@ function x()"), ctx, ctx, ctx])), [
			{ oldStart: 1, oldEnd: 29, delta: 0 },
			{ oldStart: 37, oldEnd: Infinity, delta: 1 },
		]);
		assert.deepEqual(computeContextGaps(gapFile("modified", [hunk("@@ -30,7 +30,8 @@"), ctx, ctx])), [{ oldStart: 1, oldEnd: 29, delta: 0 }], "Fewer than three trailing context rows prove the old side ended inside the hunk.");
		assert.deepEqual(computeContextGaps(gapFile("modified", [hunk("@@ -5,7 +5,9 @@"), hunk("@@ -40,7 +42,7 @@"), ctx, ctx, ctx])), [
			{ oldStart: 1, oldEnd: 4, delta: 0 },
			{ oldStart: 12, oldEnd: 39, delta: 2 },
			{ oldStart: 47, oldEnd: Infinity, delta: 2 },
		]);
		assert.deepEqual(computeContextGaps(gapFile("modified", [hunk("@@ -5,0 +6,2 @@"), ctx, ctx, ctx])), [
			{ oldStart: 1, oldEnd: 5, delta: 0 },
			{ oldStart: 6, oldEnd: Infinity, delta: 2 },
		], "A zero-count old side names the line before the insertion.");
		assert.deepEqual(computeContextGaps(gapFile("untracked", [hunk("@@ -0,0 +1,3 @@"), ctx, ctx, ctx])), []);
		assert.deepEqual(computeContextGaps(gapFile("added", [hunk("@@ -0,0 +1,3 @@"), ctx, ctx, ctx])), []);
		assert.deepEqual(computeContextGaps(gapFile("deleted", [hunk("@@ -1,5 +0,0 @@"), ctx, ctx, ctx])), []);
		assert.deepEqual(computeContextGaps(gapFile("modified", [hunk("@@ -30,7 +30,8 @@"), ctx, ctx, ctx], { truncated: true })), []);
		assert.deepEqual(computeContextGaps(gapFile("modified", [hunk("@@ -10,7 +5,7 @@"), ctx, ctx, ctx])), [], "Inconsistent old/new offsets fail closed.");
		assert.deepEqual(computeContextGaps(gapFile("modified", [hunk("@@ -30,7 +30,7 @@"), hunk("@@ -20,7 +20,7 @@"), ctx, ctx, ctx])), [], "Regressing hunk order fails closed.");

		assert.deepEqual(await readHeadBlobLines(fixture, snapshot.head, "staged.txt"), ["baseline"], "The pinned HEAD blob serves the committed content, not the worktree.");
		assert.equal(await readHeadBlobLines(fixture, snapshot.head, "untracked.txt"), undefined, "Paths absent at HEAD have no pinned blob.");
		assert.equal(await readHeadBlobLines(fixture, snapshot.head, "staged.txt", { limits: { maxBlobBytes: 4 } }), undefined, "Oversized blobs opt out of context expansion.");
	}

	contextRepo = await mkdtemp(join(tmpdir(), "pi-code-review-context-"));
	await git(contextRepo, "init", "-q");
	await git(contextRepo, "config", "user.email", "test@example.com");
	await git(contextRepo, "config", "user.name", "Test");
	const contextBase = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
	await writeFile(join(contextRepo, "ctx.txt"), `${contextBase.join("\n")}\n`);
	await writeFile(join(contextRepo, "moveme.txt"), `${Array.from({ length: 40 }, (_, index) => `row ${index + 1}`).join("\n")}\n`);
	await git(contextRepo, "add", ".");
	await git(contextRepo, "commit", "-qm", "baseline");
	const contextEdited = [...contextBase.slice(0, 10), "inserted a", "inserted b", ...contextBase.slice(10)];
	contextEdited[41] = "line 40 <china> & changed";
	await writeFile(join(contextRepo, "ctx.txt"), `${contextEdited.join("\n")}\n`);
	await git(contextRepo, "mv", "moveme.txt", "moved.txt");
	await writeFile(join(contextRepo, "moved.txt"), `${Array.from({ length: 40 }, (_, index) => (index === 19 ? "row 20 changed" : `row ${index + 1}`)).join("\n")}\n`);
	const contextSnapshot = await collectReviewSnapshot(contextRepo);
	const contextReview = applyReviewManifest(contextSnapshot, { files: [] });
	const contextFile = contextReview.files.find((file) => file.path === "ctx.txt");
	assert.deepEqual(computeContextGaps(contextFile), [
		{ oldStart: 1, oldEnd: 7, delta: 0 },
		{ oldStart: 14, oldEnd: 36, delta: 2 },
		{ oldStart: 44, oldEnd: Infinity, delta: 2 },
	], "A real two-hunk diff yields leading, middle, and trailing gaps with accumulated deltas.");
	const contextHtml = renderReviewHtml(contextReview, "ctx-nonce");
	assert.match(contextHtml, /data-expander data-file-index="0" data-gap-start="1" data-gap-end="7" data-gap-delta="0"/, "The leading gap renders a divider.");
	assert.match(contextHtml, /data-gap-start="14" data-gap-end="36" data-gap-delta="2"/, "Inter-hunk gaps render dividers with the new-side delta.");
	// Pinned at the codepoint level: arrow-ish glyphs all read plausibly in a
	// snapshot diff, so assert the exact characters (U+2913 down, U+2912 up).
	assert.match(contextHtml, /data-expand="down"[^>]*>\u2913 20</, "The down control shows DOWNWARDS ARROW TO BAR.");
	assert.match(contextHtml, /data-expand="up"[^>]*>\u2912 20</, "The up control shows UPWARDS ARROW TO BAR.");
	assert.match(contextHtml, /data-expander data-file-index="0" data-gap-start="44" data-gap-delta="2"/, "The trailing gap renders a divider without a known end.");
	assert.doesNotMatch(html, /<tr class="diff-expander"/, "Files whose diffs reach EOF or are untracked render no expanders.");

	const movedFile = contextReview.files.find((file) => file.path === "moved.txt");
	assert.equal(movedFile?.status, "renamed");
	assert.equal(movedFile?.oldPath, "moveme.txt");
	assert.deepEqual(computeContextGaps(movedFile), [
		{ oldStart: 1, oldEnd: 16, delta: 0 },
		{ oldStart: 24, oldEnd: Infinity, delta: 0 },
	], "Renamed files with content changes expose gaps in old-path line numbers.");
	const contextServer = await createCodeReviewServer(contextReview, {
		onThreadPost: async () => {},
		onFinishPass: async () => ({ stale: false }),
		// The production reader: pinned-blob resolution incl. rename old paths.
		contextLines: createPinnedBlobContextReader(),
	});
	try {
		const origin = new URL(contextServer.url).origin;
		const bootstrap = await fetch(contextServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const contextGet = (query) => fetch(`${origin}/__pi_code_review_context__?${query}`, { headers: { cookie } });
		assert.equal((await fetch(`${origin}/__pi_code_review_context__?round=1&path=ctx.txt&oldStart=1&oldEnd=7`)).status, 403, "Context requests require authentication.");
		assert.equal((await contextGet("round=9&path=ctx.txt&oldStart=1&oldEnd=7")).status, 404);
		assert.equal((await contextGet("round=1&path=nope.txt&oldStart=1&oldEnd=7")).status, 404);
		assert.equal((await contextGet("round=1&path=ctx.txt&oldStart=0&oldEnd=7")).status, 400);
		assert.equal((await contextGet("round=1&path=ctx.txt&oldStart=7&oldEnd=1")).status, 400);
		assert.equal((await contextGet("round=1&path=ctx.txt&oldStart=44&oldEnd=944")).status, 400, "Requests beyond the per-call cap are rejected.");
		assert.equal((await contextGet("round=1&path=ctx.txt&oldStart=30&oldEnd=40")).status, 400, "Ranges overlapping a hunk are rejected.");
		assert.equal((await contextGet("round=1&path=ctx.txt&oldStart=1&oldEnd=8")).status, 400, "Gap membership is exact at the boundary.");
		const top = await (await contextGet("round=1&path=ctx.txt&oldStart=17&oldEnd=36")).json();
		assert.equal(top.lines.length, 20);
		assert.deepEqual(top.lines[0], { old: 17, new: 19, content: "line 17" }, "New-side numbering applies the gap's delta.");
		assert.equal(top.eof, false);
		const beyond = await (await contextGet("round=1&path=ctx.txt&oldStart=64&oldEnd=83")).json();
		assert.equal(beyond.lines.length, 17, "Trailing requests clamp at the blob's end.");
		assert.deepEqual(beyond.lines[16], { old: 80, new: 82, content: "line 80" });
		assert.equal(beyond.eof, true);
		const renamed = await (await contextGet("round=1&path=moved.txt&oldStart=1&oldEnd=16")).json();
		assert.equal(renamed.lines.length, 16, "Renamed files serve context from their HEAD-side blob path.");
		assert.deepEqual(renamed.lines[0], { old: 1, new: 1, content: "row 1" });
		const renamedTail = await (await contextGet("round=1&path=moved.txt&oldStart=24&oldEnd=43")).json();
		assert.equal(renamedTail.lines.length, 17, "Renamed trailing context clamps at the old blob's end.");
		assert.deepEqual(renamedTail.lines[16], { old: 40, new: 40, content: "row 40" });
		assert.equal(renamedTail.eof, true);
		assert.equal(contextServer.addRound({ ...contextReview, id: altId(contextReview.id, 10) }, contextReview.id).round, 2);
		assert.equal((await contextGet("round=1&path=ctx.txt&oldStart=1&oldEnd=7")).status, 200, "Superseded rounds keep serving frozen context read-only.");
	} finally {
		await contextServer.close();
	}
	const bareServer = await createCodeReviewServer(contextReview, { onThreadPost: async () => {}, onFinishPass: async () => ({ stale: false }) });
	try {
		const bareBootstrap = await fetch(bareServer.url, { redirect: "manual" });
		const bareCookie = (bareBootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		assert.equal((await fetch(`${new URL(bareServer.url).origin}/__pi_code_review_context__?round=1&path=ctx.txt&oldStart=1&oldEnd=7`, { headers: { cookie: bareCookie } })).status, 404, "Sessions without a context reader refuse expansion honestly.");
	} finally {
		await bareServer.close();
	}
	console.log("Context expansion flow passed.");

	let probeFingerprint = "fp-1";
	let probeSnapshotId = ordered.id;
	const cleanProbeFiles = () => ordered.files.map((file) => ({ path: file.path, key: reviewFileDriftKey(file) }));
	let probeFiles = cleanProbeFiles();
	let fullChecks = 0;
	let failNextFull = false;
	let fingerprintGate;
	const staleServer = await createCodeReviewServer(ordered, {
		onThreadPost: async () => {},
		onFinishPass: async () => ({ stale: false }),
		staleness: {
			fingerprint: async () => {
				if (fingerprintGate) await fingerprintGate;
				return probeFingerprint;
			},
			snapshot: async () => {
				if (failNextFull) {
					failNextFull = false;
					throw new Error("probe boom");
				}
				fullChecks += 1;
				return { id: probeSnapshotId, files: probeFiles };
			},
		},
	});
	try {
		const origin = new URL(staleServer.url).origin;
		const bootstrap = await fetch(staleServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const headers = { cookie, "content-type": "application/json", origin };
		const eventsResponse = await fetch(`${origin}/__pi_code_review_events__`, { headers: { cookie } });
		const reader = eventsResponse.body.getReader();
		const decoder = new TextDecoder();
		let sseBuffer = "";
		const readUntil = async (marker) => {
			const deadline = Date.now() + 5_000;
			while (!sseBuffer.includes(marker)) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE marker: ${marker}`);
				const { value, done } = await reader.read();
				if (done) throw new Error("SSE stream ended early.");
				sseBuffer += decoder.decode(value, { stream: true });
			}
		};
		await readUntil("event: init");
		assert.match(sseBuffer, /"stale":false,"driftPaths":\[\]/, "The init payload carries the staleness verdict and drift paths.");
		assert.equal(await staleServer.checkStaleness(), false, "A matching snapshot id reads clean.");
		assert.equal(fullChecks, 1);
		assert.equal(await staleServer.checkStaleness(), false);
		assert.equal(fullChecks, 1, "An unchanged cheap fingerprint gates the full re-collection.");
		probeFingerprint = "fp-2";
		probeSnapshotId = "drifted";
		probeFiles = [...cleanProbeFiles().slice(1), { path: ordered.files[0].path, key: "edited" }, { path: "brand-new.txt", key: "joined" }];
		assert.equal(await staleServer.checkStaleness(), true, "A drifted worktree marks the round stale.");
		await readUntil('"stale":true');
		const driftMatch = /event: staleness\ndata: \{"stale":true,"driftPaths":\[([^\]]*)\]\}/.exec(sseBuffer);
		assert.ok(driftMatch, "The staleness event carries drift paths.");
		assert.deepEqual(JSON.parse(`[${driftMatch[1]}]`), ["brand-new.txt", ordered.files[0].path].sort(), "The staleness event names exactly the drifted paths, including files that joined the changeset.");
		probeFingerprint = "fp-3";
		probeSnapshotId = ordered.id;
		probeFiles = cleanProbeFiles();
		assert.equal(await staleServer.checkStaleness(), false, "The badge clears when the tree returns.");
		await readUntil('event: staleness\ndata: {"stale":false');
		assert.match(sseBuffer, /event: staleness\ndata: \{"stale":false,"driftPaths":\[\]\}/, "A clean verdict clears the drift paths.");
		probeFingerprint = "fp-4";
		probeSnapshotId = "drifted-again";
		assert.equal((await fetch(`${origin}/__pi_code_review_finish__`, { method: "POST", headers, body: "{}" })).status, 200);
		const fullChecksBeforeRevising = fullChecks;
		assert.equal(await staleServer.checkStaleness(), false, "Drift while Pi revises is expected, not signal.");
		assert.equal(fullChecks, fullChecksBeforeRevising, "The revising phase suppresses staleness evaluation entirely.");
		// The revising window is quiet-only: live posts and resolves wait for the
		// next round, while quiet posts queue and ride the advance.
		const revisingSelection = { round: 1, source: "selection", file: "untracked.txt", side: "new", newStart: 1, newEnd: 2, highlight: "quiet window", body: "Queued while Pi revises." };
		assert.equal((await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify(revisingSelection) })).status, 409, "Live posts stay blocked while Pi revises.");
		const revisingQuiet = await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ ...revisingSelection, quiet: true }) });
		assert.equal(revisingQuiet.status, 200, "Quiet posts are accepted while Pi revises.");
		const revisingThread = (await revisingQuiet.json()).thread;
		assert.equal(revisingThread.queued, true, "A revising-window post is queued, never delivered live.");
		assert.equal((await fetch(`${origin}/__pi_code_review_resolve__`, { method: "POST", headers, body: JSON.stringify({ threadId: revisingThread.id, resolved: true }) })).status, 409, "Resolves wait for the next round.");
		assert.equal((await fetch(`${origin}/__pi_code_review_resume__`, { method: "POST", headers, body: "{}" })).status, 200);
		assert.equal(await staleServer.checkStaleness(), true, "Resume re-enables drift detection.");
		assert.equal(staleServer.addRound({ ...ordered, id: altId(ordered.id, 60) }, ordered.id).round, 2);
		const survivedQuiet = staleServer.threads().find((thread) => thread.id === revisingThread.id);
		assert.equal(survivedQuiet?.queued, true, "A revising-window quiet thread rides the round advance still queued.");
		assert.equal(survivedQuiet?.turns[0]?.body, "Queued while Pi revises.", "Its content survives the carry.");
		assert.equal(staleServer.isStale(), false, "A new round resets staleness — its snapshot was just collected from this tree.");
		probeFingerprint = "fp-5";
		assert.equal(await staleServer.checkStaleness(), true, "Drift is measured against the current round's snapshot.");
		probeFingerprint = "fp-6";
		probeSnapshotId = altId(ordered.id, 60);
		assert.equal(await staleServer.checkStaleness(), false, "The current round's own id reads clean.");
		probeFingerprint = "fp-7";
		probeSnapshotId = "drift-behind-failure";
		failNextFull = true;
		assert.equal(await staleServer.checkStaleness(), false, "A failed collection keeps the previous verdict.");
		const fullChecksAfterFailure = fullChecks;
		assert.equal(await staleServer.checkStaleness(), true, "A failed check must not stamp the cheap fingerprint — the next tick re-runs the full collection.");
		assert.equal(fullChecks, fullChecksAfterFailure + 1, "The retry performs a real re-collection instead of being gated by the cheap check.");
		assert.deepEqual(staleServer.addRound({ ...ordered, id: altId(ordered.id, 60) }, altId(ordered.id, 60)), { identical: true, round: 2 });
		assert.equal(staleServer.isStale(), false, "An identical reopen proves the tree matches the round; staleness resets.");
		let releaseFingerprint;
		fingerprintGate = new Promise((resolvePromise) => { releaseFingerprint = resolvePromise; });
		probeFingerprint = "fp-8";
		probeSnapshotId = "late-drift";
		const tickProbe = staleServer.checkStaleness();
		const forcedProbe = staleServer.checkStaleness(true);
		fingerprintGate = undefined;
		releaseFingerprint();
		assert.equal(await tickProbe, true);
		assert.equal(await forcedProbe, true, "A forced check waits out an in-flight probe and returns the fresh verdict, never the previous one.");
		await reader.cancel();
	} finally {
		await staleServer.close();
	}
	console.log("Staleness detection flow passed.");

	assert.deepEqual(computeIntraline("const limit = 10;", "const limit = 250;"), { del: [14, 16], add: [14, 17] }, "A small replacement emphasizes only the changed token.");
	assert.deepEqual(computeIntraline("return value", "return values"), { del: [7, 12], add: [7, 13] }, "Mid-word changes expand to whole words.");
	assert.deepEqual(computeIntraline("if (a)", "if (a && b)"), { del: [5, 5], add: [5, 10] }, "Pure insertions emphasize only the added side.");
	assert.equal(computeIntraline("completely different line", "nothing shared at all!!"), undefined, "Whole-line changes carry no emphasis.");
	assert.equal(computeIntraline("same", "same"), undefined);
	const intralineHtml = renderReviewHtml(applyReviewManifest(contextSnapshot, { files: [] }), "intraline-nonce");
	assert.match(intralineHtml, /data-old-line="40"[\s\S]{0,300}?<span>line 40<\/span>/, "An empty del-side range renders without an emphasis span.");
	assert.match(intralineHtml, /<span>line 40<span class="intraline"> &lt;china&gt; &amp; changed<\/span><\/span>/, "Emphasized segments escape HTML independently on both sides of the span boundary.");
	assert.deepEqual(computeIntraline("mood \uD83D\uDE00 x", "mood \uD83D\uDE01 x"), { del: [5, 7], add: [5, 7] }, "A changed emoji emphasizes the whole surrogate pair, never half of it.");
	assert.deepEqual(computeIntraline("pin \uD83D\uDE00", "pin \uD83E\uDE00"), { del: [4, 6], add: [4, 6] }, "A shared low surrogate retreats out of the suffix so no pair splits.");
	assert.doesNotMatch(renderReviewHtml(applyReviewManifest(snapshot, { files: [] }), "plain-intraline"), /class="intraline"/, "Pure additions and deletions without pairs get no emphasis.");

	assert.equal(renderMarkdown("Plain **bold** and *soft* text"), "<p>Plain <strong>bold</strong> and <em>soft</em> text</p>");
	assert.equal(renderMarkdown("line one\nline two\n\nnext para"), "<p>line one<br>line two</p><p>next para</p>");
	assert.equal(renderMarkdown("- a\n- **b**\n\n1. one\n2) two"), "<ul><li>a</li><li><strong>b</strong></li></ul><ol><li>one</li><li>two</li></ol>");
	assert.equal(
		renderMarkdown("1. first\n   wrapped one\n2. second\n   wrapped two\n3. third", { sourceLines: true }),
		'<ol><li data-md-line="1" data-md-end="2">first wrapped one</li><li data-md-line="3" data-md-end="4">second wrapped two</li><li data-md-line="5" data-md-end="5">third</li></ol>',
		"Wrapped items lazily continue their list — one <ol>, no restarted numbering, no torn-out paragraphs, honest end stamps.",
	);
	assert.equal(renderMarkdown("- alpha\n  wrapped alpha\n- beta"), "<ul><li>alpha wrapped alpha</li><li>beta</li></ul>", "Bulleted lists keep wrapped items too.");
	assert.equal(renderMarkdown("- outer\n  - inner\n    inner wrap"), "<ul><li>outer<ul><li>inner inner wrap</li></ul></li></ul>", "Continuation joins the deepest open item.");
	assert.equal(renderMarkdown("- item\n## heading after list"), "<ul><li>item</li></ul><h2>heading after list</h2>", "A real block construct still ends the list; lazy continuation only claims plain lines.");
	assert.equal(renderMarkdown("see `a < b && **x**` here"), "<p>see <code>a &lt; b &amp;&amp; **x**</code> here</p>", "Code spans are escaped and never emphasized.");
	assert.equal(renderMarkdown("```js\nif (a < b) alert(\"x\");\n```"), '<pre><code>if (a &lt; b) alert(&quot;x&quot;);</code></pre>', "Fences escape their contents and drop the language tag.");
	assert.equal(renderMarkdown("```\nunterminated"), "<pre><code>unterminated</code></pre>");
	assert.equal(renderMarkdown("[docs](https://example.com/a?b=1&c=2)"), '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
	assert.equal(renderMarkdown("[evil](javascript:alert(1))"), "<p>[evil](javascript:alert(1))</p>", "Non-http(s) schemes never become links.");
	assert.equal(renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>", "Raw HTML is always escaped.");
	assert.equal(renderMarkdown('<img src=x onerror="alert(1)">'), "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
	assert.equal(renderMarkdown("a \uE000 0 \uE001 b `c`"), "<p>a  0  b <code>c</code></p>", "Token sentinels in input are stripped so they cannot splice the stash.");
	assert.equal(renderMarkdown("[see `x` docs](https://example.com)"), '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">see <code>x</code> docs</a></p>', "Code spans inside link labels reinsert instead of leaking sentinels.");
	const urlCodeSpan = renderMarkdown("[x](https://e.com/`a`)");
	assert.ok(!urlCodeSpan.includes("<a "), "A code span inside a URL breaks the link instead of expanding markup into the href.");
	assert.ok(urlCodeSpan.includes("<code>a</code>") && !/[\uE000\uE001]/.test(urlCodeSpan), "The span still renders and no sentinel survives.");
	const breakout = renderMarkdown('[x](https://e.com/"onmouseover=alert(1))');
	assert.ok(breakout.includes('href="https://e.com/&quot;onmouseover=alert(1"'), "Quotes in URLs stay entity-encoded inside the attribute value.");
	assert.ok(!/"\s+onmouseover/.test(breakout), "No attribute can be injected through a crafted URL.");
	// Document blocks for plan review: headings, rules, quotes, tables, nesting.
	assert.equal(renderMarkdown("# One <b>\n### Three *em*\n####### seven"), "<h1>One &lt;b&gt;</h1><h3>Three <em>em</em></h3><p>####### seven</p>", "Headings cap at six hashes and escape their content.");
	assert.equal(renderMarkdown("above\n---\n* * *\n- - -\nbelow"), "<p>above</p><hr><hr><hr><p>below</p>", "Rule variants render as hr — including dash-space forms that could read as list items.");
	assert.equal(renderMarkdown("> quoted <script>\n> line two\n>\n> next para"), "<blockquote><p>quoted &lt;script&gt;<br>line two</p><p>next para</p></blockquote>", "Blockquotes match the escaped marker, escape contents, and split paragraphs.");
	assert.equal(
		renderMarkdown("| A | B |\n| --- | --- |\n| `x < y` | <img src=x> |"),
		"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><code>x &lt; y</code></td><td>&lt;img src=x&gt;</td></tr></tbody></table>",
		"Tables render whitelisted cells with inline markdown and full escaping.",
	);
	assert.equal(renderMarkdown("a | b\nplain"), "<p>a | b<br>plain</p>", "A pipe line without a separator row stays a paragraph.");
	assert.equal(
		renderMarkdown("- top\n  - inner **x**\n  - inner 2\n- top 2\n  1. num\n- top 3"),
		"<ul><li>top<ul><li>inner <strong>x</strong></li><li>inner 2</li></ul></li><li>top 2<ol><li>num</li></ol></li><li>top 3</li></ul>",
		"Lists nest by indentation, mixing ordered children under unordered parents.",
	);
	assert.equal(
		renderMarkdown("# H\n\npara\ntwo\n\n- a\n  - b\n\n```\ncode\n```", { sourceLines: true }),
		'<h1 data-md-line="1" data-md-end="1">H</h1><p data-md-line="3" data-md-end="4">para<br>two</p><ul><li data-md-line="6" data-md-end="6">a<ul><li data-md-line="7" data-md-end="7">b</li></ul></li></ul><pre data-md-line="9" data-md-end="11"><code>code</code></pre>',
		"sourceLines maps every block back to its 1-based source range.",
	);
	assert.doesNotMatch(renderMarkdown("# H\n\n- a"), /data-md-line/, "Without the option no source attributes are emitted — thread bodies stay unchanged.");
	assert.equal(
		renderMarkdown("> a\n> b\r\n\r\n| A |\n| - |\n| x |", { sourceLines: true }),
		'<blockquote data-md-line="1" data-md-end="2"><p>a<br>b</p></blockquote><table data-md-line="4" data-md-end="6"><thead><tr><th>A</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>',
		"Blockquote and table end ranges stay exact, and CRLF input keeps line numbers aligned.",
	);
	assert.equal(renderMarkdown("option a | option b\n---"), "<p>option a | option b</p><hr>", "A separator whose column count mismatches the pipe line above is not a table.");

	// Plan reviews: a markdown document sliced into file-shaped heading sections.
	const planMarkdown = ["Intro line one.", "", "## Goals <b>", "- fast", "- safe", "", "## Steps", "1. do `x`", "2. do y", "", "```", "# not a heading", "```"].join("\n");
	const plan = buildPlanReview({
		title: "Test Plan",
		markdown: planMarkdown,
		sections: [{ heading: "goals <b>", commentary: [{ id: "g1", body: "Note on goals", startLine: 4, endLine: 5 }] }],
	});
	assert.equal(plan.kind, "plan");
	assert.deepEqual(plan.files.map((section) => [section.path, section.startLine, section.endLine]), [["introduction", 1, 2], ["goals-b", 3, 6], ["steps", 7, 13]], "Sections split at the shallowest heading level; fenced hashes are not headings; the preamble becomes an introduction.");
	assert.equal(plan.files[1].sectionTitle, "Goals <b>");
	assert.deepEqual(plan.files[1].commentary.map((entry) => [entry.id, entry.startLine, entry.endLine, entry.side]), [["g1", 4, 5, "new"]]);
	assert.deepEqual(plan.files[1].lines[1], { kind: "context", newLine: 4, content: "- fast" }, "Section lines carry absolute source line numbers for anchor validation.");
	assert.throws(() => buildPlanReview({ title: "x", markdown: planMarkdown, sections: [{ heading: "missing" }] }), /matches no plan heading/);
	assert.throws(() => buildPlanReview({ title: "x", markdown: planMarkdown, sections: [{ heading: "Steps", commentary: [{ id: "s1", body: "b", startLine: 3 }] }] }), /outside its section/);
	assert.throws(() => buildPlanReview({ title: "x", markdown: planMarkdown, sections: [{ heading: "Steps" }, { heading: "steps" }] }), /more than once/);
	assert.throws(() => buildPlanReview({ title: "x", markdown: "## Same\na\n## Same\nb", sections: [{ heading: "Same" }] }), /reference it by its slug/, "Duplicate heading text is ambiguous as a reference.");
	assert.equal(buildPlanReview({ title: "x", markdown: "## Same\na\n## Same\nb", sections: [{ heading: "same-2", commentary: [{ id: "probe", body: "второй" }] }] }).files[1].commentary[0].body, "второй", "Slugs stay exact references even for duplicate headings.");
	const planHtmlNoDiagram = renderReviewHtml(plan, "plain-nonce");
	{
		// Diagram element identity: parsing, anchors, carries, and wire format.
		const { parseMermaidElements, collectDiagramElements, elementExists } = await import("../shared/diagram.js");
		const arch = parseMermaidElements(["flowchart LR", "  ui[Web] --> api(Gateway)", "  api -- auth --> idp{IdP}", "  api --> db[(Store)]", "  api --> q[[Queue]]", "  q --> w1[Worker] & w2[Worker 2]"].join("\n"));
		assert.deepEqual([...arch.nodes].sort(), ["api", "db", "idp", "q", "ui", "w1", "w2"], "Every node id is enumerable from the source.");
		assert.ok(arch.edges.has("ui->api") && arch.edges.has("api->idp") && arch.edges.has("q->w2"), "Labeled edges and fan-outs resolve to endpoint pairs.");
		const diagramMd = ["## Arch", "", "```mermaid", "flowchart LR", "  ui[Web] --> api(Gateway)", "  api --> db[(Store)]", "```", "prose"].join("\n");
		assert.equal(elementExists("node:api", diagramMd), true);
		assert.equal(elementExists("edge:ui->api", diagramMd), true);
		assert.equal(elementExists("node:ghost", diagramMd), false);
		assert.equal(collectDiagramElements("no fences here").nodes.size, 0);
		const tricky = parseMermaidElements(["flowchart LR", "  api[API (v2)] --> db[(Store)]", "  a:::hot --> b", "  lonely", "  x -->|see > this| y"].join("\n"));
		assert.deepEqual([...tricky.nodes].sort(), ["a", "api", "b", "db", "lonely", "x", "y"], "Label words, ::: classes, and bare statements never pollute the node set.");
		assert.ok(tricky.edges.has("a->b") && tricky.edges.has("x->y"), "Class shorthand and piped labels do not corrupt edge endpoints.");
		const { extractMermaidSources } = await import("../shared/diagram.js");
		assert.equal(extractMermaidSources("```mermaid extra\nflowchart LR\n  a --> b\n```").length, 1, "Info strings after the language are accepted, matching the renderer.");
		assert.equal(extractMermaidSources("```text\n```mermaid\n```\nflowchart\n").length, 0, "Fences inside other fences follow the renderer's close-on-any-fence rule.");
		const { buildDiagramReview } = await import("../shared/plan-review.js");
		const diagramReview = buildDiagramReview({ title: "Topology", diagrams: [
			{ name: "Service map", source: "flowchart LR\n  ui[Web] --> api(Gateway)", caption: "The request path.", commentary: [{ id: "gw", body: "one gateway", element: "node:api" }] },
			{ name: "Deploy flow", source: "flowchart LR\n  build --> prod" },
		] });
		assert.equal(diagramReview.kind, "plan", "Diagram reviews ARE plan sessions — one engine, two front doors.");
		assert.deepEqual(diagramReview.files.map((section) => section.path), ["service-map", "deploy-flow"], "Each diagram becomes one named section.");
		assert.ok(diagramReview.files[0].markdown.includes("The request path."), "Captions render beneath their diagram.");
		assert.equal(diagramReview.files[0].commentary[0].element, "node:api", "Element commentary flows through the generated shell.");
		assert.match(renderReviewHtml(diagramReview, "dg-nonce"), /__pi_code_review_mermaid__/, "The generated shell loads the renderer.");
		assert.throws(() => buildDiagramReview({ title: "x", diagrams: [{ name: "a", source: "flowchart\n\u0060\u0060\u0060\nboom" }] }), /fence line/, "Sources cannot break out of their fence.");
		assert.throws(() => buildDiagramReview({ title: "x", diagrams: [{ name: "Same", source: "flowchart" }, { name: "same", source: "flowchart" }] }), /more than once/, "Diagram names are unique section headings.");
		assert.throws(() => buildDiagramReview({ title: "x", diagrams: [{ name: "a", source: "flowchart", caption: "## Phantom" }] }), /heading or fence marker/, "Captions cannot inject document structure.");
		assert.throws(() => buildDiagramReview({ title: "x", diagrams: [{ name: "User Flow", source: "flowchart" }, { name: "User-Flow", source: "flowchart" }] }), /same section slug/, "Slug-base collisions are rejected so reorders cannot swap carried threads.");
		assert.equal(diagramReview.files.length, 2, "One section per diagram, exactly.");
		assert.throws(() => buildDiagramReview({ title: "x", diagrams: [{ name: "a", source: "flowchart LR\n  m --> n", commentary: [{ id: "c", body: "x", element: "node:zzz" }] }] }), /nodes: m, n/, "Element rejections keep their hints through the shell.");
		const { computeElementDiff } = await import("../shared/diagram.js");
		const diffPrev = "```mermaid\nflowchart LR\n  ui[Web] --> api(Gateway)\n  api --> db[(Store)]\n```";
		const diffNext = "```mermaid\nflowchart LR\n  ui[Web client] --> api(Gateway)\n  api --> pg[(Postgres)]\n```";
		const elementDiff = computeElementDiff(diffPrev, diffNext);
		assert.deepEqual(elementDiff.changed.sort(), ["edge:api->pg", "node:pg", "node:ui"], "New ids, relabeled nodes, and new edges glow; unchanged edges stay dark even when an endpoint relabels.");
		assert.deepEqual(elementDiff.removed.sort(), ["edge:api->db", "node:db"], "Removed ids surface for the rail list.");
		assert.ok(!elementDiff.changed.includes("node:api"), "D8: the gateway does not glow because its neighbor was renamed.");
		assert.equal(computeElementDiff(diffPrev, diffPrev).changed.length + computeElementDiff(diffPrev, diffPrev).removed.length, 0, "Identical sources diff to nothing.");
		assert.equal(computeElementDiff("```mermaid\nflowchart LR\n  a -->|api[1]| b\n  api[Service] --> b\n```", "```mermaid\nflowchart LR\n  a -->|api[2]| b\n  api[Service] --> b\n```").changed.length, 0, "Edge-label prose that name-drops a node never glows it.");
		assert.deepEqual(computeElementDiff("```mermaid\nflowchart LR\n  x[One] --> y\n  x[Two] --> z\n```", "```mermaid\nflowchart LR\n  x[One] --> y\n  x[Three] --> z\n```").changed, ["node:x"], "Label signatures follow mermaid last-definition-wins.");
		assert.deepEqual(computeElementDiff("```mermaid\nstateDiagram-v2\n  Idle --> Done\n  Idle : waits\n```", "```mermaid\nstateDiagram-v2\n  Idle --> Done\n  Idle : sleeps\n```").changed, ["node:Idle"], "State colon relabels glow their state.");
		// Markdown: mermaid fences become diagram figures; other fences stay pre.
		const figureHtml = renderMarkdown(diagramMd, { sourceLines: true });
		assert.match(figureHtml, /<figure class="diagram-block" data-diagram data-md-line="3" data-md-end="7">/, "Mermaid fences emit diagram figures with source-line anchors.");
		assert.match(figureHtml, /<pre class="diagram-source" hidden><code>flowchart LR/, "The escaped source travels hidden inside the figure.");
		assert.doesNotMatch(renderMarkdown("```js\ncode\n```"), /data-diagram/, "Non-mermaid fences render as plain code blocks.");
		// Plan commentary may refine anchors with elements; bad refs get hints.
		const archPlan = buildPlanReview({ title: "D", markdown: diagramMd, sections: [{ heading: "Arch", commentary: [{ id: "n1", body: "the gateway", element: "node:api" }] }] });
		assert.equal(archPlan.files[0].commentary[0].element, "node:api");
		assert.throws(() => buildPlanReview({ title: "D", markdown: diagramMd, sections: [{ heading: "Arch", commentary: [{ id: "n1", body: "x", element: "node:ghost" }] }] }), /nodes: ui, api, db/, "Element rejections name what the diagrams define.");
		assert.match(renderReviewHtml(archPlan, "d-nonce"), /data-anchor-element="node:api"/, "Element-anchored notes expose their element to the client.");
		assert.match(renderReviewHtml(archPlan, "d-nonce"), /__pi_code_review_mermaid__/, "Plans with diagrams load the vendored renderer.");
		assert.doesNotMatch(planHtmlNoDiagram, /__pi_code_review_mermaid__/, "Plans without diagrams skip the renderer entirely.");
		// Selection threads: element refines the fence-line anchor; wire carries it.
		const archStore = createThreadStore(archPlan);
		const archThread = archStore.postUserTurn({ source: "selection", file: "arch", side: "new", newStart: 3, newEnd: 7, highlight: "⬡ Gateway", element: "node:api", body: "Why a single gateway?" });
		assert.equal(archThread.thread.element, "node:api", "Element anchors persist on the thread.");
		assert.equal(archStore.postUserTurn({ source: "selection", file: "arch", side: "new", newStart: 3, newEnd: 7, highlight: "x", element: "node:ghost", body: "y" }).error, "invalid", "Unknown elements reject the post.");
		assert.match(formatReviewPassXml(archPlan, archStore.list(), archStore.summary(), false, undefined, 1), /element="node:api"/, "The pass digest names the element anchor.");
		// Carried responses re-anchor elements against the NEW round's diagrams.
		const nextArch = buildPlanReview({ title: "D", markdown: diagramMd.replace("api --> db", "api --> cache[(Cache)]\n  cache --> db"), sections: [] });
		const carriedArch = buildCarriedThreads([{ respondsTo: archThread.thread.id, resolution: "addressed", body: "Split behind a cache.", file: "arch", element: "node:cache" }], archStore.list(), nextArch, 1);
		assert.equal(carriedArch[0].carried.element, "node:cache", "Responses may re-anchor to a new element.");
		assert.throws(() => buildCarriedThreads([{ respondsTo: archThread.thread.id, resolution: "addressed", body: "b", file: "arch", element: "node:ghost" }], archStore.list(), nextArch, 1), /which no diagram in arch defines \(nodes: /, "Bad carried elements get the hint treatment.");
	}
	const planStore = createThreadStore(plan);
	const planSelection = planStore.postUserTurn({ source: "selection", file: "goals-b", side: "new", newStart: 4, newEnd: 5, highlight: "- fast\n- safe", body: "Tighten these goals." });
	assert.equal(planSelection.thread.status, "open", "Plan selections anchor on absolute source lines.");
	assert.equal(planStore.postUserTurn({ source: "selection", file: "goals-b", side: "new", newStart: 7, newEnd: 7, highlight: "x", body: "y" }).error, "invalid", "Anchors outside the section's line range are rejected.");
	assert.equal(planStore.postUserTurn({ source: "commentary", file: "goals-b", commentaryId: "g1", body: "Reply to the note." }).thread.status, "open", "Plan section commentary hosts threads.");
	const planHtml = renderReviewHtml(plan, "plan-nonce");
	assert.match(planHtml, /<body[^>]*data-review-kind="plan"/, "Plan pages declare their kind.");
	assert.match(planHtml, /<div class="plan-doc md"><p data-md-line="1" data-md-end="1">Intro line one\.<\/p><\/div>/, "Sections render their markdown segment.");
	assert.match(planHtml, /<li data-md-line="4" data-md-end="4">fast<\/li>/, "Line offsets keep block anchors absolute across sections.");
	assert.match(planHtml, /<h2 data-md-line="3" data-md-end="3">Goals &lt;b&gt;<\/h2>/, "The section's own markdown heading marks it — no header bar exists.");
	assert.doesNotMatch(planHtml, /<header class="file-header">[^]*?status-section/, "Plan sections render without file-review chrome.");
	assert.match(planHtml, /<header class="plan-head"><h1>Test Plan<\/h1><\/header>/, "The document opens with its own rendered title.");
	assert.doesNotMatch(planHtml, /plan-summary|Section summary/, "Plan sections never render summary cards — the document text is the orientation; the rail is for threads.");
	assert.match(planHtml, /Plan sections/, "The sidebar labels plan sections.");
	assert.match(planHtml, /Approval note/, "The approve overlay asks for an approval note, not a commit message.");
	assert.doesNotMatch(planHtml, /<input[^>]*data-viewed-toggle|<div class="viewed-progress"|<span class="viewed-check"|<span class="badge stale-badge"|<p class="approve-stale-warning"/, "Plans ship none of the diff-only machinery, dormant or otherwise.");
	assert.match(planHtml, /<button type="button" data-approve-confirm>Approve plan<\/button>/, "The confirm button speaks plan language.");
	assert.match(planHtml, /class="agent-note-anchor"[^>]*>lines 4–5</, "Plan commentary anchors drop the diff-side vocabulary.");
	assert.match(planHtml, /class="agent-note-anchor"[^>]*>lines 4–5<span class="anchor-preview">- fast<\/span></, "Plan chips quote the first anchored source line from the section markdown.");
	assert.match(planHtml, /3 sections · 13 lines/, "Approve stats describe the document.");
	assert.match(formatReviewPassXml(plan, planStore.list(), planStore.summary(), false, undefined, 1), /^<plan-review-pass [^>]*>[\s\S]*<\/plan-review-pass>$/, "Plan passes speak their own root tag.");
	assert.match(formatReviewApprovedXml(plan, 1, "Ship it", false), /^<plan-review-approved [\s\S]*<approval-note><!\[CDATA\[Ship it\]\]><\/approval-note>[\s\S]*<\/plan-review-approved>$/, "Plan approval carries an approval note.");
	assert.match(formatThreadMessageXml(plan, planSelection.thread, planSelection.thread.turns[0], 1), /^<plan-review-thread /, "Plan threads speak their own root tag.");
	assert.match(renderReviewHtml(buildPlanReview({ title: "T", markdown: "## A\nx", proposedApprovalNote: "Adopt & schedule <it>" }), "n"), /<textarea data-approve-message maxlength="20000">Adopt &amp; schedule &lt;it&gt;<\/textarea>/, "The proposed approval note prefills the approve screen, escaped.");
	assert.throws(() => buildPlanReview({ title: "T", markdown: "## A\nx", proposedApprovalNote: "  " }), /proposedApprovalNote/);
	const dupPlan = buildPlanReview({ title: "x", markdown: "## Same\na\n## Same\nb\n## Other\nc" });
	assert.deepEqual(
		resolvePlanResponses(dupPlan, [
			{ respondsTo: "t1", resolution: "addressed", body: "b", file: "Other", startLine: 6, endLine: 6 },
			{ respondsTo: "t2", resolution: "addressed", body: "b", file: "same" },
			{ respondsTo: "t3", resolution: "addressed", body: "b" },
		]),
		[
			{ respondsTo: "t1", resolution: "addressed", body: "b", file: "other", startLine: 6, endLine: 6, side: "new" },
			{ respondsTo: "t2", resolution: "addressed", body: "b", file: "same" },
			{ respondsTo: "t3", resolution: "addressed", body: "b" },
		],
		"Heading refs resolve to slugs, side is stamped only with lines, slugs of duplicate headings resolve exactly, and anchorless responses pass through.",
	);
	const markdownHtml = renderReviewHtml(applyReviewManifest(snapshot, { files: [{ path: "untracked.txt", summary: "Adds **two** lines", commentary: [{ id: "md-note", body: "Use `x < y` — see [ref](https://example.com)", side: "new", startLine: 1, endLine: 1 }] }] }), "md-nonce");
	assert.match(markdownHtml, /<div class="file-summary md"><p>Adds <strong>two<\/strong> lines<\/p><\/div>/, "File summaries render markdown server-side.");
	assert.match(markdownHtml, /<div class="agent-note-body md"><p>Use <code>x &lt; y<\/code> — see <a href="https:\/\/example\.com"[^>]*rel="noopener noreferrer">ref<\/a><\/p><\/div>/, "Commentary notes render markdown with safe links.");

	assert.equal(applyReviewManifest(snapshot, { files: [], proposedCommitMessage: "Ship the safe review" }).proposedCommitMessage, "Ship the safe review");
	assert.throws(() => applyReviewManifest(snapshot, { files: [], proposedCommitMessage: "   " }), /Proposed commit message/);
	const approvedXml = formatReviewApprovedXml(ordered, 3, "Fix <thing> & close]]>", true);
	assert.match(approvedXml, /^<code-review-approved snapshot="[0-9a-f]{64}" round="3" stale="true">/);
	assert.ok(approvedXml.includes("<commit-message><![CDATA[Fix <thing> & close]]]]><![CDATA[>]]></commit-message>"), "Commit messages are CDATA-safe.");
	assert.ok(formatThreadMessageXml(ordered, { id: "cdata-probe", source: "overview", status: "open", turns: [] }, [{ author: "user", seq: 1, body: "prose ]]> and fenced\n```\n]]>\n```" }], 1).includes("prose ]]]]><![CDATA[> and fenced"), "Thread bodies containing ]]> stay CDATA-safe on the wire.");
	assert.doesNotMatch(formatReviewApprovedXml(ordered, 1, "m", false), / stale=/, "A clean approval carries no stale attribute.");

	const approvals = [];
	let failNextApprove = false;
	let approveFingerprint = "afp-1";
	let approveSnapshotId = ordered.id;
	const approveServer = await createCodeReviewServer({ ...ordered, proposedCommitMessage: "Proposed: safe review" }, {
		onThreadPost: async () => {},
		onFinishPass: async () => ({ stale: false }),
		onApprove: async (round, message, staleNow) => {
			if (failNextApprove) {
				failNextApprove = false;
				throw new Error("approve boom");
			}
			approvals.push({ round: round.number, message, staleNow });
		},
		staleness: { fingerprint: async () => approveFingerprint, snapshot: async () => ({ id: approveSnapshotId, files: [] }) },
	});
	try {
		const origin = new URL(approveServer.url).origin;
		const bootstrap = await fetch(approveServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const headers = { cookie, "content-type": "application/json", origin };
		const approveEndpoint = `${origin}/__pi_code_review_approve__`;
		const approvePage = await (await fetch(origin, { headers: { cookie } })).text();
		assert.match(approvePage, /data-approve hidden/, "The approve button renders in the topbar.");
		assert.match(approvePage, /data-approve-message maxlength="20000">Proposed: safe review</, "The overlay prefills Pi's proposed commit message.");
		assert.match(approvePage, /7 files \(/, "The approve screen shows file stats.");
		// The proposal survives a round that does not re-propose.
		assert.equal(approveServer.addRound({ ...ordered, id: altId(ordered.id, 40) }, ordered.id).round, 2);
		assert.equal(approveServer.currentReview().proposedCommitMessage, "Proposed: safe review", "Rounds without a new proposal inherit the previous commit message.");
		assert.equal((await fetch(approveEndpoint, { method: "POST", headers, body: JSON.stringify({ message: "   " }) })).status, 400, "Approval requires a non-empty commit message.");
		const blockerThread = await (await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ source: "overview", body: "Blocker.", quiet: true }) })).json();
		const blocked = await fetch(approveEndpoint, { method: "POST", headers, body: JSON.stringify({ message: "Ship it" }) });
		assert.equal(blocked.status, 409);
		assert.match(await blocked.text(), /3 threads are still open/, "Open threads block approval — queued threads and unengaged commentary notes included.");
		for (const thread of approveServer.threads().filter((candidate) => candidate.status === "open")) {
			assert.equal((await fetch(`${origin}/__pi_code_review_resolve__`, { method: "POST", headers, body: JSON.stringify({ threadId: thread.id, resolved: true }) })).status, 200);
		}
		assert.equal((await fetch(`${origin}/__pi_code_review_finish__`, { method: "POST", headers, body: "{}" })).status, 200);
		assert.equal((await fetch(approveEndpoint, { method: "POST", headers, body: JSON.stringify({ message: "Ship it" }) })).status, 409, "Approval is rejected while Pi revises.");
		assert.equal((await fetch(`${origin}/__pi_code_review_resume__`, { method: "POST", headers, body: "{}" })).status, 200);
		failNextApprove = true;
		const failed = await fetch(approveEndpoint, { method: "POST", headers, body: JSON.stringify({ message: "Ship it" }) });
		assert.equal(failed.status, 500, "A failed handoff to Pi reports an error.");
		assert.equal((await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ source: "overview", body: "Still alive.", quiet: true }) })).status, 200, "A failed approval reverts to the reviewing phase.");
		const reopened = await (await fetch(origin, { headers: { cookie } })).text();
		assert.match(reopened, /data-phase="reviewing"/);
		const lateBlocker = await fetch(approveEndpoint, { method: "POST", headers, body: JSON.stringify({ message: "Ship it" }) });
		assert.equal(lateBlocker.status, 409, "The revert restores the blocker contract too.");
		const threadsNow = approveServer.threads().filter((thread) => thread.status === "open");
		for (const thread of threadsNow) {
			assert.equal((await fetch(`${origin}/__pi_code_review_resolve__`, { method: "POST", headers, body: JSON.stringify({ threadId: thread.id, resolved: true }) })).status, 200);
		}
		approveFingerprint = "afp-2";
		approveSnapshotId = "drifted-at-approval";
		const eventsResponse = await fetch(`${origin}/__pi_code_review_events__?round=2`, { headers: { cookie } });
		const reader = eventsResponse.body.getReader();
		const decoder = new TextDecoder();
		let sseBuffer = "";
		const readUntil = async (marker) => {
			const deadline = Date.now() + 5_000;
			while (!sseBuffer.includes(marker)) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE marker: ${marker}`);
				const { value, done } = await reader.read();
				if (done) throw new Error("SSE stream ended early.");
				sseBuffer += decoder.decode(value, { stream: true });
			}
		};
		await readUntil("event: init");
		const approvedResponse = await fetch(approveEndpoint, { method: "POST", headers, body: JSON.stringify({ message: "Land the guarded rollout " }) });
		assert.equal(approvedResponse.status, 200);
		assert.deepEqual(await approvedResponse.json(), { approved: true, stale: true }, "Approval re-checks staleness even though the phase already flipped.");
		assert.deepEqual(approvals, [{ round: 2, message: "Land the guarded rollout", staleNow: true }], "Pi receives the trimmed final message with the round and drift verdict.");
		await readUntil('"phase":"approved"');
		const closedText = /approved and closed/;
		const postAfter = await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ source: "overview", body: "late" }) });
		assert.equal(postAfter.status, 409);
		assert.match(await postAfter.text(), closedText, "The terminal phase teaches its own lock message.");
		assert.equal((await fetch(`${origin}/__pi_code_review_resolve__`, { method: "POST", headers, body: JSON.stringify({ threadId: blockerThread.thread.id, resolved: false }) })).status, 409, "Nothing reopens after approval.");
		assert.equal((await fetch(`${origin}/__pi_code_review_finish__`, { method: "POST", headers, body: "{}" })).status, 409);
		assert.equal((await fetch(`${origin}/__pi_code_review_resume__`, { method: "POST", headers, body: "{}" })).status, 409);
		assert.equal((await fetch(`${origin}/__pi_code_review_viewed__`, { method: "POST", headers, body: JSON.stringify({ file: "untracked.txt", viewed: true }) })).status, 409, "The viewed checklist locks with the review.");
		assert.equal((await fetch(approveEndpoint, { method: "POST", headers, body: JSON.stringify({ message: "again" }) })).status, 409, "Approval is idempotent-hostile: once closed, closed.");
		assert.deepEqual(approveServer.addRound({ ...ordered, id: altId(ordered.id, 41) }, altId(ordered.id, 40)), { error: "approved" }, "No round can follow an approval.");
		assert.deepEqual(approveServer.postPiReply(blockerThread.thread.id, "late", false), { error: "approved" }, "Pi replies after approval carry the true reason, not a generic failure.");
		const malformedViewed = await fetch(`${origin}/__pi_code_review_viewed__`, { method: "POST", headers, body: JSON.stringify({ nonsense: true }) });
		assert.equal(malformedViewed.status, 409, "Closed means closed: the terminal 409 outranks payload shape errors.");
		assert.match(await (await fetch(origin, { headers: { cookie } })).text(), /data-phase="approved"/, "Approved pages stay readable.");
		await reader.cancel();
	} finally {
		await approveServer.close();
	}
	console.log("Approval flow passed.");

	let releaseRaceFinish;
	let markRaceFinishEntered;
	const raceFinishEntered = new Promise((resolvePromise) => { markRaceFinishEntered = resolvePromise; });
	const raceServer = await createCodeReviewServer(ordered, {
		onThreadPost: async () => {},
		onFinishPass: async () => {
			markRaceFinishEntered();
			await new Promise((resolvePromise) => { releaseRaceFinish = resolvePromise; });
			return { stale: false };
		},
	});
	try {
		const origin = new URL(raceServer.url).origin;
		const bootstrap = await fetch(raceServer.url, { redirect: "manual" });
		const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0];
		const headers = { cookie, "content-type": "application/json", origin };
		const raceLive = await (await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ source: "overview", body: "Race live." }) })).json();
		assert.equal((await (await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ threadId: raceLive.thread.id, body: "Captured tail.", quiet: true }) })).json()).thread.pending, 1);
		const raceQueued = await (await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ source: "overview", body: "Race queued.", quiet: true }) })).json();
		const finishPromise = fetch(`${origin}/__pi_code_review_finish__`, { method: "POST", headers, body: "{}" });
		await raceFinishEntered;
		assert.equal((await (await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ threadId: raceLive.thread.id, body: "Uncaptured tail.", quiet: true }) })).json()).thread.pending, 2);
		assert.equal((await (await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ threadId: raceQueued.thread.id, body: "Race tail.", quiet: true }) })).json()).thread.pending, 2);
		assert.equal((await fetch(`${origin}/__pi_code_review_approve__`, { method: "POST", headers, body: JSON.stringify({ message: "Racing approval" }) })).status, 409, "Approval must wait out an in-flight finish handoff.");
		assert.equal(raceServer.addRound({ ...ordered, id: altId(ordered.id, 63) }, ordered.id, [{ respondsTo: raceLive.thread.id, resolution: "needs-discussion", body: "Carrying through the race." }]).round, 2, "Pi may open the next round while the finish handoff is in flight; queued threads need no response.");
		const heldRace = raceServer.getThread(raceQueued.thread.id);
		assert.equal(heldRace.heldFrom, 1, "The queued thread is held over, not responded to.");
		assert.equal(heldRace.turns.find((turn) => turn.body === "Race queued.").delivered, true, "Held copies of pass-captured messages import as delivered — the in-flight pass carries them.");
		assert.equal(heldRace.queued, false, "A pass-captured held thread is no longer queued.");
		assert.equal(heldRace.pending, 1, "The uncaptured mid-handoff tail stays pending across the held import.");
		assert.equal(heldRace.turns.find((turn) => turn.body === "Race tail.").delivered, false);
		assert.ok(threadsAwaitingResponse(raceServer.threads()).some((thread) => thread.id === raceQueued.thread.id), "Once the pass delivers it, a held thread joins the next response contract.");
		const carriedRace = raceServer.getThread(raceLive.thread.id);
		assert.equal(carriedRace.pending, 1, "Only the uncaptured mid-handoff tail stays pending in the carried copy.");
		assert.equal(carriedRace.turns.find((turn) => turn.body === "Captured tail.").delivered, true, "The carried copy must not re-deliver what the in-flight pass carries.");
		assert.equal(carriedRace.turns.find((turn) => turn.body === "Uncaptured tail.").delivered, false);
		releaseRaceFinish();
		const finishResponse = await finishPromise;
		assert.equal(finishResponse.status, 200);
		assert.equal((await finishResponse.json()).superseded, true, "A finish that lost to a new round must say so.");
		assert.equal((await fetch(`${origin}/__pi_code_review_post__`, { method: "POST", headers, body: JSON.stringify({ round: 2, source: "overview", body: "fresh" }) })).status, 200, "A round opened during the finish handoff must not be born locked.");
	} finally {
		releaseRaceFinish?.();
		await raceServer.close();
	}

	const browserCandidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
	let executablePath;
	for (const candidate of browserCandidates) {
		try { await access(candidate); executablePath = candidate; break; } catch {}
	}
	if (executablePath) {
		const browserPosts = [];
		let browserPass;
		const browserServer = await createCodeReviewServer(ordered, {
			onThreadPost: async (round, thread, turns) => { browserPosts.push({ thread, turn: turns[0] }); },
			onFinishPass: async (round, note, threadList, summary) => { browserPass = { round: round.number, note, threadList, summary }; return { stale: false }; },
		});
		const browser = await puppeteer.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
		try {
			const page = await browser.newPage();
			await page.goto(browserServer.url, { waitUntil: "domcontentloaded" });
			assert.equal(await page.$eval('[data-review-overview]', (section) => section.hidden), false, "Agent-guided reviews should open on the overview.");
			const staleBadgeColors = await page.evaluate(() => {
				const warningProbe = document.createElement("span");
				warningProbe.style.color = "var(--warning)";
				const genericProbe = document.createElement("span");
				genericProbe.className = "badge";
				document.body.append(warningProbe, genericProbe);
				const colors = {
					badge: getComputedStyle(document.querySelector('[data-stale-badge]')).color,
					warning: getComputedStyle(warningProbe).color,
					generic: getComputedStyle(genericProbe).color,
				};
				warningProbe.remove();
				genericProbe.remove();
				return colors;
			});
			assert.equal(staleBadgeColors.badge, staleBadgeColors.warning, "The stale badge must keep its warning tint over the generic badge rule, in whichever color scheme the harness resolves.");
			assert.notEqual(staleBadgeColors.badge, staleBadgeColors.generic, "The warning tint must stay distinguishable from generic badge grey.");
			const themeProbe = () => page.evaluate(() => {
				const probe = document.createElement("span");
				probe.style.color = "var(--ok)";
				probe.style.backgroundColor = "var(--mark)";
				document.body.append(probe);
				const ok = getComputedStyle(probe).color;
				const mark = getComputedStyle(probe).backgroundColor;
				probe.remove();
				return {
					ok,
					mark,
					highlight: getComputedStyle(document.querySelector(".diff-code span"), "::highlight(pi-code-review-feedback)").backgroundColor,
					approve: getComputedStyle(document.querySelector("[data-approve]")).backgroundColor,
					background: getComputedStyle(document.body).backgroundColor,
				};
			});
			const lightTheme = await themeProbe();
			assert.equal(lightTheme.approve, lightTheme.ok, "The approve button follows the scheme-aware ok color.");
			assert.equal(lightTheme.highlight, lightTheme.mark, "var() must resolve inside the ::highlight pseudo-element.");
			await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
			const darkTheme = await themeProbe();
			assert.equal(darkTheme.approve, darkTheme.ok, "The approve button follows --ok in dark mode too.");
			assert.equal(darkTheme.highlight, darkTheme.mark, "The selection mark follows --mark in dark mode too.");
			assert.notEqual(darkTheme.ok, lightTheme.ok, "Dark mode resolves its own ok color, not light's.");
			assert.notEqual(darkTheme.highlight, lightTheme.highlight, "The selection mark changes with the scheme.");
			assert.notEqual(darkTheme.background, lightTheme.background, "The page background follows the OS scheme.");
			await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
			// Slate is the default palette; the picker swaps live, forces a scheme,
			// and persists across reloads via the pre-paint head script.
			const rootAccent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
			assert.equal(await rootAccent(), "#a04e24", "Slate is the default theme.");
			await page.$eval("[data-theme-picker]", (select) => { select.value = "manuscript"; select.dispatchEvent(new Event("change")); });
			assert.equal(await rootAccent(), "#8a4f2d", "The theme picker swaps palettes live.");
			await page.$eval("[data-scheme-picker]", (select) => { select.value = "dark"; select.dispatchEvent(new Event("change")); });
			assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(25, 21, 18)", "Forced dark beats the light OS scheme.");
			await page.reload({ waitUntil: "domcontentloaded" });
			assert.equal(await page.evaluate(() => document.documentElement.dataset.theme + "/" + document.documentElement.dataset.scheme), "manuscript/dark", "The choice persists across reloads before first paint.");
			await page.evaluate(() => { localStorage.removeItem("picr-theme"); localStorage.removeItem("picr-scheme"); });
			await page.reload({ waitUntil: "domcontentloaded" });
			assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "slate", "Clearing the stored choice restores the default.");
			await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
			await page.$eval("[data-scheme-picker]", (select) => { select.value = "light"; select.dispatchEvent(new Event("change")); });
			assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(247, 248, 248)", "Forced light beats the dark OS scheme on every auto-dark guard.");
			await page.evaluate(() => localStorage.removeItem("picr-scheme"));
			await page.$eval("[data-scheme-picker]", (select) => { select.value = "auto"; select.dispatchEvent(new Event("change")); });
			await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
			assert.equal(await page.$eval('details.reference-files', (details) => details.open), false, "Reference files should start collapsed.");
			await page.waitForFunction(() => document.querySelector('[data-thread-tally]')?.hidden === false);
			assert.match(await page.$eval('[data-thread-tally]', (section) => section.textContent), /2 open.*2 awaiting you.*0 awaiting Pi.*0 resolved/, "Seeded notes count uniformly from the start.");
			assert.equal(await page.$eval('[data-inbox]', (strip) => strip.hidden), false, "Unread notes surface in the inbox immediately.");
			assert.match(await page.$eval('[data-inbox]', (strip) => strip.textContent), /^2 awaiting you/);
			await page.keyboard.press("]");
			await page.waitForFunction(() => document.querySelector('[data-review-file="0"]')?.hidden === false);
			await page.$eval('[data-review-file="0"] .agent-note-anchor:not(:disabled)', (button) => button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
			assert.equal(await page.evaluate(() => document.querySelectorAll('[data-review-file="0"] tr.note-target').length), 2, "Hovering a note tints exactly its anchored rows.");
			assert.equal(await page.evaluate(() => {
				const row = document.querySelector('[data-review-file="0"] tr.note-target');
				const tint = getComputedStyle(row.cells[1]).boxShadow;
				const edge = getComputedStyle(row.cells[0]).boxShadow;
				return tint.includes("999px") && edge.split("inset").length === 3;
			}), true, "Hovered anchor rows carry a background tint plus an accent left border.");
			await page.$eval('[data-review-file="0"] .agent-note-anchor:not(:disabled)', (button) => button.click());
			assert.equal(await page.evaluate(() => document.querySelectorAll('[data-review-file="0"] tr.anchor-flash').length), 2, "Clicking a note anchor flashes its lines.");
			await page.keyboard.press("j");
			assert.ok(await page.$('[data-review-file="0"] tr.nav-cursor[data-kind="hunk"]'), "j must ring the first hunk of the file ] opened.");
			await page.keyboard.press("o");
			await page.waitForFunction(() => document.querySelector("[data-review-overview]")?.hidden === false);
			assert.equal(await page.$('.nav-cursor'), null, "Leaving the file clears the hunk focus ring.");
			await page.keyboard.press("n");
			await page.waitForFunction(() => document.querySelector('[data-review-file="0"]')?.hidden === false);
			assert.ok(await page.$('.agent-note.thread-flash[data-commentary-id="new-file"]'), "n must reach unresolved Pi notes when no thread awaits.");
			await page.waitForFunction(() => document.querySelectorAll('tr.anchor-flash').length > 0, { polling: 100 });
			assert.equal(await page.evaluate(() => document.querySelectorAll('tr.anchor-flash').length), 2, "Thread navigation lands the code on the anchored lines and flashes them.");
			await page.keyboard.press("n");
			assert.ok(await page.$('.agent-note.thread-flash[data-commentary-id="second-note"]'), "n must cycle through the remaining unresolved notes.");
			assert.equal(await page.$('.agent-note.thread-flash[data-commentary-id="new-file"]'), null, "Only the current navigation target should be highlighted.");
			await page.keyboard.press("N");
			assert.ok(await page.$('.agent-note.thread-flash[data-commentary-id="new-file"]'), "Shift+n must step backwards through the awaiting queue.");
			await page.click('[data-overview-nav]');
			await page.click('details.reference-files > summary');
			const referenceIndex = await page.$eval('details.reference-files [data-file-nav]', (item) => Number(item.dataset.fileNav));
			// DOM click: a coordinate click can miss while the just-opened details
			// element is still settling, and the assertion targets the handler.
			await page.$eval(`[data-file-nav="${referenceIndex}"]`, (item) => item.click());
			assert.equal(await page.$eval(`[data-file-nav="${referenceIndex}"]`, (item) => item.classList.contains("active")), true, "Clicking a regrouped reference file should activate its own navigation item.");
			assert.equal(await page.$eval(`[data-review-file="${referenceIndex}"]`, (section) => section.dataset.reviewMode), "reference", "Reference files should remain directly inspectable.");
			assert.equal(await page.$eval(`[data-review-file="${referenceIndex}"] .file-header-side > span`, (label) => label.textContent), "Reference file");
			await page.click('[data-file-nav="0"]');
			// Cards announce reply-state height changes so rail layout can track them.
			await page.evaluate(() => {
				window.__cardsResized = [];
				document.addEventListener("marginalia:cards-resized", (event) => window.__cardsResized.push(event.target.dataset.threadCard));
			});
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
			await page.waitForFunction(() => document.querySelector('[data-review-file="0"] [data-selection-threads] .thread-card'));
			assert.equal(await page.$eval('[data-review-file="0"] [data-selection-composer]', (composer) => composer.hidden), true, "Command+Enter should post the comment thread without finishing the pass.");
			assert.equal(await page.evaluate(() => CSS.highlights.get("pi-code-review-feedback")?.size), 1);
			assert.equal(browserPosts.length, 1, "Posting a selection comment must deliver one thread message to Pi.");
			assert.equal(browserPosts[0].thread.file, "untracked.txt");
			assert.equal(browserPosts[0].thread.side, "new");
			assert.equal(browserPosts[0].turn.body, "Please rename this.");
			const liveThreadId = browserPosts[0].thread.id;
			await page.waitForFunction((id) => document.querySelector(`[data-thread-card="${id}"] [data-reply-state]`), {}, liveThreadId);
			assert.equal(await page.$eval(`[data-thread-card="${liveThreadId}"] [data-reply-state]`, (line) => line.dataset.replyState + "|" + line.textContent), "working|Pi is working\u2026", "A delivered live comment shows the working status line at the bottom of its card.");
			assert.ok(await page.evaluate((id) => window.__cardsResized.includes(id), liveThreadId), "The appearing status line dispatches marginalia:cards-resized on its card.");
			browserServer.postPiReply(liveThreadId, "Because generated names collide.", true);
			await page.waitForFunction(() => document.querySelector('.thread-card.awaiting .thread-turn.turn-pi'));
			assert.equal(await page.$(`[data-thread-card="${liveThreadId}"] [data-reply-state]`), null, "Pi's reply clears the status line \u2014 the reply itself is the indicator.");
			assert.ok(await page.evaluate((id) => window.__cardsResized.filter((card) => card === id).length >= 2, liveThreadId), "The disappearing status line dispatches marginalia:cards-resized again.");
			assert.equal(await page.$eval('[data-inbox]', (strip) => strip.hidden), false, "Pi replies must surface the awaiting-you inbox strip.");
			assert.match(await page.$eval('[data-inbox]', (strip) => strip.textContent), /^3 awaiting you/);
			assert.equal(await page.$eval('[data-file-nav="0"] [data-unread-badge]', (badge) => badge.hidden), false, "Sidebar files must show awaiting-you thread counts.");
			assert.equal(await page.$eval('[data-file-nav="0"] [data-unread-badge]', (badge) => badge.textContent), "3");
			await page.click('[data-overview-nav]');
			await page.keyboard.press("n");
			await page.keyboard.press("n");
			await page.waitForFunction(() => document.querySelector('[data-review-file="0"]')?.hidden === false);
			assert.ok(await page.$(`[data-thread-card="${liveThreadId}"].thread-flash`), "Pressing n must jump to the next thread awaiting the reviewer.");
			assert.ok(await page.$('[data-thread-accept-resolve]'), "Pi's resolution proposal should render an accept control.");
			await page.keyboard.press("?");
			assert.equal(await page.$eval('[data-shortcuts-overlay]', (overlay) => overlay.hidden), false, "? must open the shortcuts guide from navigation focus.");
			await page.keyboard.press("e");
			assert.equal(await page.$('.thread-card.resolved'), null, "Keys must be inert while the shortcuts guide is open.");
			await page.keyboard.press("Escape");
			assert.equal(await page.$eval('[data-shortcuts-overlay]', (overlay) => overlay.hidden), true, "Escape must close the shortcuts guide.");
			await page.keyboard.press("e");
			await page.waitForFunction(() => document.querySelector('.thread-card.resolved'));
			assert.match(await page.$eval('[data-inbox]', (strip) => strip.textContent), /^2 awaiting you/, "Unread notes keep the inbox active after a thread resolution.");
			await page.keyboard.press("e");
			assert.match(await page.$eval('[data-global-status]', (statusEl) => statusEl.textContent), /already resolved/, "Resolving an already-resolved current thread is a safe no-op.");
			// Idle composers collapse behind their Reply… affordance; expand first.
			await page.$eval('[data-commentary-composer="new-file"] [data-composer-expand]', (button) => button.click());
			await page.type('[data-review-file="0"] [data-commentary-reply="new-file"]', "Why not generate this?");
			await page.click('[data-commentary-post="new-file"]');
			await page.waitForFunction(() => document.querySelector('[data-commentary-thread="new-file"] .thread-card'));
			assert.equal(await page.$eval('[data-commentary-composer="new-file"]', (composer) => composer.hidden), true, "The commentary composer should collapse into its live thread.");
			assert.doesNotMatch(await page.$eval('[data-commentary-thread="new-file"] .thread-card', (card) => card.textContent), /Why this exists/, "Commentary threads must not duplicate Pi's rendered note.");
			const commentaryThreadId = browserPosts.find((post) => post.thread.source === "commentary").thread.id;
			browserServer.postPiReply(commentaryThreadId, "It stays handwritten for clarity.", false);
			await page.waitForFunction((id) => document.querySelector(`[data-thread-card="${id}"] .thread-turn.turn-pi`), {}, commentaryThreadId);
			await page.$eval(`[data-thread-card="${commentaryThreadId}"] [data-composer-expand]`, (button) => button.click());
			await page.type(`[data-thread-card="${commentaryThreadId}"] [data-thread-reply]`, "Good, keep it handwritten.");
			await page.click(`[data-thread-card="${commentaryThreadId}"] [data-thread-send]`);
			await page.waitForFunction((id) => document.querySelectorAll(`[data-thread-card="${id}"] .thread-turn`).length === 3, {}, commentaryThreadId);
			assert.equal(await page.$eval(`[data-thread-card="${commentaryThreadId}"] [data-thread-reply]`, (textarea) => textarea.value), "", "Sending a thread reply must clear its draft.");
			assert.match(await page.$eval('[data-inbox]', (strip) => strip.textContent), /^1 awaiting you/, "After replying, only the unread note remains awaiting.");
			// Pi's turn ends without answering the fresh reply: the honest terminal
			// state is a subtle Seen tick, never a stranded spinner.
			browserServer.markTurnEnd();
			await page.waitForFunction((id) => document.querySelector(`[data-thread-card="${id}"] [data-reply-state="seen"]`), {}, commentaryThreadId);
			assert.equal(await page.$eval(`[data-thread-card="${commentaryThreadId}"] [data-reply-state]`, (line) => line.textContent), "\u2713Seen", "A turn that ends without a reply renders the Seen tick line.");
			await page.$eval('[data-commentary-composer="second-note"] [data-composer-expand]', (button) => button.click());
			await page.click('[data-commentary-resolve="second-note"]');
			await page.waitForFunction(() => document.querySelector('[data-commentary-thread="second-note"] .thread-card.resolved'));
			assert.equal(browserPosts.length, 3, "Resolving a note must not message Pi.");
			assert.equal(await page.$eval('[data-inbox]', (strip) => strip.hidden), true, "Resolving the last unread note clears the inbox.");
			// The resolved card is compact; its Reopen control lives behind the toggle,
			// and the enclosing note clamps its own body while compact.
			assert.equal(await page.$eval('[data-commentary-thread="second-note"]', (host) => host.closest(".agent-note")?.classList.contains("resolved-collapsed") ?? false), true, "A resolved commentary thread clamps its note body to one line.");
			await page.click('[data-commentary-thread="second-note"] [data-resolved-toggle]');
			assert.equal(await page.$eval('[data-commentary-thread="second-note"]', (host) => host.closest(".agent-note")?.classList.contains("resolved-collapsed") ?? false), false, "Expanding the resolved row unclamps the note body.");
			await page.click('[data-commentary-thread="second-note"] [data-thread-resolve]');
			await page.waitForFunction(() => !document.querySelector('[data-commentary-thread="second-note"] .thread-card'));
			assert.equal(await page.$eval('[data-commentary-composer="second-note"]', (composer) => composer.hidden === false && composer.classList.contains("collapsed")), true, "Reopening an untouched note removes its card and restores the composer collapsed.");
			assert.match(await page.$eval('[data-inbox]', (strip) => strip.textContent), /^1 awaiting you/, "A reopened note awaits the reviewer again.");
			await page.$eval('[data-commentary-composer="second-note"] [data-composer-expand]', (button) => button.click());
			await page.click('[data-commentary-resolve="second-note"]');
			await page.waitForFunction(() => document.querySelector('[data-commentary-thread="second-note"] .thread-card.resolved'));
			assert.equal(await page.$eval('[data-inbox]', (strip) => strip.hidden), true, "Re-resolving the note clears the inbox again.");
			await page.click('[data-overview-nav]');
			await page.type('[data-overview-feedback]', "Keep the introduction quick.");
			await page.click('[data-overview-post]');
			await page.waitForFunction(() => document.querySelector('[data-overview-thread] .thread-card'));
			assert.equal(await page.$eval('[data-overview-composer]', (composer) => composer.hidden), false, "The overview composer must stay available for new topics.");
			await page.type('[data-overview-feedback]', "Second topic.");
			await page.click('[data-overview-post]');
			await page.waitForFunction(() => document.querySelectorAll('[data-overview-thread] .thread-card').length === 2, {}, undefined);
			assert.match(await page.$eval('[data-thread-tally]', (section) => section.textContent), /3 open.*0 awaiting you.*3 awaiting Pi.*2 resolved/, "The tally must aggregate live thread states uniformly.");
			await page.focus('[data-overview-feedback]');
			await page.type('[data-overview-feedback]', "Draft kept.");
			assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
			await page.keyboard.press("Escape");
			assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "Escape must blur the composer for keyboard navigation.");
			assert.equal(await page.$eval('[data-overview-feedback]', (textarea) => textarea.value), "Draft kept.", "Escape must keep the in-progress draft.");
			await page.keyboard.press("?");
			assert.equal(await page.$eval('[data-shortcuts-overlay]', (overlay) => overlay.hidden), false, "? must open the shortcuts guide.");
			await page.keyboard.press("?");
			assert.equal(await page.$eval('[data-shortcuts-overlay]', (overlay) => overlay.hidden), true, "? must also close the shortcuts guide.");
			await page.click('[data-file-nav="0"]');
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
			const secondReviewIndex = await page.$$eval('.file-sidebar > [data-file-nav]', (items) => Number(items[1].dataset.fileNav));
			const mainFlowDialogs = [];
			const recordMainDialog = (dialog) => {
				mainFlowDialogs.push(dialog.message());
				dialog.dismiss().catch(() => {});
			};
			page.on("dialog", recordMainDialog);
			await page.click(`[data-file-nav="${secondReviewIndex}"]`);
			assert.equal(await page.$eval(`[data-review-file="${secondReviewIndex}"]`, (section) => section.hidden), false, "Navigation with an open draft proceeds without asking.");
			assert.equal(mainFlowDialogs.length, 0, "No dialog fires for draft-crossing navigation.");
			assert.equal(await page.$eval('[data-review-file="0"] [data-selection-composer]', (composer) => composer.hidden), false, "The draft survives the navigation in its own section.");
			assert.equal(await page.evaluate(() => {
				const dots = [...document.querySelectorAll("[data-draft-dot]:not([hidden])")];
				return dots.length === 1 && dots[0].dataset.draftDot === document.querySelector('[data-review-file="0"]').dataset.path;
			}), true, "The sidebar pencil marks the file holding the open draft.");
			assert.equal(await page.$eval(`[data-file-nav="${secondReviewIndex}"]`, (item) => item.classList.contains("active")), true, "Regrouped primary navigation should activate by file index rather than DOM position.");
			page.off("dialog", recordMainDialog);
			// Clear the draft through its own Cancel so the send modal opens cleanly.
			await page.evaluate(() => document.querySelector('[data-review-file="0"] [data-selection-composer] [data-selection-cancel]').click());
			await page.waitForFunction(() => document.querySelectorAll("[data-draft-dot]:not([hidden])").length === 0, { polling: 100 });
			// The send-round confirmation is a keyboard-first modal, not a native
			// dialog: Enter confirms (the confirm button holds focus), Esc cancels.
			await page.click("[data-finish]");
			await page.waitForFunction(() => document.querySelector("[data-finish-overlay]")?.hidden === false);
			assert.match(await page.$eval("[data-finish-summary]", (summary) => summary.textContent), /3 open threads/, "The send modal counts open threads.");
			await page.keyboard.press("Escape");
			assert.equal(await page.$eval("[data-finish-overlay]", (overlay) => overlay.hidden), true, "Esc cancels the send modal.");
			await page.click("[data-finish]");
			await page.waitForFunction(() => document.querySelector("[data-finish-overlay]")?.hidden === false);
			await page.$eval("[data-finish-overlay]", (overlay) => overlay.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			assert.equal(await page.$eval("[data-finish-overlay]", (overlay) => overlay.hidden), true, "A backdrop click cancels the send modal.");
			await page.keyboard.down("Meta");
			await page.keyboard.down("Shift");
			await page.keyboard.press("Enter");
			await page.keyboard.up("Shift");
			await page.keyboard.up("Meta");
			await page.waitForFunction(() => document.querySelector("[data-finish-overlay]")?.hidden === false);
			assert.equal(await page.evaluate(() => document.activeElement?.dataset.finishConfirm !== undefined), true, "The confirm button holds focus so Enter sends.");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector('[data-phase-banner]')?.hidden === false);
			assert.ok(browserPass, "Finishing the pass must hand the summary to Pi.");
			assert.equal(browserPass.round, 1);
			assert.deepEqual(browserPass.summary, { open: 3, awaitingUser: 0, awaitingPi: 3, resolved: 2 });
			assert.equal(await page.evaluate(() => document.body.classList.contains("locked")), false, "Sending the pass opens the quiet window, not a lock.");
			assert.equal(await page.evaluate(() => document.body.classList.contains("quiet-only")), true, "The revising window is quiet-only.");
			assert.match(await page.$eval('[data-phase-banner-text]', (el) => el.textContent), /Pi is revising — round 2 pending\. New comments queue for the next round; to post live on this round, resume it\./);
			assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-finish]')).display), "none", "The pass control hides while Pi revises.");
			await page.click('[data-resume]');
			await page.waitForFunction(() => document.querySelector('[data-phase-banner]')?.hidden === true);
			assert.equal(await page.evaluate(() => document.body.classList.contains("quiet-only")), false, "Resume must reopen live posting.");

			const browserOrigin = new URL(browserServer.url).origin;
			const nextRoundReview = { ...ordered, id: altId(ordered.id, 63) };
			const overviewThreadIds = browserPosts.filter((post) => post.thread.source === "overview").map((post) => post.thread.id);
			assert.equal(browserServer.addRound(nextRoundReview, ordered.id).error, "invalid-responses", "The next round must respond to every open thread.");
			assert.equal(browserServer.addRound(nextRoundReview, ordered.id, [
				{ respondsTo: commentaryThreadId, resolution: "addressed", body: "Kept handwritten; clarified the comment.", file: "untracked.txt", side: "new", startLine: 1, endLine: 2 },
				{ respondsTo: overviewThreadIds[0], resolution: "declined", body: "Keeping the introduction as is.", file: "untracked.txt" },
				{ respondsTo: overviewThreadIds[1], resolution: "needs-discussion", body: "Needs a synchronous decision." },
			]).round, 2);
			await page.waitForFunction(() => document.body.dataset.round === "2", { timeout: 5_000 });
			assert.match(await page.$eval('[data-round-chip]', (chip) => chip.textContent), /round 2/, "round-ready must auto-advance the browser to the new round.");
			assert.equal(await page.$$eval('[data-round-switcher] a', (links) => links.length), 2, "The round switcher must list every round.");
			assert.equal(await page.evaluate(() => document.body.classList.contains("locked")), false, "The new round opens unlocked.");
			await page.waitForFunction(() => document.querySelectorAll('[data-carried-thread]').length === 3);
			assert.equal(await page.$$eval('[data-review-file="0"] .carried-threads [data-carried-thread]', (shells) => shells.length), 2, "File-designated responses land in that file's commentary column.");
			assert.equal(await page.$$eval('.overview-feedback [data-carried-thread]', (shells) => shells.length), 1, "A responded overview thread carries home to General feedback.");
			assert.equal(await page.$('[data-outdated-threads]'), null, "Nothing with a live home renders as outdated.");
			{
				// The reported trap: an overview thread carried to a FILE anchor must
				// be reachable by n-navigation at the file, not hunted for on the
				// overview page where it no longer lives.
				let found = false;
				for (let hop = 0; hop < 6 && !found; hop++) {
					await page.click('[data-inbox]');
					found = await page.evaluate((id) => Boolean(document.querySelector(`[data-carried-thread="${id}"] .thread-flash, [data-carried-thread="${id}"].thread-flash, [data-thread-card="${id}"].thread-flash`)), overviewThreadIds[0]);
				}
				assert.ok(found, "Thread navigation reaches the carried overview thread.");
				assert.equal(await page.$eval('[data-review-file="0"]', (section) => section.hidden), false, "Navigation lands on the file that now hosts it.");
				assert.ok(await page.$(`[data-carried-host="${overviewThreadIds[0]}"] [data-thread-resolve]`), "The carried copy is resolvable where navigation landed.");
			}
			await page.waitForFunction(() => document.querySelector('[data-inbox]')?.textContent.startsWith("5 awaiting you"), { timeout: 5_000 });
			await page.click('[data-file-nav="0"]');
			await page.waitForFunction((id) => document.querySelector(`[data-carried-host="${id}"] [data-thread-card="${id}"]`), {}, commentaryThreadId);
			assert.match(await page.$eval(`[data-carried-host="${commentaryThreadId}"]`, (host) => host.textContent), /Kept handwritten; clarified the comment\./, "The resolution commentary renders inside the carried thread.");
			assert.match(await page.$eval(`[data-carried-host="${commentaryThreadId}"]`, (host) => host.textContent), /Why not generate this\?/, "The carried thread keeps its full prior conversation.");
			assert.equal(await page.$eval(`[data-carried-thread="${commentaryThreadId}"] .carried-origin`, (link) => link.getAttribute("href")), `/round/1#thread=${commentaryThreadId}`, "Carried threads deep-link to their origin round.");
			await page.click(`[data-carried-host="${commentaryThreadId}"] [data-thread-accept-resolve]`);
			await page.waitForFunction((id) => document.querySelector(`[data-carried-host="${id}"] .thread-card.resolved`), {}, commentaryThreadId);
			assert.match(await page.evaluate(() => window.location.hash), new RegExp(`thread=${commentaryThreadId}`), "Focusing a thread must record it in the URL fragment.");
			await page.goto(`${browserOrigin}/round/1#thread=${commentaryThreadId}`, { waitUntil: "domcontentloaded" });
			await page.waitForFunction(() => document.body.dataset.round === "1");
			await page.waitForFunction((id) => document.querySelector(`[data-thread-card="${id}"].thread-flash`), {}, commentaryThreadId);
			assert.equal(await page.$eval('[data-review-file="0"]', (section) => section.hidden), false, "The origin deep link must open the thread's file section.");
			await page.goBack();
			await page.waitForFunction(() => document.body.dataset.round === "2");
			await page.waitForFunction((id) => document.querySelector(`[data-thread-card="${id}"].thread-flash`), {}, commentaryThreadId);
			assert.equal(await page.$eval('[data-review-file="0"]', (section) => section.hidden), false, "Browser Back must return to the carried thread, not the round's overview.");
			await page.goto(`${browserOrigin}/round/1`, { waitUntil: "domcontentloaded" });
			await page.waitForFunction(() => document.body.classList.contains("locked"));
			assert.match(await page.$eval('[data-phase-banner-text]', (el) => el.textContent), /Round 1 is read-only — round 2 is current/);
			assert.equal(await page.$eval('[data-goto-current]', (link) => link.hidden), false, "Superseded rounds must link to the current round.");
			await page.waitForFunction(() => document.querySelectorAll('[data-overview-thread] .thread-card').length === 2);
			assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-finish]')).display), "none", "Superseded rounds never offer posting controls.");

			const driftPage = await browser.newPage();
			await driftPage.setRequestInterception(true);
			let grabEvents;
			const eventsHeld = new Promise((resolvePromise) => { grabEvents = resolvePromise; });
			driftPage.on("request", (request) => {
				if (grabEvents && request.url().includes("/__pi_code_review_events__")) {
					const grab = grabEvents;
					grabEvents = undefined;
					grab(request);
					return;
				}
				request.continue().catch(() => {});
			});
			await driftPage.goto(`${browserOrigin}/round/2`, { waitUntil: "domcontentloaded" });
			const heldEvents = await eventsHeld;
			const round3Responses = browserServer.threads().filter((thread) => thread.status === "open" && thread.turns.some((turn) => turn.author === "user" && turn.delivered === true)).map((thread) => ({ respondsTo: thread.id, resolution: "needs-discussion", body: "Carrying into round 3." }));
			assert.equal(browserServer.addRound({ ...ordered, id: altId(ordered.id, 62) }, nextRoundReview.id, round3Responses).round, 3, "The session advances while the drift tab is disconnected.");
			heldEvents.continue().catch(() => {});
			await driftPage.waitForFunction(() => document.body.dataset.round === "3", { timeout: 5_000 });
			assert.match(await driftPage.$eval('[data-round-chip]', (chip) => chip.textContent), /round 3/, "A current-round tab that slept through round-ready must catch up on reconnect.");
			await driftPage.close();

			const plainDeliveries = [];
			const plainApprovals = [];
			const plainServer = await createCodeReviewServer(plainReview, { onThreadPost: async (round, thread, turns) => { plainDeliveries.push(turns); }, onFinishPass: async () => ({ stale: false }), onApprove: async (round, message, staleNow) => { plainApprovals.push({ round: round.number, message, staleNow }); } });
			try {
				const plainPage = await browser.newPage();
				await plainPage.goto(plainServer.url, { waitUntil: "domcontentloaded" });
				assert.equal(await plainPage.$eval(".review-file.active", (section) => section.dataset.reviewMode), "review", "Overview-free reviews must open on a primary review file.");
				await plainPage.evaluate(() => {
					const code = document.querySelector(".review-file.active tr.diff-add .diff-code span, .review-file.active tr.diff-del .diff-code span, .review-file.active tr.diff-context .diff-code span");
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges(); selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector(".review-file.active [data-selection-composer]")?.hidden === false);
				await plainPage.click(".review-file.active [data-selection-cancel]");
				assert.equal(await plainPage.$eval(".review-file.active [data-selection-composer]", (composer) => composer.hidden), true, "Cancel must hide the visible file's composer even when file 0 is a reference.");
				await plainPage.evaluate(() => {
					const code = document.querySelector(".review-file.active tr.diff-add .diff-code span, .review-file.active tr.diff-del .diff-code span, .review-file.active tr.diff-context .diff-code span");
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges(); selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector(".review-file.active [data-selection-composer]")?.hidden === false);
				await plainPage.type(".review-file.active [data-selection-feedback]", "Quiet nit.");
				await plainPage.$eval(".review-file.active [data-selection-feedback]", (textarea) => {
					textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector(".thread-card.queued"));
				assert.equal(plainDeliveries.length, 0, "Shift+Command+Enter must not message Pi.");
				assert.equal(await plainPage.$eval("[data-finish-overlay]", (overlay) => overlay.hidden), true, "A composer ⇧⌘⏎ quiet-adds only — the textarea guard must keep it from opening the send modal.");
				assert.match(await plainPage.$eval(".thread-card.queued .thread-status", (label) => label.textContent), /Queued for round/);
				assert.equal(await plainPage.$eval("[data-finish]", (button) => button.textContent), "Send round to Pi (1 to send)", "The send button must count queued threads.");
				await plainPage.$eval(".thread-card.queued [data-composer-expand]", (button) => button.click());
				await plainPage.type(".thread-card.queued [data-thread-reply]", "Answer now please.");
				await plainPage.click(".thread-card.queued [data-thread-send]");
				await plainPage.waitForFunction(() => !document.querySelector(".thread-card.queued"));
				assert.equal(plainDeliveries.length, 1, "A live reply escalates with exactly one delivery.");
				assert.equal(plainDeliveries[0].length, 2, "Escalation must deliver both reviewer messages.");
				assert.equal(await plainPage.$eval("[data-finish]", (button) => button.textContent), "Send round to Pi", "Escalation must clear the queued count.");
				await plainPage.$eval(".thread-card [data-thread-reply]", (textarea) => {
					textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
				});
				await plainPage.$eval(".thread-card [data-composer-expand]", (button) => button.click());
				await plainPage.type(".thread-card [data-thread-reply]", "Mouse follow-up.");
				await plainPage.click(".thread-card [data-thread-send]");
				await plainPage.waitForFunction(() => document.querySelectorAll(".thread-card .thread-turn").length >= 3);
				assert.equal(plainDeliveries.length, 2, "The mouse click must deliver immediately.");
				assert.equal(plainDeliveries[1].length, 1, "A discarded quiet keystroke must not leak into a later mouse click.");
				assert.equal(await plainPage.$(".thread-card.queued"), null, "Mouse clicks always post live.");
				await plainPage.$eval(".thread-card [data-composer-expand]", (button) => button.click());
				await plainPage.type(".thread-card [data-thread-reply]", "Pending tail.");
				await plainPage.$eval(".thread-card [data-thread-reply]", (textarea) => {
					textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector(".thread-card.pending"));
				assert.match(await plainPage.$eval(".thread-card.pending .thread-status", (label) => label.textContent), /1 pending for round/);
				assert.equal(await plainPage.$eval("[data-finish]", (button) => button.textContent), "Send round to Pi (1 to send)", "Pending messages count toward the round send.");
				assert.equal(plainDeliveries.length, 2, "Pending replies on live threads must not message Pi.");
				await plainPage.click(".thread-card.pending [data-turn-send]");
				await plainPage.waitForFunction(() => !document.querySelector(".thread-card.pending"));
				assert.equal(plainDeliveries.length, 3, "Send now delivers to Pi.");
				assert.equal(plainDeliveries[2].length, 1, "Send now delivered exactly the pending message.");
				assert.equal(await plainPage.$eval("[data-finish]", (button) => button.textContent), "Send round to Pi", "Send now clears the pending count.");
				// The active file's only selectable line already hosts the escalated
				// thread's highlight and overlapping selections are rejected, so run the
				// amend flow in a different review file.
				const otherIndex = await plainPage.evaluate(() => {
					const target = [...document.querySelectorAll("[data-review-file]")].find((section) => !section.classList.contains("active") && section.dataset.reviewMode === "review" && section.querySelector("tr.diff-add .diff-code span, tr.diff-del .diff-code span, tr.diff-context .diff-code span"));
					return target ? Number(target.dataset.reviewFile) : -1;
				});
				assert.notEqual(otherIndex, -1, "The fixture needs a second selectable review file.");
				await plainPage.click(`[data-file-nav="${otherIndex}"]`);
				await plainPage.evaluate(() => {
					const code = document.querySelector(".review-file.active tr.diff-add .diff-code span, .review-file.active tr.diff-del .diff-code span, .review-file.active tr.diff-context .diff-code span");
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges(); selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector(".review-file.active [data-selection-composer]")?.hidden === false);
				await plainPage.type(".review-file.active [data-selection-feedback]", "Editable nit.");
				await plainPage.$eval(".review-file.active [data-selection-feedback]", (textarea) => {
					textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector(".thread-card.queued [data-turn-edit]"));
				await plainPage.$eval(".thread-card.queued [data-composer-expand]", (button) => button.click());
				await plainPage.type(".thread-card.queued [data-thread-reply]", "Second nit.");
				await plainPage.$eval(".thread-card.queued [data-thread-reply]", (textarea) => {
					textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
				});
				await plainPage.waitForFunction(() => document.querySelectorAll(".thread-card.queued [data-turn-edit]").length === 2, {}, undefined);
				await plainPage.click(".thread-card.queued [data-turn-edit]");
				await plainPage.evaluate(() => {
					const editor = document.querySelector("[data-turn-editor]");
					editor.value = "Draft one.";
					editor.dispatchEvent(new Event("input", { bubbles: true }));
				});
				await plainPage.click(".thread-card.queued [data-turn-edit]");
				await plainPage.evaluate(() => {
					const editors = [...document.querySelectorAll("[data-turn-editor]")];
					const editor = editors[editors.length - 1];
					editor.value = "Sharper nit.";
					editor.dispatchEvent(new Event("input", { bubbles: true }));
					editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
				});
				await plainPage.waitForFunction(() => {
					const editors = document.querySelectorAll("[data-turn-editor]");
					return editors.length === 1 && editors[0].value === "Draft one." && document.querySelector(".thread-card.queued").textContent.includes("Sharper nit.");
				});
				assert.equal(plainDeliveries.length, 3, "Editing queued content must not message Pi.");
				assert.equal(await plainPage.$eval("[data-finish]", (button) => button.textContent), "Send round to Pi (2 to send)", "The send count tallies undelivered messages, not threads.");
				await plainPage.$eval("[data-turn-editor]", (editor) => {
					editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
				});
				await plainPage.waitForFunction(() => !document.querySelector("[data-turn-editor]") && document.querySelectorAll(".thread-card.queued [data-turn-edit]").length === 2);
				await plainPage.$$eval(".thread-card.queued [data-turn-delete]", (buttons) => buttons[buttons.length - 1].click());
				await plainPage.waitForFunction(() => document.querySelectorAll(".thread-card.queued [data-turn-delete]").length === 1);
				assert.equal(await plainPage.$eval("[data-finish]", (button) => button.textContent), "Send round to Pi (1 to send)", "A partially deleted thread stays queued.");
				await plainPage.click(".thread-card.queued [data-turn-delete]");
				await plainPage.waitForFunction(() => !document.querySelector(".thread-card.queued"));
				assert.equal(plainDeliveries.length, 3, "Deleting queued content must not message Pi.");
				assert.equal(await plainPage.$eval("[data-finish]", (button) => button.textContent), "Send round to Pi", "Deleting the queued thread clears the count.");
				const plainTotal = plainReview.files.length;
				assert.equal(await plainPage.$eval("[data-viewed-count]", (label) => label.textContent), `0 / ${plainTotal} viewed`);
				await plainPage.keyboard.press("x");
				await plainPage.waitForFunction((total) => document.querySelector("[data-viewed-count]").textContent === `1 / ${total} viewed`, {}, plainTotal);
				assert.equal(await plainPage.$eval(".review-file.active [data-viewed-toggle]", (box) => box.checked), true, "x must check the active file's viewed box.");
				const activePath = await plainPage.$eval(".review-file.active", (section) => section.dataset.path);
				assert.equal(await plainPage.$eval(`[data-viewed-check="${activePath}"]`, (mark) => mark.hidden), false, "The sidebar must show the viewed check.");
				for (let attempt = 0; attempt < 100 && plainServer.viewedFiles().length !== 1; attempt++) await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
				assert.deepEqual(plainServer.viewedFiles(), [activePath], "The viewed toggle must persist server-side.");
				await plainPage.keyboard.press("x");
				await plainPage.waitForFunction((total) => document.querySelector("[data-viewed-count]").textContent === `0 / ${total} viewed`, {}, plainTotal);
				await plainPage.click("[data-shortcuts-hint]");
				assert.equal(await plainPage.$eval("[data-shortcuts-overlay]", (overlay) => overlay.hidden), false, "The header hint must open the shortcuts guide.");
				await plainPage.keyboard.press("Escape");

				await plainPage.evaluate(() => {
					const section = document.querySelector(".thread-card [data-thread-reply]").closest("[data-review-file]");
					document.querySelector(`[data-file-nav="${section.dataset.reviewFile}"]`).click();
				});
				await plainPage.waitForFunction(() => !document.querySelector(".thread-card [data-thread-reply]").closest("[data-review-file]").hidden);
				await plainPage.$eval(".thread-card [data-composer-expand]", (button) => button.click());
				await plainPage.type(".thread-card [data-thread-reply]", "persisted draft reply");
				await plainPage.reload({ waitUntil: "domcontentloaded" });
				await plainPage.waitForFunction(() => document.querySelector(".thread-card [data-thread-reply]")?.value === "persisted draft reply", {});
				assert.equal(await plainPage.$eval(".thread-card [data-thread-reply]", (textarea) => textarea.closest(".reply-composer").classList.contains("collapsed")), false, "A persisted reply draft auto-expands its composer on restore.");
				await plainPage.$eval(".thread-card [data-thread-reply]", (textarea) => {
					textarea.value = "";
					textarea.dispatchEvent(new Event("input", { bubbles: true }));
				});
				assert.equal(await plainPage.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("picr:")).length), 0, "Clearing a draft removes its stored copy.");

				// Navigation is prompt-free with a draft open: it survives every panel
				// switch, announced by a sidebar pencil on its host file. Only true
				// destruction points ask — replacement, send-round, approval.
				const draftDialogs = [];
				const recordDialog = (dialog) => {
					draftDialogs.push(dialog.message());
					dialog.dismiss().catch(() => {});
				};
				plainPage.on("dialog", recordDialog);
				const draftFilePath = await plainPage.evaluate(() => {
					const active = document.querySelector(".review-file.active");
					const rowSelector = "tr.diff-add .diff-code span, tr.diff-del .diff-code span, tr.diff-context .diff-code span";
					const section = [...document.querySelectorAll("[data-review-file]")].find((candidate) => candidate !== active && candidate.querySelector(rowSelector));
					document.querySelector(`[data-file-nav="${section.dataset.reviewFile}"]`).click();
					const code = section.querySelector(rowSelector);
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
					return section.dataset.path;
				});
				await plainPage.waitForFunction(() => document.querySelector(".review-file.active [data-selection-composer]")?.hidden === false, { polling: 100 });
				await plainPage.type(".review-file.active [data-selection-feedback]", "trapped draft");
				await plainPage.evaluate(() => window.history.replaceState(null, "", window.location.pathname));
				await plainPage.reload({ waitUntil: "domcontentloaded" });
				await plainPage.waitForFunction(() => document.querySelector("[data-selection-composer]:not([hidden])"), { polling: 100 });
				assert.equal(await plainPage.evaluate(() => document.querySelector(".review-file.active")?.dataset.path), draftFilePath, "Reload must land on the draft's own file.");
				assert.equal(await plainPage.evaluate(() => {
					const composer = document.querySelector("[data-selection-composer]:not([hidden])");
					return composer.offsetParent !== null && composer.querySelector("[data-selection-feedback]").value;
				}), "trapped draft", "The restored composer is visible with its text.");
				assert.equal(await plainPage.evaluate((path) => {
					const visible = [...document.querySelectorAll("[data-draft-dot]:not([hidden])")];
					return visible.length === 1 && visible[0].dataset.draftDot === path;
				}, draftFilePath), true, "The sidebar pencil marks exactly the draft's host file.");
				// Negative sweep: every navigation surface, zero dialogs, draft intact.
				await plainPage.keyboard.press("]");
				await plainPage.keyboard.press("[");
				await plainPage.keyboard.press("o");
				await plainPage.evaluate(() => document.querySelector('[data-file-nav="0"]').click());
				await plainPage.evaluate((path) => {
					window.location.hash = "#loc=" + encodeURIComponent(path) + ":L1";
				}, draftFilePath);
				await plainPage.waitForFunction((path) => document.querySelector(".review-file.active")?.dataset.path === path, { polling: 100 }, draftFilePath);
				assert.equal(draftDialogs.length, 0, "No navigation surface asks about an open draft.");
				assert.equal(await plainPage.evaluate(() => {
					const composer = document.querySelector("[data-selection-composer]:not([hidden])");
					return composer && composer.querySelector("[data-selection-feedback]").value;
				}), "trapped draft", "The draft survives the whole sweep untouched.");
				assert.equal(await plainPage.evaluate(() => Object.keys(localStorage).some((key) => key.endsWith(":selection"))), true, "The stored draft survives navigation.");
				// Destruction points still ask: replacing the draft with a new selection…
				await plainPage.keyboard.press("]");
				await plainPage.evaluate(() => {
					const rowSelector = "tr.diff-add .diff-code span, tr.diff-del .diff-code span, tr.diff-context .diff-code span";
					const code = document.querySelector(".review-file.active").querySelector(rowSelector);
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await new Promise((resolvePromise, rejectPromise) => {
					const deadline = Date.now() + 5_000;
					const tick = () => (draftDialogs.length >= 1 ? resolvePromise() : Date.now() > deadline ? rejectPromise(new Error("replacement dialog never fired")) : setTimeout(tick, 50));
					tick();
				});
				assert.equal(draftDialogs.length, 1, "Replacing the draft with a new selection still asks first.");
				assert.equal(await plainPage.evaluate(() => Object.keys(localStorage).some((key) => key.endsWith(":selection"))), true, "Dismissing the replacement keeps the draft.");
				// …and so does sending the round.
				await plainPage.click("[data-finish]");
				assert.equal(draftDialogs.length, 2, "Sending the round with an open draft asks first.");
				assert.equal(await plainPage.evaluate(() => document.querySelector("[data-finish-overlay]")?.hidden), true, "Dismissing the send prompt keeps the modal closed.");
				plainPage.off("dialog", recordDialog);
				// The composer's own Cancel destroys without asking — it IS the answer.
				await plainPage.evaluate((path) => {
					const section = [...document.querySelectorAll("[data-review-file]")].find((candidate) => candidate.dataset.path === path);
					document.querySelector(`[data-file-nav="${section.dataset.reviewFile}"]`).click();
				}, draftFilePath);
				await plainPage.waitForFunction((path) => document.querySelector(".review-file.active")?.dataset.path === path, { polling: 100 }, draftFilePath);
				await plainPage.evaluate(() => document.querySelector("[data-selection-composer]:not([hidden]) [data-selection-cancel]").click());
				await plainPage.waitForFunction(() => !document.querySelector("[data-selection-composer]:not([hidden])"), { polling: 100 });
				assert.equal(await plainPage.evaluate(() => document.querySelectorAll("[data-draft-dot]:not([hidden])").length), 0, "Cancelling clears the sidebar pencil.");
				assert.equal(await plainPage.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("picr:")).length), 0, "Cancelling clears the stored draft.");

				const navHomePath = await plainPage.$eval(".review-file.active", (section) => section.dataset.path);
				await plainPage.keyboard.press("]");
				assert.notEqual(await plainPage.$eval(".review-file.active", (section) => section.dataset.path), navHomePath, "] must move to the next file.");
				await plainPage.keyboard.press("[");
				assert.equal(await plainPage.$eval(".review-file.active", (section) => section.dataset.path), navHomePath, "[ must move back.");
				await plainPage.keyboard.press("j");
				assert.ok(await plainPage.$(".review-file.active tr.nav-cursor"), "j must mark the current hunk with a focus ring.");
				await plainPage.keyboard.press("k");
				assert.ok(await plainPage.$(".review-file.active tr.nav-cursor"), "k keeps a hunk ringed.");
				await plainPage.keyboard.press("o");
				await plainPage.waitForFunction(() => document.querySelector("[data-global-status]").textContent.includes("no overview"));
				await plainPage.evaluate(() => {
					const section = document.querySelector(".thread-card [data-thread-reply]").closest("[data-review-file]");
					document.querySelector(`[data-file-nav="${section.dataset.reviewFile}"]`).click();
				});
				await plainPage.waitForFunction(() => !document.querySelector(".thread-card [data-thread-reply]").closest("[data-review-file]").hidden);
				await plainPage.$eval(".thread-card [data-composer-expand]", (button) => button.click());
				await plainPage.keyboard.press("Escape");
				await plainPage.waitForFunction(() => document.activeElement?.tagName !== "TEXTAREA");
				await plainPage.keyboard.press("]");
				await plainPage.waitForFunction(() => document.querySelector(".thread-card [data-thread-reply]").closest("[data-review-file]").hidden);
				await plainPage.keyboard.press("r");
				await plainPage.waitForFunction(() => document.activeElement?.matches("[data-thread-reply]") && !document.querySelector(".thread-card [data-thread-reply]").closest("[data-review-file]").hidden, {}, undefined);
				await plainPage.keyboard.press("Escape");
				assert.equal(await plainPage.$eval("[data-approve]", (button) => button.textContent), "Approve (1 open)", "The escalated thread from earlier still blocks approval.");
				await plainPage.$eval(".thread-card [data-thread-resolve]", (button) => button.focus());
				await plainPage.keyboard.press("Enter");
				await plainPage.waitForFunction(() => document.querySelector("[data-approve]").textContent === "Approve", {});
				await plainPage.keyboard.press("Escape");
				await plainPage.keyboard.press("r");
				await plainPage.waitForFunction(() => document.querySelector("[data-global-status]").textContent.includes("resolved — reopen"), {});
				assert.notEqual(await plainPage.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "r on a resolved thread hints instead of opening any composer.");
				await plainPage.evaluate((path) => {
					const section = [...document.querySelectorAll("[data-review-file]")].find((candidate) => candidate.dataset.path === path);
					document.querySelector(`[data-file-nav="${section.dataset.reviewFile}"]`).click();
				}, navHomePath);
				await plainPage.waitForFunction((path) => document.querySelector(".review-file.active")?.dataset.path === path, {}, navHomePath);
				await plainPage.evaluate(() => {
					const code = document.querySelector(".review-file.active tr.diff-add .diff-code span, .review-file.active tr.diff-del .diff-code span, .review-file.active tr.diff-context .diff-code span");
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges(); selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector(".review-file.active [data-selection-composer]")?.hidden === false);
				await plainPage.type(".review-file.active [data-selection-feedback]", "Approval **blocker** with `x < y`");
				await plainPage.$eval(".review-file.active [data-selection-feedback]", (textarea) => {
					textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector(".thread-card.queued"));
				assert.equal(await plainPage.$eval(".thread-card.queued .md strong", (strong) => strong.textContent), "blocker", "Thread turns render markdown emphasis.");
				assert.equal(await plainPage.$eval(".thread-card.queued .md code", (code) => code.textContent), "x < y", "Code spans keep their literal escaped content.");
				await plainPage.$eval(".thread-card.queued [data-composer-expand]", (button) => button.click());
				await plainPage.type(".thread-card.queued [data-thread-reply]", "probe <img src=x onerror=alert(1)>");
				await plainPage.$eval(".thread-card.queued [data-thread-reply]", (textarea) => {
					textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
				});
				await plainPage.waitForFunction(() => document.querySelectorAll(".thread-card.queued .md").length === 2);
				assert.equal(await plainPage.$(".thread-card.queued .md img"), null, "Raw HTML in a reply must never become elements.");
				assert.match(await plainPage.$$eval(".thread-card.queued .md", (bodies) => bodies[bodies.length - 1].textContent), /probe <img src=x onerror=alert\(1\)>/, "The HTML payload renders as visible text.");
				assert.equal(await plainPage.$eval("[data-approve]", (button) => button.textContent), "Approve (1 open)", "Open threads — queued included — qualify the approve button.");
				await plainPage.click("[data-approve]");
				await plainPage.waitForFunction(() => document.querySelector("[data-global-status]").textContent.includes("still open"));
				assert.ok(await plainPage.$(".thread-card.thread-flash"), "A blocked approval navigates to the first open thread.");
				assert.equal(await plainPage.$eval("[data-approve-overlay]", (overlay) => overlay.hidden), true, "The confirmation never opens while threads block.");
				await plainPage.click(".thread-card.queued [data-thread-resolve]");
				await plainPage.waitForFunction(() => document.querySelector("[data-approve]").textContent === "Approve");
				// Approval is terminal, so it is a draft destruction point: with an
				// open draft the gate asks first; dismissal keeps everything.
				await plainPage.evaluate(() => {
					const rowSelector = "tr.diff-add .diff-code span, tr.diff-del .diff-code span, tr.diff-context .diff-code span";
					const sections = [...document.querySelectorAll("[data-review-file]")].filter((candidate) => candidate.querySelector(rowSelector));
					const section = sections[sections.length - 1];
					document.querySelector(`[data-file-nav="${section.dataset.reviewFile}"]`).click();
					const code = [...section.querySelectorAll(rowSelector)].reverse().find((span) => span.textContent.trim());
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await plainPage.waitForFunction(() => document.querySelector("[data-selection-composer]:not([hidden])"), { polling: 100 });
				await plainPage.type("[data-selection-composer]:not([hidden]) [data-selection-feedback]", "draft at the gate");
				const approveGateDialogs = [];
				const recordApproveDialog = (dialog) => {
					approveGateDialogs.push(dialog.message());
					dialog.dismiss().catch(() => {});
				};
				plainPage.on("dialog", recordApproveDialog);
				await plainPage.click("[data-approve]");
				assert.equal(approveGateDialogs.length, 1, "Approving with an open draft asks exactly once.");
				assert.equal(await plainPage.$eval("[data-approve-overlay]", (overlay) => overlay.hidden), true, "Dismissing the draft gate keeps the approve overlay closed.");
				assert.equal(await plainPage.evaluate(() => !!document.querySelector("[data-selection-composer]:not([hidden])") && Object.keys(localStorage).some((key) => key.endsWith(":selection")) && document.querySelectorAll("[data-draft-dot]:not([hidden])").length === 1), true, "Dismissal keeps the draft, its storage, and its pencil.");
				plainPage.off("dialog", recordApproveDialog);
				plainPage.once("dialog", (dialog) => dialog.accept());
				await plainPage.click("[data-approve]");
				await plainPage.waitForFunction(() => document.querySelector("[data-approve-overlay]")?.hidden === false, { polling: 100 });
				assert.equal(await plainPage.evaluate(() => !document.querySelector("[data-selection-composer]:not([hidden])") && !Object.keys(localStorage).some((key) => key.endsWith(":selection")) && document.querySelectorAll("[data-draft-dot]:not([hidden])").length === 0), true, "Accepting the gate clears draft, storage, and pencil before the overlay opens.");
				assert.equal(await plainPage.$eval("[data-approve-overlay]", (overlay) => overlay.hidden), false, "A clean review opens the confirmation.");
				assert.equal(await plainPage.$eval("[data-approve-message]", (textarea) => textarea.value), plainReview.title, "Without a proposal the commit message falls back to the review title.");
				await plainPage.$eval("[data-approve-message]", (textarea) => { textarea.value = "Plain approved unit"; });
				await plainPage.click("[data-approve-confirm]");
				await plainPage.waitForFunction(() => document.body.classList.contains("locked") && document.querySelector("[data-phase-banner-text]").textContent.includes("Approved"));
				assert.deepEqual(plainApprovals, [{ round: 1, message: "Plain approved unit", staleNow: false }], "The approval handoff carries the edited message.");
				assert.equal(await plainPage.$eval("[data-approve-overlay]", (overlay) => overlay.hidden), true);
				assert.equal(await plainPage.$eval("[data-approve]", (button) => getComputedStyle(button).display), "none", "The terminal phase hides mutation controls.");
				assert.equal(await plainPage.$eval("[data-finish]", (button) => getComputedStyle(button).display), "none");
				await plainPage.close();
			} finally {
				await plainServer.close();
			}

			const ctxServer = await createCodeReviewServer(contextReview, {
				onThreadPost: async () => {},
				onFinishPass: async () => ({ stale: false }),
				contextLines: createPinnedBlobContextReader(),
			});
			try {
				const ctxPage = await browser.newPage();
				await ctxPage.goto(ctxServer.url, { waitUntil: "domcontentloaded" });
				const active = ".review-file.active ";
				assert.equal(await ctxPage.$$eval(`${active}[data-expander]`, (rows) => rows.length), 3, "Leading, middle, and trailing gaps each render a divider.");
				await ctxPage.click(`${active}[data-expander][data-gap-start="1"] [data-expand="all"]`);
				await ctxPage.waitForFunction(() => document.querySelectorAll(".review-file.active .diff-expanded").length === 7);
				assert.equal(await ctxPage.$$eval(`${active}[data-expander]`, (rows) => rows.length), 2, "A fully expanded gap removes its divider.");
				assert.equal(await ctxPage.$eval(`${active}.diff-expanded[data-old-line="1"] .diff-code`, (cell) => cell.textContent), "line 1", "Expanded rows carry the pinned blob content.");
				await ctxPage.click(`${active}[data-expander][data-gap-start="14"] [data-expand="up"]`);
				await ctxPage.waitForFunction(() => document.querySelectorAll(".review-file.active .diff-expanded").length === 27);
				assert.equal(await ctxPage.$eval(`${active}.diff-expanded[data-old-line="17"]`, (row) => row.previousElementSibling?.dataset.expander !== undefined), true, "An upward slice sits directly below its divider.");
				assert.equal(await ctxPage.$eval(`${active}.diff-expanded[data-old-line="20"]`, (row) => row.dataset.newLine), "22", "Expanded rows apply the gap's new-side delta.");
				await ctxPage.waitForFunction(() => document.querySelector('.review-file.active [data-expander][data-gap-start="14"][data-gap-end="16"]'), {});
				assert.equal(await ctxPage.$$eval(`${active}[data-expander][data-gap-start="14"] [data-expand]`, (buttons) => buttons.map((button) => button.dataset.expand).join()), "all", "A shrunken gap collapses to a single reveal-all control.");
				await ctxPage.click(`${active}[data-expander][data-gap-start="14"] [data-expand="all"]`);
				await ctxPage.waitForFunction(() => document.querySelectorAll(".review-file.active .diff-expanded").length === 30);
				await ctxPage.click(`${active}[data-expander]:not([data-gap-end]) [data-expand="down"]`);
				await ctxPage.waitForFunction(() => document.querySelectorAll(".review-file.active .diff-expanded").length === 50);
				assert.ok(await ctxPage.$(`${active}[data-expander]:not([data-gap-end])`), "A trailing gap with more blob left keeps its divider.");
				await ctxPage.click(`${active}[data-expander]:not([data-gap-end]) [data-expand="down"]`);
				await ctxPage.waitForFunction(() => document.querySelectorAll(".review-file.active .diff-expanded").length === 67 && !document.querySelector(".review-file.active [data-expander]"));
				await ctxPage.evaluate(() => {
					const code = document.querySelector('.review-file.active .diff-expanded[data-old-line="20"] .diff-code span');
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await ctxPage.waitForFunction(() => document.querySelector("[data-global-status]").textContent.includes("read-only"));
				assert.equal(await ctxPage.$eval("[data-selection-composer]", (composer) => composer.hidden), true, "Expanded context never opens the comment composer.");
				await ctxPage.$eval('.review-file.active tr[data-new-line="42"] .line-number', (cell) => cell.click());
				assert.match(await ctxPage.evaluate(() => window.location.hash), /loc=ctx\.txt%3AL42|loc=ctx\.txt:L42/, "Clicking a line number writes a shareable location hash.");
				assert.equal(await ctxPage.$eval('.review-file.active tr[data-new-line="42"]', (row) => row.classList.contains("nav-cursor")), true, "The linked line gets the focus ring.");
				await ctxPage.goto(`${new URL(ctxServer.url).origin}/#loc=${encodeURIComponent("moved.txt")}:L20`, { waitUntil: "domcontentloaded" });
				await ctxPage.waitForFunction(() => document.querySelector('[data-review-file].active')?.dataset.path === "moved.txt");
				await ctxPage.waitForFunction(() => document.querySelector('tr[data-new-line="20"].nav-cursor'), {});
				const coldPage = await browser.newPage();
				await coldPage.goto(`${new URL(ctxServer.url).origin}/#loc=${encodeURIComponent("moved.txt")}:L20`, { waitUntil: "domcontentloaded" });
				await coldPage.waitForFunction(() => document.querySelector("[data-review-file].active")?.dataset.path === "moved.txt" && document.querySelector('tr[data-new-line="20"].nav-cursor'), {});
				await coldPage.close();
				await ctxPage.goto(`${new URL(ctxServer.url).origin}/#loc=${encodeURIComponent("moved.txt")}:O5`, { waitUntil: "domcontentloaded" });
				await ctxPage.waitForFunction(() => document.querySelector("[data-global-status]").textContent.includes("unexpanded gap"), {});
				await ctxPage.goto(`${new URL(ctxServer.url).origin}/`, { waitUntil: "domcontentloaded" });
				await ctxPage.waitForFunction(() => document.querySelector(".review-file.active"));
				await ctxPage.evaluate(() => {
					const code = document.querySelector(".review-file.active tr.diff-add .diff-code span");
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await ctxPage.waitForFunction(() => document.querySelector(".review-file.active [data-selection-composer]")?.hidden === false);
				await ctxPage.type(".review-file.active [data-selection-feedback]", "selection survives reload");
				const ctxQuote = await ctxPage.$eval(".review-file.active [data-selection-quote]", (quote) => quote.textContent);
				await ctxPage.reload({ waitUntil: "domcontentloaded" });
				await ctxPage.waitForFunction(() => document.querySelector(".review-file.active [data-selection-composer]")?.hidden === false, {});
				assert.equal(await ctxPage.$eval(".review-file.active [data-selection-feedback]", (textarea) => textarea.value), "selection survives reload", "Selection drafts restore their text after a reload.");
				assert.equal(await ctxPage.$eval(".review-file.active [data-selection-quote]", (quote) => quote.textContent), ctxQuote, "Selection drafts restore their quoted anchor.");
				await ctxPage.$eval(".review-file.active [data-selection-add]", (button) => button.click());
				await ctxPage.waitForFunction(() => document.querySelector(".thread-card"), {});
				assert.equal(await ctxPage.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("picr:")).length), 0, "Posting a restored draft clears its stored copy.");
				// The prune is the only path that deletes another namespace's data: a
				// round advance must clear the old round's keys, and a superseded page
				// must never touch the live round's.
				await ctxPage.evaluate(() => localStorage.setItem("picr:stale-namespace:overview", "old draft"));
				const ctxThreadId = await ctxPage.$eval(".thread-card", (card) => card.dataset.threadCard);
				assert.equal(ctxServer.addRound({ ...contextReview, id: altId(contextReview.id, 12) }, contextReview.id, [{ respondsTo: ctxThreadId, resolution: "needs-discussion", body: "Carrying across the advance.", file: "ctx.txt" }]).round, 2);
				await ctxPage.waitForFunction(() => document.body.dataset.round === "2");
				assert.equal(await ctxPage.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("picr:") && !key.startsWith("picr:" + document.body.dataset.reviewId + ":")).length), 0, "The new round's page prunes foreign draft namespaces.");
				await ctxPage.evaluate(() => localStorage.setItem("picr:" + document.body.dataset.reviewId + ":overview", "live round draft"));
				await ctxPage.goto(`${new URL(ctxServer.url).origin}/round/1`, { waitUntil: "domcontentloaded" });
				await ctxPage.waitForFunction(() => document.body.dataset.round === "1");
				assert.equal(await ctxPage.evaluate(() => Object.values(localStorage).includes("live round draft")), true, "A superseded page never prunes the live round's drafts.");
				await ctxPage.close();
			} finally {
				await ctxServer.close();
			}

			// Plan review: rendered markdown sections host selection threads anchored
			// on absolute source lines, section commentary replies, and block nav.
			const planPosts = [];
			const planApprovals = [];
			const planServer = await createCodeReviewServer(plan, {
				onThreadPost: async (_round, thread) => {
					planPosts.push(thread);
				},
				onFinishPass: async () => ({ stale: false }),
				onApprove: async (round, message, staleNow) => {
					planApprovals.push({ round: round.number, message, staleNow });
				},
			});
			try {
				const planPage = await browser.newPage();
				// A short viewport makes the three-section fixture genuinely scrollable
				// so the reading-position spy has something to follow.
				await planPage.setViewport({ width: 1200, height: 220 });
				await planPage.goto(planServer.url, { waitUntil: "domcontentloaded" });
				await planPage.waitForFunction(() => document.body.dataset.reviewKind === "plan" && document.querySelector(".plan-doc"), { polling: 100 });
				assert.equal(await planPage.$eval('[data-file-nav="1"]', (nav) => nav.textContent.includes("Goals <b>")), true, "The sidebar lists section titles.");
				assert.equal(await planPage.evaluate(() => document.querySelectorAll("[data-review-file][hidden]").length), 0, "The whole plan renders as one continuous document.");
				await planPage.evaluate(() => document.querySelector('[data-review-file="2"]').scrollIntoView());
				await planPage.waitForFunction(() => document.querySelector('[data-review-file="2"]').classList.contains("active"), { polling: 100 });
				assert.equal(await planPage.$eval('[data-file-nav="2"]', (nav) => nav.classList.contains("active")), true, "The sidebar follows the reading position.");
				await planPage.click("[data-view-toggle]");
				await planPage.waitForFunction(() => document.body.classList.contains("plan-focus"), { polling: 100 });
				assert.equal(await planPage.evaluate(() => getComputedStyle(document.querySelector('[data-review-file="0"]')).display), "none", "Focus view shows one section at a time.");
				assert.equal(await planPage.$eval("[data-view-toggle]", (button) => button.textContent), "Whole document", "The toggle offers the way back.");
				await planPage.click("[data-view-toggle]");
				await planPage.waitForFunction(() => !document.body.classList.contains("plan-focus"), { polling: 100 });
				assert.equal(await planPage.evaluate(() => [...document.querySelectorAll("[data-review-file]")].every((section) => getComputedStyle(section).display !== "none")), true, "The whole document returns on untoggle.");
				// The spy must never override deliberate navigation, and the document
				// bottom always belongs to the last section. (Let the untoggle's own
				// smooth scroll settle first so the jump to the top is a real scroll.)
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
				await planPage.evaluate(() => window.scrollTo(0, 0));
				await planPage.waitForFunction(() => document.querySelector('[data-review-file="0"]').classList.contains("active"), { polling: 100 });
				await planPage.evaluate(() => document.querySelector('[data-file-nav="2"]').click());
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
				assert.equal(await planPage.$eval('[data-file-nav="2"]', (nav) => nav.classList.contains("active")), true, "A nav click survives the spy's settling.");
				await planPage.evaluate(() => window.scrollTo(0, 0));
				await planPage.waitForFunction(() => document.querySelector('[data-review-file="0"]').classList.contains("active"), { polling: 100 });
				await planPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
				await planPage.waitForFunction(() => document.querySelector('[data-review-file="2"]').classList.contains("active"), { polling: 100 });
				await planPage.evaluate(() => {
					document.querySelector('[data-file-nav="1"]').click();
					const block = document.querySelector('.review-file.active [data-md-line="4"]');
					const range = document.createRange();
					range.selectNodeContents(block);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					block.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await planPage.waitForFunction(() => document.querySelector('[data-path="goals-b"] [data-selection-composer]')?.hidden === false, { polling: 100 });
				assert.equal(await planPage.$eval('[data-path="goals-b"] [data-selection-quote]', (quote) => quote.textContent), "fast", "The quote carries the rendered selection text.");
				await planPage.type('[data-path="goals-b"] [data-selection-feedback]', "Make this measurable.");
				await planPage.$eval('[data-path="goals-b"] [data-selection-add]', (button) => button.click());
				await planPage.waitForFunction(() => document.querySelector(".thread-card"), { polling: 100 });
				// Margin-note invariants in a congested rail (everything anchors at
				// line 4): items never float above their text and collisions push
				// down instead of overlapping. The layout coalesces on an animation
				// frame, so the check polls. Exact alignment is pinned separately on
				// an uncongested fixture below.
				const congestedRail = `(() => {
					const note = document.querySelector('[data-path="goals-b"] .plan-rail .agent-note[data-anchor-start]');
					const card = document.querySelector('[data-path="goals-b"] .plan-rail .thread-card');
					const block = document.querySelector('[data-path="goals-b"] [data-md-line="4"]');
					return note.getBoundingClientRect().top >= block.getBoundingClientRect().top - 1
						&& card.getBoundingClientRect().top >= note.getBoundingClientRect().bottom;
				})()`;
				await planPage.waitForFunction(congestedRail, { polling: 100 });
				assert.equal(await planPage.evaluate(congestedRail), true, "Rail items never float above their anchor and never overlap.");
				assert.deepEqual(
					[planPosts[0].file, planPosts[0].side, planPosts[0].newStart, planPosts[0].newEnd, planPosts[0].highlight],
					["goals-b", "new", 4, 4, "fast"],
					"Plan selection threads anchor on the block's absolute source lines.",
				);
				await planPage.$eval('[data-commentary-composer="g1"] [data-composer-expand]', (button) => button.click());
				await planPage.type('[data-path="goals-b"] [data-commentary-reply="g1"]', "Agreed, keep the note.");
				await planPage.$eval('[data-path="goals-b"] [data-commentary-post="g1"]', (button) => button.click());
				await planPage.waitForFunction(() => document.querySelector('[data-commentary-thread="g1"] .thread-card'), { polling: 100 });
				assert.equal(planPosts[1].commentaryId, "g1", "Section commentary hosts reply threads.");
				// The prose column stays capped and the rail sits beside it — no dead gap.
				assert.equal(await planPage.evaluate(() => {
					const columns = getComputedStyle(document.querySelector('[data-path="goals-b"] .file-layout')).gridTemplateColumns.split(" ");
					return parseFloat(columns[0]) <= 760.5 && parseFloat(columns[1]) <= 420.5;
				}), true, "Plan layout caps the prose column and keeps the rail adjacent.");
				assert.equal(await planPage.evaluate(() => getComputedStyle(document.querySelector('[data-path="steps"] .plan-rail')).borderTopWidth), "0px", "Empty rails paint no chrome.");
				// Note↔text linkage: hover ties both directions; the anchor click rings.
				await planPage.evaluate(() => document.querySelector('.agent-note[data-anchor-start] .agent-note-anchor').dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
				assert.equal(await planPage.evaluate(() => [...document.querySelectorAll(".note-target")].map((block) => block.dataset.mdLine).join(",")), "4,5", "Hovering a note tints exactly its anchored blocks.");
				assert.match(await planPage.evaluate(() => getComputedStyle(document.querySelector(".plan-doc .note-target")).boxShadow), /inset/, "Hovered plan blocks carry the accent left-border treatment.");
				await planPage.evaluate(() => document.querySelector('[data-path="goals-b"] [data-md-line="4"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
				assert.equal(await planPage.evaluate(() => document.querySelectorAll(".note-target").length === 0 && document.querySelector('.agent-note[data-commentary-id="g1"]').classList.contains("note-hover")), true, "Hovering a block outlines the notes that reference it.");
				assert.equal(await planPage.evaluate(() => {
					const probe = document.createElement("span");
					probe.style.color = "var(--accent)";
					document.body.append(probe);
					const accent = getComputedStyle(probe).color;
					probe.remove();
					return getComputedStyle(document.querySelector(".agent-note.note-hover")).borderTopColor === accent;
				}), true, "Hovering anchored content tints the referencing card's border with the accent.");
				await planPage.evaluate(() => document.querySelector('.agent-note[data-anchor-start] .agent-note-anchor').click());
				await planPage.waitForFunction(() => document.querySelector('[data-md-line="4"].nav-cursor'), { polling: 100 });
				await planPage.waitForFunction(() => {
					const top = document.querySelector('[data-md-line="4"]').getBoundingClientRect().top;
					return top >= 30 && top <= 170;
				}, { polling: 100 });
				await planPage.keyboard.press("Escape");
				await planPage.keyboard.press("j");
				assert.equal(await planPage.evaluate(() => document.querySelector(".nav-cursor")?.dataset.mdLine !== undefined), true, "j walks rendered blocks in plan mode.");
				await planPage.goto(`${new URL(planServer.url).origin}/#loc=steps:L8`, { waitUntil: "domcontentloaded" });
				await planPage.waitForFunction(() => document.querySelector("[data-review-file].active")?.dataset.path === "steps" && document.querySelector('[data-md-line="8"].nav-cursor'), { polling: 100 });
				// Round 2: the revised plan carries threads and marks changed sections.
				const planRound2 = buildPlanReview({ title: "Test Plan", markdown: planMarkdown.replace("- fast", "- blazingly fast") });
				const planAdvance = planServer.addRound(planRound2, plan.id, resolvePlanResponses(planRound2, [
					{ respondsTo: planPosts[0].id, resolution: "addressed", body: "Made it measurable.", file: "Goals <b>", startLine: 4, endLine: 4 },
					{ respondsTo: planPosts[1].id, resolution: "needs-discussion", body: "Still deciding.", file: "goals-b" },
				]));
				assert.equal(planAdvance.round, 2, "Plan rounds advance through the generic round machinery.");
				await planPage.waitForFunction(() => document.body.dataset.round === "2", { polling: 100 });
				assert.equal(await planPage.evaluate(() => {
					const changed = [...document.querySelectorAll(".change-mark")].map((mark) => mark.closest("[data-file-nav]").dataset.fileNav);
					return JSON.stringify(changed);
				}), '["1"]', "Only the section whose content changed carries the round's change mark.");
				assert.equal(await planPage.evaluate(() => document.querySelectorAll("[data-carried-thread]").length), 2, "Open threads carry into the new plan round.");
				assert.match(await planPage.$eval('[data-review-file="1"]', (section) => section.textContent), /Made it measurable\./, "Carried resolutions render in their anchored section.");
				const planIdentical = planServer.addRound(buildPlanReview({ title: "Test Plan", markdown: planMarkdown.replace("- fast", "- blazingly fast") }), planRound2.id);
				assert.equal(planIdentical.identical, true, "An unchanged plan reopens the same round instead of advancing.");
				// Round 3: a renamed heading is a new slug — marked changed via the
				// missing-key path, the old section leaves the outline, and carried
				// threads re-anchor into the differently-slugged document.
				const planRound3 = buildPlanReview({ title: "Test Plan", markdown: planMarkdown.replace("- fast", "- blazingly fast").replace("## Steps", "## Rollout") });
				assert.equal(planServer.addRound(planRound3, planRound2.id, resolvePlanResponses(planRound3, [
					{ respondsTo: planPosts[0].id, resolution: "needs-discussion", body: "Re-anchored across the rename.", file: "Goals <b>", startLine: 4, endLine: 4 },
					{ respondsTo: planPosts[1].id, resolution: "needs-discussion", body: "Carried again.", file: "goals-b" },
				])).round, 3, "A renamed heading still advances the round with re-anchored threads.");
				await planPage.waitForFunction(() => document.body.dataset.round === "3", { polling: 100 });
				assert.equal(await planPage.evaluate(() => JSON.stringify([...document.querySelectorAll(".change-mark")].map((mark) => mark.closest("[data-file-nav]").querySelector("span:nth-child(2)").textContent))), '["Rollout"]', "Only the renamed section carries the change mark.");
				assert.equal(await planPage.evaluate(() => [...document.querySelectorAll("[data-review-file]")].some((section) => section.dataset.path === "steps")), false, "The old slug leaves the document.");
				assert.equal(await planPage.evaluate(() => document.querySelectorAll("[data-carried-thread]").length), 2, "Carried threads survive the rename.");
				// Approval: blocked while threads stay open, then terminal with the note.
				await planPage.waitForFunction(() => document.querySelector("[data-approve]") && getComputedStyle(document.querySelector("[data-approve]")).display !== "none", { polling: 100 });
				await planPage.click("[data-approve]");
				await planPage.waitForFunction(() => document.querySelector("[data-global-status]").textContent.includes("still open"), { polling: 100 });
				assert.equal(await planPage.$eval("[data-approve-overlay]", (overlay) => overlay.hidden), true, "Open carried threads block plan approval.");
				await planPage.evaluate(() => {
					document.querySelectorAll("[data-thread-card] [data-thread-resolve]").forEach((button) => button.click());
				});
				await planPage.waitForFunction(() => [...document.querySelectorAll("[data-thread-card]")].every((card) => card.classList.contains("resolved")), { polling: 100 });
				await planPage.click("[data-approve]");
				await planPage.waitForFunction(() => document.querySelector("[data-approve-overlay]")?.hidden === false, { polling: 100 });
				assert.match(await planPage.$eval("[data-approve-overlay] h2", (heading) => heading.textContent), /Approve this plan/, "The approve overlay speaks plan language.");
				assert.match(await planPage.$eval("[data-approve-overlay] .approve-message-label", (label) => label.textContent), /Approval note/, "Plans ask for an approval note, not a commit message.");
				await planPage.$eval("[data-approve-message]", (textarea) => {
					textarea.value = "Plan approved — proceed as written.";
				});
				await planPage.click("[data-approve-confirm]");
				await planPage.waitForFunction(() => document.body.classList.contains("locked"), { polling: 100 });
				assert.deepEqual(planApprovals, [{ round: 3, message: "Plan approved — proceed as written.", staleNow: false }], "Plan approval hands the reviewer's note to Pi.");
				await planPage.close();
			} finally {
				await planServer.close();
			}

			// Diagram review end to end: the vendored renderer serves, mermaid
			// fences render to SVG with element identities, a node click opens the
			// composer refined to the element, the wire names it, Pi's note anchors
			// flash it, a broken fence degrades to its source, and a round advance
			// re-anchors the carried thread's element in the new snapshot.
			const diagramPlanMd = ["## Topology", "", "```mermaid", "flowchart LR", "  ui[Web] --> api(Gateway)", "  api --> db[(Store)]", "```", "", "Prose after.", "", "## Broken", "", "```mermaid", "flowchart LR", "  a[--> ::: nonsense", "```"].join("\n");
			const diagramPlan = buildPlanReview({ title: "Diagram demo", markdown: diagramPlanMd, sections: [{ heading: "Topology", commentary: [{ id: "gw", body: "The single gateway.", element: "node:api" }, { id: "flow", body: "Traffic enters here.", element: "edge:ui->api" }] }] });
			const diagramPosts = [];
			const diagramServer = await createCodeReviewServer(diagramPlan, {
				onThreadPost: async (_round, thread) => { diagramPosts.push(thread); },
				onFinishPass: async () => ({ stale: false }),
				onApprove: async () => {},
			});
			try {
				const dPage = await browser.newPage();
				await dPage.setViewport({ width: 1280, height: 900 });
				await dPage.goto(diagramServer.url, { waitUntil: "domcontentloaded" });
				await dPage.waitForFunction(() => document.querySelector('.diagram-canvas svg [data-el="node:api"]'), { polling: 100, timeout: 15_000 });
				assert.equal(await dPage.$eval('[data-review-file="0"] .diagram-source', (pre) => pre.hidden), true, "A rendered diagram hides its source fallback.");
				assert.ok(await dPage.$('.diagram-canvas svg [data-el="edge:ui->api"]'), "Edges carry element identities too.");
				assert.equal(await dPage.$eval('[data-review-file="0"] .diagram-canvas', (canvas) => canvas.style.cursor), "", "A fully visible diagram does not advertise panning.");
				const centered = await dPage.$eval('[data-review-file="0"] .diagram-canvas', (canvas) => {
					const inner = canvas.querySelector(".diagram-inner");
					const box = canvas.getBoundingClientRect();
					const content = inner.getBoundingClientRect();
					return Math.abs((content.left - box.left) - (box.right - content.right));
				});
				assert.equal(centered <= 2, true, "A fitting diagram centers in its canvas (gap skew: " + centered + "px).");
				// Zooming OUT a fitting diagram reveals nothing: still not pannable.
				await dPage.$eval('[data-review-file="0"] .diagram-zoom button:nth-child(2)', (button) => button.click());
				await dPage.waitForFunction(() => (document.querySelector('[data-review-file="0"] .diagram-inner')?.style.transform ?? "").includes("scale(0.8)"), { polling: 50 });
				assert.equal(await dPage.$eval('[data-review-file="0"] .diagram-canvas', (canvas) => canvas.style.cursor), "", "A zoomed-out fitting diagram does not advertise panning.");
				await dPage.evaluate(() => {
					const canvas = document.querySelector('[data-review-file="0"] .diagram-canvas');
					const opts = (x, y) => ({ bubbles: true, button: 0, pointerId: 9, clientX: x, clientY: y });
					canvas.dispatchEvent(new PointerEvent("pointerdown", opts(300, 200)));
					canvas.dispatchEvent(new PointerEvent("pointermove", opts(240, 160)));
					canvas.dispatchEvent(new PointerEvent("pointerup", opts(240, 160)));
				});
				assert.match(await dPage.$eval('[data-review-file="0"] .diagram-inner', (inner) => inner.style.transform), /translate\(0px,\s*0px\)/, "Dragging a zoomed-out fitting diagram moves nothing.");
				await dPage.$eval('[data-review-file="0"] .diagram-zoom button:nth-child(3)', (button) => button.click());
				await dPage.waitForFunction(() => (document.querySelector('[data-review-file="0"] .diagram-inner')?.style.transform ?? "").includes("scale(1)"), { polling: 50 });
				// Hover linkage is two-way for elements, and visible on edges: a
				// filter glow on a 2px path is imperceptible, so el-target paints
				// the stroke itself.
				await dPage.$eval('[data-anchor-element="edge:ui->api"]', (note) => note.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
				await dPage.waitForFunction(() => document.querySelector('[data-el="edge:ui->api"]')?.classList.contains("el-target"), { polling: 50 });
				assert.equal(await dPage.$eval('[data-el="edge:ui->api"]', (edge) => getComputedStyle(edge).strokeWidth), "3px", "A hovered edge anchor lights the stroke itself, not just a glow.");
				await dPage.$eval('[data-el="edge:ui->api"]', (edge) => edge.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
				await dPage.waitForFunction(() => document.querySelector('[data-anchor-element="edge:ui->api"]')?.classList.contains("note-hover"), { polling: 50 });
				await dPage.$eval('.plan-head h1', (title) => title.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
				await dPage.waitForFunction(() => !document.querySelector('.note-hover') && !document.querySelector('.el-target'), { polling: 50 });
				// The broken fence degrades: banner + visible source, page intact.
				await dPage.waitForFunction(() => document.querySelector('[data-review-file="1"] .diagram-error')?.hidden === false, { polling: 100 });
				assert.equal(await dPage.$eval('[data-review-file="1"] .diagram-source', (pre) => pre.hidden), false, "A failed diagram shows its fenced source.");
				// Pi's element-anchored note flashes the node on click.
				await dPage.$eval('[data-anchor-element="node:api"] .agent-note-anchor', (button) => button.click());
				await dPage.waitForFunction(() => document.querySelector('[data-el="node:api"]').classList.contains("el-flash"), { polling: 50 });
				// Zoom in first: element clicks must survive a zoomed canvas (the
				// audit's P1 — pointer capture used to retarget the click).
				await dPage.$eval('[data-review-file="0"] .diagram-zoom button', (button) => button.click());
				await dPage.waitForFunction(() => (document.querySelector('[data-review-file="0"] .diagram-inner')?.style.transform ?? "").includes("scale(1.25)"), { polling: 50 });
				// Click the db node: the composer opens refined to the element.
				await dPage.$eval('[data-el="node:db"]', (node) => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await dPage.waitForFunction(() => document.querySelector('[data-review-file="0"] [data-selection-composer]')?.hidden === false, { polling: 100 });
				assert.match(await dPage.$eval('[data-review-file="0"] [data-selection-quote]', (quote) => quote.textContent), /Store/, "The composer quotes the element's label.");
				await dPage.type('[data-review-file="0"] [data-selection-feedback]', "Postgres or something else?");
				await dPage.$eval('[data-review-file="0"] [data-selection-add]', (button) => button.click());
				await dPage.waitForFunction(() => document.querySelector('.thread-card'), { polling: 100 });
				assert.equal(diagramPosts[0].element, "node:db", "The posted thread carries its element to Pi.");
				assert.match(await dPage.$eval('.thread-card .element-chip', (chip) => chip.textContent), /db/, "Thread cards wear their element chip.");
				// A wide diagram at natural size drag-scrolls its canvas (no zoom
				// needed), and a real drag still swallows the click.
				{
					const wideMd = ["## Wide", "", "```mermaid", "flowchart LR", "  " + Array.from({ length: 14 }, (_, i) => `w${i}[Waypoint number ${i}]`).join(" --> "), "```"].join("\n");
					const wideServer = await createCodeReviewServer(buildPlanReview({ title: "Wide", markdown: wideMd, sections: [{ heading: "Wide", commentary: [{ id: "far", body: "The far waypoint.", element: "node:w13" }] }] }), { onThreadPost: async () => {}, onFinishPass: async () => ({ stale: false }) });
					const widePage = await browser.newPage();
					try {
						await widePage.setViewport({ width: 1100, height: 800 });
						await widePage.goto(wideServer.url, { waitUntil: "domcontentloaded" });
						await widePage.waitForFunction(() => document.querySelector(".diagram-canvas svg"), { polling: 100, timeout: 15_000 });
						const scrolled = await widePage.evaluate(() => {
							const canvas = document.querySelector(".diagram-canvas");
							if (canvas.scrollWidth <= canvas.clientWidth) return "no-overflow";
							const opts = (x) => ({ bubbles: true, button: 0, pointerId: 7, clientX: x, clientY: 200 });
							canvas.dispatchEvent(new PointerEvent("pointerdown", opts(400)));
							canvas.dispatchEvent(new PointerEvent("pointermove", opts(340)));
							canvas.dispatchEvent(new PointerEvent("pointerup", opts(340)));
							return canvas.scrollLeft;
						});
						assert.equal(typeof scrolled === "number" && scrolled >= 50, true, "Dragging a wide diagram at natural size scrolls it (got: " + scrolled + ").");
						const dragSelection = await widePage.evaluate(() => {
							const canvas = document.querySelector(".diagram-canvas");
							const sel = window.getSelection();
							sel.removeAllRanges();
							try { sel.selectAllChildren(canvas.querySelector("svg")); } catch {}
							canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
							return { selected: String(sel).length, selectable: getComputedStyle(canvas).userSelect };
						});
						assert.equal(dragSelection.selectable, "none", "Diagram canvases are not text-selectable.");
						assert.equal(await widePage.$eval(".diagram-canvas", (canvas) => canvas.style.cursor), "grab", "An overflowing diagram advertises panning with a grab cursor.");
						// Clicking an element chip scrolls the element into the canvas
						// viewport at natural size, and shifts the transform when zoomed.
						await widePage.$eval('[data-anchor-element="node:w13"] .agent-note-anchor', (button) => button.click());
						await widePage.waitForFunction(() => {
							const canvas = document.querySelector(".diagram-canvas");
							const el = document.querySelector('[data-el="node:w13"]');
							const box = canvas.getBoundingClientRect();
							const t = el.getBoundingClientRect();
							return canvas.scrollLeft > 0 && t.left >= box.left && t.right <= box.right;
						}, { polling: 100 });
						await widePage.evaluate(() => document.querySelector(".diagram-canvas").scrollTo({ left: 0 }));
						await widePage.$eval(".diagram-zoom button", (button) => button.click());
						await widePage.waitForFunction(() => (document.querySelector(".diagram-inner")?.style.transform ?? "").includes("scale(1.25)"), { polling: 50 });
						await widePage.$eval('[data-anchor-element="node:w13"] .agent-note-anchor', (button) => button.click());
						await widePage.waitForFunction(() => {
							const el = document.querySelector('[data-el="node:w13"]');
							const box = document.querySelector(".diagram-canvas").getBoundingClientRect();
							const t = el.getBoundingClientRect();
							return t.left >= box.left - 1 && t.right <= box.right + 1;
						}, { polling: 100 });
						await new Promise((resolve) => setTimeout(resolve, 50));
						assert.equal(await widePage.$eval("[data-selection-composer]", (composer) => composer.hidden), true, "A drag across the diagram never opens the selection composer.");
					} finally {
						await widePage.close();
						await wideServer.close();
					}
				}
				// Round 2: the response re-anchors the element; the carried shell
				// jump lands on the new round's node.
				const nextDiagramPlan = buildPlanReview({ title: "Diagram demo", markdown: diagramPlanMd.replace("db[(Store)]", "pg[(Postgres)]"), sections: [] });
				const dThreadId = diagramPosts[0].id;
				const staleElement = diagramServer.addRound(nextDiagramPlan, diagramPlan.id, [{ respondsTo: dThreadId, resolution: "addressed", body: "Postgres, named.", file: "topology", element: "node:db" }]);
				assert.equal(staleElement.error, "invalid-responses", "A carried element must exist in the new round.");
				assert.match(staleElement.message, /no diagram in topology defines \(nodes: ui, api, pg/, "The rejection lists the new round's elements.");
				assert.equal(diagramServer.addRound(nextDiagramPlan, diagramPlan.id, [{ respondsTo: dThreadId, resolution: "addressed", body: "Postgres, named.", file: "topology", element: "node:pg" }]).round, 2);
				await dPage.waitForFunction(() => document.body.dataset.round === "2", { polling: 100 });
				await dPage.waitForFunction(() => document.querySelector('.diagram-canvas svg [data-el="node:pg"]'), { polling: 100 });
				// B2: the round diff glows the renamed node and its new edge, leaves
				// unchanged neighbors dark, and lists the removed element in the rail.
				await dPage.waitForFunction(() => document.querySelector('[data-el="node:pg"]')?.classList.contains("el-changed"), { polling: 100 });
				assert.equal(await dPage.$eval('[data-el="edge:api->pg"]', (edge) => edge.classList.contains("el-changed")), true, "New edges glow as themselves.");
				assert.equal(await dPage.$eval('[data-el="node:api"]', (node) => node.classList.contains("el-changed")), false, "A node never glows because its neighbor changed.");
				assert.match(await dPage.$eval('[data-removed-elements]', (card) => card.textContent), /db/, "The rail names what was removed this round.");
				assert.match(await dPage.$eval('[data-removed-elements] a', (link) => link.getAttribute("href")), /\/round\/1/, "Removed elements link to their origin round.");
				await dPage.$eval('[data-carried-thread] .agent-note-anchor', (button) => button.click());
				await dPage.waitForFunction(() => document.querySelector('[data-el="node:pg"]').classList.contains("el-flash"), { polling: 50 });
				assert.match(await dPage.$eval('[data-carried-thread] .agent-note-anchor', (button) => button.textContent), /pg/, "The carried shell names the re-anchored element.");
				await dPage.close();
			} finally {
				await diagramServer.close();
			}

			// Margin-note exact alignment on an uncongested rail: a comment on a
			// mid-document block sits beside that block, not at the rail top; a
			// colliding neighbor pushes down past the minimum gap; far-apart
			// comments keep the same vertical separation as their anchors; a card
			// that grows at runtime re-seats its neighbor; and the card being
			// replied to wins exact alignment while its neighbor yields upward.
			// The layout coalesces on an animation frame, so position checks poll.
			{
				const railMarkdown = ["Intro.", "", "## Steps", ...Array.from({ length: 30 }, (_, index) => `${index + 1}. step ${index + 1}`)].join("\n");
				const railReview = buildPlanReview({ title: "Rail Plan", markdown: railMarkdown });
				const railServer = await createCodeReviewServer(railReview, { onThreadPost: async () => {}, onFinishPass: async () => ({ stale: false }) });
				const railPage = await browser.newPage();
				try {
					await railPage.setViewport({ width: 1200, height: 800 });
					await railPage.goto(railServer.url, { waitUntil: "domcontentloaded" });
					await railPage.waitForFunction(() => document.body.dataset.reviewKind === "plan", { polling: 100 });
					const post = async (line, text, quiet) => {
						await railPage.evaluate((targetLine) => {
							const block = document.querySelector('[data-path="steps"] [data-md-line="' + targetLine + '"]');
							const range = document.createRange();
							range.selectNodeContents(block);
							const selection = window.getSelection();
							selection.removeAllRanges();
							selection.addRange(range);
							block.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
						}, line);
						await railPage.waitForFunction(() => document.querySelector('[data-path="steps"] [data-selection-composer]')?.hidden === false, { polling: 100 });
						await railPage.type('[data-path="steps"] [data-selection-feedback]', text);
						if (quiet) {
							await railPage.$eval('[data-path="steps"] [data-selection-feedback]', (textarea) => {
								textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
							});
						} else {
							await railPage.$eval('[data-path="steps"] [data-selection-add]', (button) => button.click());
						}
					};
					const cardBesideBlock = (line) => `(() => {
						const card = document.querySelector('.thread-card[data-anchor-start="${line}"]');
						const block = document.querySelector('[data-path="steps"] [data-md-line="${line}"]');
						return Boolean(card && block) && Math.abs(card.getBoundingClientRect().top - block.getBoundingClientRect().top) <= 2;
					})()`;
					await post(4, "On the first step.", true);
					await railPage.waitForFunction(() => document.querySelectorAll(".thread-card").length === 1, { polling: 100 });
					await railPage.waitForFunction(cardBesideBlock(4), { polling: 100 });
					assert.equal(await railPage.evaluate(cardBesideBlock(4)), true, "An uncontested comment aligns exactly beside its anchored block.");
					await post(5, "On the second step.");
					await railPage.waitForFunction(() => document.querySelectorAll(".thread-card").length === 2, { polling: 100 });
					const collision = `(() => {
						const cards = [...document.querySelectorAll('[data-path="steps"] .plan-rail .thread-card')];
						const first = cards.find((card) => card.dataset.anchorStart === "4");
						const second = cards.find((card) => card.dataset.anchorStart === "5");
						return cards.indexOf(first) < cards.indexOf(second) && second.getBoundingClientRect().top >= first.getBoundingClientRect().bottom + 10;
					})()`;
					await railPage.waitForFunction(collision, { polling: 100 });
					assert.equal(await railPage.evaluate(collision), true, "A colliding neighbor keeps anchor order and pushes below with the minimum gap.");
					// Dynamic heights: a card that grows announces the resize (any lane
					// may change card heights at runtime) and its neighbor re-seats.
					await railPage.evaluate(() => {
						const card = document.querySelector('.thread-card[data-anchor-start="4"]');
						const spacer = document.createElement("div");
						spacer.style.height = "180px";
						card.append(spacer);
						card.dispatchEvent(new CustomEvent("marginalia:cards-resized", { bubbles: true }));
					});
					await railPage.waitForFunction(collision, { polling: 100 });
					assert.equal(await railPage.evaluate(collision), true, "A card that grows at runtime pushes its collision neighbor down on the next relayout.");
					// Mutation relayout: deleting the queued first comment must let the
					// second snap back to exact alignment with its own block.
					await railPage.$eval('.thread-card[data-anchor-start="4"] [data-turn-delete]', (button) => button.click());
					await railPage.waitForFunction(() => document.querySelectorAll(".thread-card").length === 1, { polling: 100 });
					await railPage.waitForFunction(cardBesideBlock(5), { polling: 100 });
					// Far-apart anchors: both cards align exactly, so their vertical
					// separation tracks the separation of the blocks they annotate.
					await post(30, "Down the document.");
					await railPage.waitForFunction(() => document.querySelectorAll(".thread-card").length === 2, { polling: 100 });
					const separationTracks = `(() => {
						const near = document.querySelector('.thread-card[data-anchor-start="5"]');
						const far = document.querySelector('.thread-card[data-anchor-start="30"]');
						const nearBlock = document.querySelector('[data-path="steps"] [data-md-line="5"]');
						const farBlock = document.querySelector('[data-path="steps"] [data-md-line="30"]');
						const cardGap = far.getBoundingClientRect().top - near.getBoundingClientRect().top;
						const anchorGap = farBlock.getBoundingClientRect().top - nearBlock.getBoundingClientRect().top;
						return Math.abs(cardGap - anchorGap) <= 2;
					})()`;
					await railPage.waitForFunction(separationTracks, { polling: 100 });
					assert.equal(await railPage.evaluate(separationTracks), true, "Far-apart cards keep the same vertical separation as their anchors.");
					// Interaction priority: focusing a pushed-down card's reply box
					// aligns it exactly at its anchor while its neighbor yields upward.
					await post(31, "Just below it.");
					await railPage.waitForFunction(() => document.querySelectorAll(".thread-card").length === 3, { polling: 100 });
					await railPage.waitForFunction(`(() => {
						const pushed = document.querySelector('.thread-card[data-anchor-start="31"]');
						const above = document.querySelector('.thread-card[data-anchor-start="30"]');
						return Boolean(pushed && above) && pushed.getBoundingClientRect().top >= above.getBoundingClientRect().bottom + 10;
					})()`, { polling: 100 });
					// Idle composers collapse behind their Reply… affordance; expanding
					// focuses the reply box, which is the interaction under test.
					await railPage.$eval('.thread-card[data-anchor-start="31"] [data-composer-expand]', (button) => button.click());
					const prioritized = `(() => {
						const focusedCard = document.querySelector('.thread-card[data-anchor-start="31"]');
						const neighbor = document.querySelector('.thread-card[data-anchor-start="30"]');
						const block = document.querySelector('[data-path="steps"] [data-md-line="31"]');
						const neighborBlock = document.querySelector('[data-path="steps"] [data-md-line="30"]');
						return Math.abs(focusedCard.getBoundingClientRect().top - block.getBoundingClientRect().top) <= 2
							&& neighbor.getBoundingClientRect().bottom <= focusedCard.getBoundingClientRect().top - 10
							&& neighbor.getBoundingClientRect().top < neighborBlock.getBoundingClientRect().top;
					})()`;
					await railPage.waitForFunction(prioritized, { polling: 100 });
					assert.equal(await railPage.evaluate(prioritized), true, "The focused card aligns exactly at its anchor and its neighbor yields upward.");
					await railPage.close();
				} finally {
					await railServer.close();
				}
			}

			// The document's layout is independent of the rails: a section whose
			// conversation outgrows its text never moves the document below it —
			// its cards continue into the next section's rail space instead.
			{
				const docMarkdown = ["## Alpha", "", "Alpha point one.", "", "Alpha point two.", "", "Alpha point three.", "", "## Omega", "", ...Array.from({ length: 12 }, (_, index) => `Omega paragraph ${index + 1}.`)].join("\n");
				const docReview = buildPlanReview({ title: "Doc Plan", markdown: docMarkdown });
				const docServer = await createCodeReviewServer(docReview, { onThreadPost: async () => {}, onFinishPass: async () => ({ stale: false }) });
				const docPage = await browser.newPage();
				try {
					await docPage.setViewport({ width: 1200, height: 800 });
					await docPage.goto(docServer.url, { waitUntil: "domcontentloaded" });
					await docPage.waitForFunction(() => document.body.dataset.reviewKind === "plan", { polling: 100 });
					// Measured relative to the document itself: sticky-chrome growth
					// (status text wrapping the topbar) is not a document move.
					const omegaTop = () => docPage.evaluate(() => document.querySelector('[data-path="omega"] .plan-doc').getBoundingClientRect().top - document.querySelector('[data-path="alpha"] .plan-doc').getBoundingClientRect().top);
					const before = await omegaTop();
					for (let index = 0; index < 3; index++) {
						await docPage.evaluate((line) => {
							const block = document.querySelector('[data-path="alpha"] [data-md-line="' + line + '"]');
							const range = document.createRange();
							range.selectNodeContents(block);
							const selection = window.getSelection();
							selection.removeAllRanges();
							selection.addRange(range);
							block.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
						}, [3, 5, 7][index]);
						await docPage.waitForFunction(() => document.querySelector('[data-path="alpha"] [data-selection-composer]')?.hidden === false, { polling: 100 });
						await docPage.type('[data-path="alpha"] [data-selection-composer] textarea', ("A long comment line to grow this card well past its section. ").repeat(4) + index);
						await docPage.keyboard.down("Meta");
						await docPage.keyboard.down("Shift");
						await docPage.keyboard.press("Enter");
						await docPage.keyboard.up("Shift");
						await docPage.keyboard.up("Meta");
						await docPage.waitForFunction((count) => document.querySelectorAll('[data-path="alpha"] .thread-card').length === count, { polling: 100 }, index + 1);
					}
					await docPage.waitForFunction(() => [...document.querySelectorAll('[data-path="alpha"] .thread-card')].every((card) => card.style.top !== ""), { polling: 100 });
					assert.equal(Math.abs(await omegaTop() - before) <= 2, true, "Rail conversation never moves the document: the next section's text stays put.");
					const packed = await docPage.evaluate(() => {
						const alphaDoc = document.querySelector('[data-path="alpha"] .plan-doc').getBoundingClientRect();
						const boxes = [...document.querySelectorAll('[data-path="alpha"] .thread-card')].map((card) => card.getBoundingClientRect()).sort((a, b) => a.top - b.top);
						const overlaps = boxes.some((box, i) => i > 0 && box.top < boxes[i - 1].bottom + 11);
						return { deepest: Math.max(...boxes.map((box) => box.bottom)), alphaBottom: alphaDoc.bottom, overlaps };
					});
					assert.equal(packed.overlaps, false, "Cross-section packing keeps the 12px minimum gap.");
					assert.equal(packed.deepest > packed.alphaBottom, true, "A busy section's cards continue past its own document text into the next rail's space.");
					const hit = await docPage.evaluate(() => {
						const cards = [...document.querySelectorAll('[data-path="alpha"] .thread-card')];
						const deepest = cards.reduce((best, card) => card.getBoundingClientRect().top > best.getBoundingClientRect().top ? card : best);
						deepest.scrollIntoView({ block: "center" });
						const box = deepest.getBoundingClientRect();
						const struck = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
						return deepest.contains(struck);
					});
					assert.equal(hit, true, "A card that drifted into a later rail's territory still receives pointer events.");
				} finally {
					await docPage.close();
					await docServer.close();
				}
			}

			// Rail polish: composers idle behind a Reply… affordance, cards file in
			// anchor order, the Reply button reads primary even disabled, and
			// resolved threads compact to one row — every height change announced.
			{
				const polishServer = await createCodeReviewServer({ ...ordered, id: altId(ordered.id, 72) }, { onThreadPost: async () => {}, onFinishPass: async () => ({ stale: false }) });
				const polishPage = await browser.newPage();
				try {
					await polishPage.goto(polishServer.url, { waitUntil: "domcontentloaded" });
					await polishPage.waitForFunction(() => document.querySelector('[data-file-nav="0"]'), { polling: 100 });
					await polishPage.evaluate(() => {
						window.__cardResizes = 0;
						document.addEventListener("marginalia:cards-resized", () => { window.__cardResizes += 1; });
						document.querySelector('[data-file-nav="0"]').click();
					});
					assert.equal(await polishPage.$eval('[data-commentary-composer="new-file"]', (composer) => composer.classList.contains("collapsed") && composer.querySelector("textarea").offsetParent === null), true, "Commentary composers start as a collapsed Reply… line with the box hidden.");
					await polishPage.click('[data-commentary-composer="new-file"] [data-composer-expand]');
					assert.equal(await polishPage.evaluate(() => {
						const composer = document.querySelector('[data-commentary-composer="new-file"]');
						return !composer.classList.contains("collapsed") && document.activeElement === composer.querySelector("textarea") && window.__cardResizes === 1;
					}), true, "The affordance expands the composer, focuses the box, and dispatches marginalia:cards-resized.");
					await polishPage.keyboard.press("Escape");
					await polishPage.waitForFunction(() => document.querySelector('[data-commentary-composer="new-file"]').classList.contains("collapsed"), { polling: 100 });
					assert.equal(await polishPage.evaluate(() => window.__cardResizes), 2, "Blurring an empty composer collapses it and dispatches marginalia:cards-resized again.");
					await polishPage.click('[data-commentary-composer="new-file"] [data-composer-expand]');
					await polishPage.type('[data-commentary-composer="new-file"] textarea', "draft in progress");
					await polishPage.keyboard.press("Escape");
					assert.equal(await polishPage.$eval('[data-commentary-composer="new-file"]', (composer) => composer.classList.contains("collapsed")), false, "A composer holding a draft never collapses on blur.");
					const polishSelect = async (spanIndex, text) => {
						await polishPage.evaluate((index) => {
							const code = document.querySelectorAll('[data-review-file="0"] .diff-add .diff-code span')[index];
							const range = document.createRange();
							range.selectNodeContents(code);
							const selection = window.getSelection();
							selection.removeAllRanges();
							selection.addRange(range);
							code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
						}, spanIndex);
						await polishPage.waitForFunction(() => document.querySelector('[data-review-file="0"] [data-selection-composer]')?.hidden === false, { polling: 100 });
						await polishPage.type('[data-review-file="0"] [data-selection-feedback]', text);
						await polishPage.$eval('[data-review-file="0"] [data-selection-add]', (button) => button.click());
					};
					const longBody = "This opening message runs well past the eighty character mark so the compact row must truncate it.";
					await polishSelect(1, longBody);
					await polishPage.waitForFunction(() => document.querySelectorAll('[data-review-file="0"] [data-selection-threads] .thread-card').length === 1, { polling: 100 });
					assert.equal(await polishPage.$eval('[data-review-file="0"] [data-selection-threads] .thread-card .reply-composer', (composer) => composer.classList.contains("collapsed")), true, "A fresh thread card leads with the collapsed Reply… line.");
					await polishPage.$eval('[data-review-file="0"] [data-selection-threads] .thread-card [data-composer-expand]', (button) => button.click());
					assert.equal(await polishPage.evaluate(() => {
						const probe = document.createElement("button");
						probe.style.backgroundColor = "var(--accent)";
						document.body.append(probe);
						const accent = getComputedStyle(probe).backgroundColor;
						probe.remove();
						const send = document.querySelector('[data-review-file="0"] [data-selection-threads] .thread-card [data-thread-send]');
						const resolve = document.querySelector('[data-review-file="0"] [data-selection-threads] .thread-card [data-thread-resolve]');
						const style = getComputedStyle(send);
						return send.disabled && style.cursor === "not-allowed" && style.backgroundColor === accent && getComputedStyle(resolve).backgroundColor === "rgba(0, 0, 0, 0)";
					}), true, "The disabled Reply button keeps the accent primary treatment with a not-allowed cursor while Resolve stays secondary.");
					await polishSelect(0, "First line note.");
					await polishPage.waitForFunction(() => document.querySelectorAll('[data-review-file="0"] [data-selection-threads] .thread-card').length === 2, { polling: 100 });
					assert.deepEqual(await polishPage.$$eval('[data-review-file="0"] [data-selection-threads] .thread-card', (cards) => cards.map((card) => card.dataset.anchorStart)), ["1", "2"], "Rail cards file in anchor order, not creation order.");
					await polishPage.$eval('.thread-card[data-anchor-start="2"] [data-thread-resolve]', (button) => button.click());
					await polishPage.waitForFunction(() => document.querySelector('.thread-card[data-anchor-start="2"].resolved [data-resolved-toggle]'), { polling: 100 });
					assert.equal(await polishPage.evaluate((body) => {
						const card = document.querySelector('.thread-card[data-anchor-start="2"]');
						const summary = card.querySelector("[data-resolved-toggle]");
						return card.querySelector(".resolved-detail").hidden
							&& summary.querySelector(".anchor-chip").textContent === "new lines 2"
							&& summary.querySelector(".resolved-first").textContent === body.slice(0, 80) + "…"
							&& summary.querySelector(".resolved-tick").textContent === "✓";
					}, longBody), true, "A resolved card compacts to its anchor chip, truncated first message, and tick.");
					const resizesBeforeToggle = await polishPage.evaluate(() => window.__cardResizes);
					await polishPage.click('.thread-card[data-anchor-start="2"] [data-resolved-toggle]');
					assert.equal(await polishPage.evaluate((body) => {
						const card = document.querySelector('.thread-card[data-anchor-start="2"]');
						return !card.querySelector(".resolved-detail").hidden && card.textContent.includes(body);
					}, longBody), true, "Clicking the compact row expands the full resolved history.");
					assert.equal(await polishPage.evaluate((before) => window.__cardResizes > before, resizesBeforeToggle), true, "The resolved toggle dispatches marginalia:cards-resized.");
					await polishPage.click('.thread-card[data-anchor-start="2"] [data-resolved-toggle]');
					assert.equal(await polishPage.$eval('.thread-card[data-anchor-start="2"] .resolved-detail', (detail) => detail.hidden), true, "A second click compacts the resolved card again.");
					await polishPage.close();
				} finally {
					await polishServer.close();
				}
			}

			// Code-mode rail alignment: commentary and comment cards sit beside
			// their anchored diff rows once the anchor clears the rail's own
			// furniture, and anchorless notes keep the plain stack at the top.
			{
				await writeFile(join(contextRepo, "tall.txt"), `${Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
				const tallReview = applyReviewManifest(await collectReviewSnapshot(contextRepo), {
					files: [{
						path: "tall.txt",
						summary: "Tall fixture for rail alignment.",
						commentary: [
							{ id: "deep-note", body: "About the tail.", side: "new", startLine: 50, endLine: 50 },
							{ id: "loose-note", body: "General remark with no anchor." },
						],
					}],
				});
				const tallServer = await createCodeReviewServer(tallReview, { onThreadPost: async () => {}, onFinishPass: async () => ({ stale: false }) });
				const tallPage = await browser.newPage();
				try {
					await tallPage.setViewport({ width: 1300, height: 800 });
					await tallPage.goto(tallServer.url, { waitUntil: "domcontentloaded" });
					await tallPage.waitForFunction(() => document.querySelector('.review-file.active[data-path="tall.txt"] .agent-note'), { polling: 100 });
					const codeAligned = `(() => {
						const note = document.querySelector('.agent-note[data-commentary-id="deep-note"]');
						const loose = document.querySelector('.agent-note[data-commentary-id="loose-note"]');
						const row = document.querySelector('[data-path="tall.txt"] tr[data-new-line="50"]');
						return Math.abs(note.getBoundingClientRect().top - row.getBoundingClientRect().top) <= 2
							&& loose.getBoundingClientRect().bottom <= note.getBoundingClientRect().top;
					})()`;
					await tallPage.waitForFunction(codeAligned, { polling: 100 });
					assert.equal(await tallPage.evaluate(codeAligned), true, "Code-mode notes align beside their anchored rows while anchorless notes keep the top stack.");
					await tallPage.evaluate(() => {
						const code = document.querySelector('[data-path="tall.txt"] tr[data-new-line="20"] .diff-code span');
						const range = document.createRange();
						range.selectNodeContents(code);
						const selection = window.getSelection();
						selection.removeAllRanges();
						selection.addRange(range);
						code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
					});
					await tallPage.waitForFunction(() => document.querySelector('[data-path="tall.txt"] [data-selection-composer]')?.hidden === false, { polling: 100 });
					await tallPage.type('[data-path="tall.txt"] [data-selection-feedback]', "Mid-file comment.");
					await tallPage.$eval('[data-path="tall.txt"] [data-selection-add]', (button) => button.click());
					await tallPage.waitForFunction(() => document.querySelector('[data-path="tall.txt"] .thread-card'), { polling: 100 });
					const codeCardAligned = `(() => {
						const card = document.querySelector('[data-path="tall.txt"] .thread-card[data-anchor-start="20"]');
						const row = document.querySelector('[data-path="tall.txt"] tr[data-new-line="20"]');
						return Boolean(card && row) && Math.abs(card.getBoundingClientRect().top - row.getBoundingClientRect().top) <= 2;
					})()`;
					await tallPage.waitForFunction(codeCardAligned, { polling: 100 });
					assert.equal(await tallPage.evaluate(codeCardAligned), true, "A code selection card aligns exactly beside its anchored diff row.");
					await tallPage.close();
				} finally {
					await tallServer.close();
				}
			}

			// Per-file drift marks: the staleness event lights amber dots on exactly
			// the drifted sidebar entries and lists every path in the badge tooltip.
			let driftProbeId = altId(ordered.id, 70);
			let driftProbeFiles = ordered.files.map((file) => ({ path: file.path, key: reviewFileDriftKey(file) }));
			let driftProbeFingerprint = "drift-fp-1";
			const driftServer = await createCodeReviewServer({ ...ordered, id: altId(ordered.id, 70) }, {
				onThreadPost: async () => {},
				onFinishPass: async () => ({ stale: false }),
				staleness: {
					fingerprint: async () => driftProbeFingerprint,
					snapshot: async () => ({ id: driftProbeId, files: driftProbeFiles }),
				},
			});
			try {
				const driftPage = await browser.newPage();
				await driftPage.goto(driftServer.url, { waitUntil: "domcontentloaded" });
				await driftPage.waitForFunction(() => document.querySelector("[data-drift-mark]"), {});
				assert.equal(await driftPage.evaluate(() => document.querySelectorAll("[data-drift-mark]:not([hidden])").length), 0, "A clean worktree shows no drift marks.");
				const driftedPath = ordered.files[0].path;
				driftProbeFingerprint = "drift-fp-2";
				driftProbeId = "drifted";
				driftProbeFiles = [...driftProbeFiles.slice(1), { path: driftedPath, key: "edited" }, { path: "joined-later.txt", key: "new" }];
				await driftServer.checkStaleness();
				await driftPage.waitForFunction((path) => {
					const marks = [...document.querySelectorAll("[data-drift-mark]:not([hidden])")];
					return marks.length === 1 && marks[0].dataset.driftMark === path;
				}, { polling: 100 }, driftedPath);
				assert.equal(await driftPage.$eval("[data-stale-badge]", (badge) => badge.hidden), false, "Drift still raises the global badge.");
				assert.match(await driftPage.$eval("[data-stale-badge]", (badge) => badge.title), /Changed: joined-later\.txt|Changed: .*joined-later\.txt/, "The badge tooltip lists drifted paths outside this review too.");
				// Marks obey the badge's suppression: finishing the round flips the
				// phase to revising, where drift is expected and must go quiet.
				await driftPage.click("[data-finish]");
				await driftPage.waitForFunction(() => document.querySelector("[data-finish-overlay]")?.hidden === false, { polling: 100 });
				await driftPage.click("[data-finish-confirm]");
				await driftPage.waitForFunction(() => document.body.dataset.phase === "revising" || document.querySelector("[data-resume]")?.offsetParent, { polling: 100 });
				await driftPage.waitForFunction(() => document.querySelectorAll("[data-drift-mark]:not([hidden])").length === 0, { polling: 100 });
				assert.equal(await driftPage.$eval("[data-stale-badge]", (badge) => badge.hidden), true, "The badge is suppressed while Pi revises — and the marks with it.");
				await driftPage.waitForFunction(() => document.querySelector("[data-resume]")?.offsetParent, { polling: 100 });
				await driftPage.click("[data-resume]");
				await driftPage.waitForFunction((path) => document.querySelectorAll("[data-drift-mark]:not([hidden])").length === 1 && document.querySelector(`[data-drift-mark="${path}"]:not([hidden])`), { polling: 100 }, driftedPath);
				driftProbeFingerprint = "drift-fp-3";
				driftProbeId = altId(ordered.id, 70);
				driftProbeFiles = ordered.files.map((file) => ({ path: file.path, key: reviewFileDriftKey(file) }));
				await driftServer.checkStaleness();
				await driftPage.waitForFunction(() => document.querySelectorAll("[data-drift-mark]:not([hidden])").length === 0, { polling: 100 });
				assert.equal(await driftPage.$eval("[data-stale-badge]", (badge) => badge.hidden), true, "A clean verdict clears the badge with the marks.");
				await driftPage.close();
			} finally {
				await driftServer.close();
			}
			// Option C: while Pi revises, composing stays open but everything queues
			// for the next round — live delivery, resolves, and passes wait.
			const quietServer = await createCodeReviewServer({ ...ordered, id: altId(ordered.id, 80) }, { onThreadPost: async () => {}, onFinishPass: async () => ({ stale: false }) });
			try {
				const quietPage = await browser.newPage();
				await quietPage.goto(quietServer.url, { waitUntil: "domcontentloaded" });
				await quietPage.waitForFunction(() => document.querySelector("[data-file-nav]"), { polling: 100 });
				await quietPage.evaluate(() => document.querySelector("[data-file-nav]").click());
				await quietPage.waitForFunction(() => document.querySelector(".review-file.active"), { polling: 100 });
				await quietPage.click("[data-finish]");
				await quietPage.waitForFunction(() => document.querySelector("[data-finish-overlay]")?.hidden === false, { polling: 100 });
				await quietPage.click("[data-finish-confirm]");
				await quietPage.waitForFunction(() => document.body.classList.contains("quiet-only"), { polling: 100 });
				assert.match(await quietPage.$eval("[data-phase-banner-text]", (bannerText) => bannerText.textContent), /queue for the next round/, "The revising banner explains the quiet window.");
				assert.equal(await quietPage.$eval("[data-finish]", (button) => getComputedStyle(button).display), "none", "There is no pass to send while Pi revises.");
				await quietPage.evaluate(() => {
					const rowSelector = "tr.diff-add .diff-code span, tr.diff-del .diff-code span, tr.diff-context .diff-code span";
					const code = document.querySelector(".review-file.active").querySelector(rowSelector);
					const range = document.createRange();
					range.selectNodeContents(code);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				});
				await quietPage.waitForFunction(() => document.querySelector(".review-file.active [data-selection-composer]")?.hidden === false, { polling: 100 });
				assert.equal(await quietPage.$eval(".review-file.active [data-selection-add]", (button) => button.textContent), "Queue for next round", "The composer is honest about where the comment goes.");
				await quietPage.type(".review-file.active [data-selection-feedback]", "Noted while you revise.");
				await quietPage.click(".review-file.active [data-selection-add]");
				await quietPage.waitForFunction(() => document.querySelector(".thread-card.queued"), { polling: 100 });
				assert.equal(await quietPage.$eval(".thread-card.queued [data-thread-resolve]", (button) => getComputedStyle(button).display), "none", "Resolution waits for the next round.");
				await quietPage.click("[data-resume]");
				await quietPage.waitForFunction(() => !document.body.classList.contains("quiet-only"), { polling: 100 });
				assert.equal(await quietPage.$eval(".review-file.active [data-selection-add]", (button) => button.textContent), "Post comment", "Resume restores live posting labels.");
				assert.notEqual(await quietPage.$eval(".thread-card.queued [data-thread-resolve]", (button) => getComputedStyle(button).display), "none", "Resume restores resolution controls.");
				await quietPage.close();
			} finally {
				await quietServer.close();
			}
			console.log("Headless browser live-thread flow passed.");
		} finally {
			await browser.close();
			await browserServer.close();
		}
	} else {
		console.log("Headless browser live-thread flow skipped: Chrome/Chromium not found.");
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
	console.log("marginalia regression checks passed.");
} finally {
	await rm(fixture, { recursive: true, force: true });
	if (contextRepo) await rm(contextRepo, { recursive: true, force: true });
}
