import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { applyReviewManifest, collectReviewSnapshot, parseUnifiedPatch, REVIEW_LIMITS } from "../shared/git-review.js";
import { formatReviewPassXml, formatThreadMessageXml } from "../shared/feedback.js";
import { renderReviewHtml } from "../shared/render.js";
import { createCodeReviewServer } from "../shared/server.js";
import { buildCarriedThreads, createThreadStore, THREAD_LIMITS } from "../shared/threads.js";
import { createReviewMessageQueue } from "../shared/delivery-queue.js";

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
	assert.match(threadXml, /^<code-review-thread snapshot="[a-f0-9]{64}" thread="[a-f0-9]{8}-[a-f0-9]{6}-t3" kind="selection" status="open" file="untracked.txt" side="new" new-start="1" new-end="2">/);
	assert.match(threadXml, /A \]\]\]\]><!\[CDATA\[> marker/, "CDATA terminators must be split safely.");
	assert.match(threadXml, /<message author="user"><!\[CDATA\[Actually, one more thing\.\]\]><\/message>/);
	const passXml = formatReviewPassXml(ordered, store.list(), store.summary(), false, "Note ]]> here");
	assert.match(passXml, /^<code-review-pass snapshot="[a-f0-9]{64}" stale="false" open="5" awaiting-user="1" awaiting-pi="4" resolved="0" unread-notes="1">/, "Header counts must reconcile with the omitted untouched notes.");
	assert.match(passXml, /<note><!\[CDATA\[Note \]\]\]\]><!\[CDATA\[> here\]\]><\/note>/, "Finish notes must be serialized safely.");
	assert.match(passXml, /<open-thread thread="[a-f0-9]{8}-[a-f0-9]{6}-t1" kind="commentary" status="open" file="untracked.txt" commentary-id="new-file" last-author="user">/);
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
	assert.equal(carriedRecords[0].carried.placement, "outdated");
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
	assert.match(carryHtml, new RegExp(`data-carried-thread="${carriedRecords[1].id}"[^>]*data-anchor-side="new" data-anchor-start="1"`), "Anchored carried shells must expose their jump anchor.");
	assert.match(carryHtml, new RegExp(`href="/round/1#thread=${carriedRecords[1].id}"`), "Carried shells must deep-link to their origin round.");
	assert.match(carryHtml, /Outdated threads/, "Anchor-less carried threads land on the overview.");
	assert.match(carryHtml, /outdated — anchored to round 1/);
	assert.match(carryHtml, /Resolved in earlier rounds \(1\)/, "Prior-round resolutions collect in the overview archive.");
	assert.match(carryHtml, /href="\/round\/1#thread=abc-t9"/);

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
	const html = renderReviewHtml(ordered, "safe-nonce");
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "Manifest text must be escaped.");
	assert.match(html, /Review this first &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /data-review-overview/, "Agent-guided reviews should begin with an overview page.");
	assert.match(html, /data-overview-feedback/, "The overview should accept general change-set feedback.");
	assert.match(html, /data-finish/, "The topbar should expose the finish-pass action.");
	assert.match(html, /data-inbox/, "The topbar should expose the awaiting-you inbox strip.");
	assert.match(html, /data-selection-threads/, "Each file should host selection comment threads.");
	assert.match(html, /data-commentary-thread="new-file"/, "Each commentary card should host its live thread.");
	assert.match(html, /data-commentary-resolve="new-file"/, "Commentary cards should offer resolve without a reply.");
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
		onThreadPost: async (round, thread, turn) => {
			if (failNextPost) {
				failNextPost = false;
				throw new Error("delivery boom");
			}
			posts.push({ round: round.number, thread, turn });
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
		assert.equal(posts[0].turn.body, "Explain this line.");

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
		assert.deepEqual(passes[0].summary, { open: 1, awaitingUser: 0, awaitingPi: 1, resolved: 2 });
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
		const firstFinish = fetch(`${origin}/__pi_code_review_finish__`, request);
		await concurrentFinishEntered;
		const secondFinish = await fetch(`${origin}/__pi_code_review_finish__`, request);
		assert.equal(secondFinish.status, 409, "A concurrent finish must be rejected while the first handoff is pending.");
		releaseConcurrentFinish();
		assert.equal((await firstFinish).status, 200);
		assert.equal(concurrentFinishCalls, 1, "Concurrent finish requests must invoke the handoff exactly once.");
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

	const altId = (id, index) => `${id.slice(0, index)}${id[index] === "0" ? "1" : "0"}${id.slice(index + 1)}`;
	const roundsServer = await createCodeReviewServer(ordered, {
		onThreadPost: async () => {},
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
		assert.equal((await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ round: 1, source: "overview", body: "late" }) })).status, 409, "Posting is locked while Pi revises.");
		assert.equal((await fetch(resolveEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: roundsPost.thread.id, resolved: true }) })).status, 409, "Resolution is locked while Pi revises.");
		assert.equal((await fetch(resumeEndpoint, { method: "POST", headers, body: "{}" })).status, 200);
		await readUntil('"phase":"reviewing"');
		assert.equal((await fetch(resolveEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: roundsPost.thread.id, resolved: true }) })).status, 200, "Resume unlocks the round for mutations.");

		const secondRoundReview = { ...ordered, id: altId(ordered.id, 63) };
		assert.equal(roundsServer.addRound(secondRoundReview, "0".repeat(64)).error, "unknown-round", "Chaining from an unknown round must be rejected.");
		assert.deepEqual(roundsServer.addRound({ ...ordered }, ordered.id), { identical: true, round: 1 }, "An unchanged snapshot must not open a hollow round.");
		assert.equal(roundsServer.addRound(secondRoundReview, ordered.id).round, 2);
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
		const eligibleIds = roundsServer.threads().filter((thread) => thread.status === "open" && thread.turns.some((turn) => turn.author === "user")).map((thread) => thread.id);
		assert.equal(eligibleIds.length, 2);
		const thirdRoundReview = { ...ordered, id: altId(ordered.id, 61) };
		const carriedAdd = roundsServer.addRound(thirdRoundReview, secondRoundReview.id, eligibleIds.map((id, index) => ({ respondsTo: id, resolution: index === 0 ? "addressed" : "declined", body: `Response ${index}.`, ...(index === 0 ? { file: "untracked.txt", side: "new", startLine: 1 } : {}) })));
		assert.equal(carriedAdd.round, 3, "Complete responses open the next round with carried threads.");
		const carriedThread = roundsServer.getThread(eligibleIds[0]);
		assert.equal(carriedThread.carried.fromRound, 2);
		assert.equal(carriedThread.carried.placement, "anchored");
		assert.equal(carriedThread.piProposedResolve, true);
		assert.deepEqual(roundsServer.locateThread(eligibleIds[0]), { round: 3, current: true }, "Carried ids resolve to the living copy in the newest round.");
		assert.ok(roundsServer.postPiReply(eligibleIds[0], "Follow-up.", false), "Pi replies to carried threads in the current round.");
		const carriedReply = await fetch(postEndpoint, { method: "POST", headers, body: JSON.stringify({ threadId: eligibleIds[0], body: "Reviewer follow-up." }) });
		assert.equal(carriedReply.status, 200, "Reviewer replies land in the carried copy, not the archived one.");
		assert.match(await (await fetch(`${origin}/round/3`, { headers: { cookie } })).text(), /Resolved in earlier rounds/, "Round pages surface the prior-round archive.");

		const entry = roundsServer.entryUrl();
		assert.equal((await fetch(entry, { redirect: "manual" })).status, 302, "Reissued entry links must authenticate.");
		assert.equal((await fetch(entry, { redirect: "manual" })).status, 403, "Reissued entry links must be single-use.");
		await reader.cancel();
	} finally {
		await roundsServer.close();
	}

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
		const finishPromise = fetch(`${origin}/__pi_code_review_finish__`, { method: "POST", headers, body: "{}" });
		await raceFinishEntered;
		assert.equal(raceServer.addRound({ ...ordered, id: altId(ordered.id, 63) }, ordered.id).round, 2, "Pi may open the next round while the finish handoff is in flight.");
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
			onThreadPost: async (round, thread, turn) => { browserPosts.push({ thread, turn }); },
			onFinishPass: async (round, note, threadList, summary) => { browserPass = { round: round.number, note, threadList, summary }; return { stale: false }; },
		});
		const browser = await puppeteer.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
		try {
			const page = await browser.newPage();
			await page.goto(browserServer.url, { waitUntil: "domcontentloaded" });
			assert.equal(await page.$eval('[data-review-overview]', (section) => section.hidden), false, "Agent-guided reviews should open on the overview.");
			assert.equal(await page.$eval('details.reference-files', (details) => details.open), false, "Reference files should start collapsed.");
			await page.waitForFunction(() => document.querySelector('[data-thread-tally]')?.hidden === false);
			assert.match(await page.$eval('[data-thread-tally]', (section) => section.textContent), /2 open.*2 awaiting you.*0 awaiting Pi.*0 resolved/, "Seeded notes count uniformly from the start.");
			assert.equal(await page.$eval('[data-inbox]', (strip) => strip.hidden), false, "Unread notes surface in the inbox immediately.");
			assert.match(await page.$eval('[data-inbox]', (strip) => strip.textContent), /^2 awaiting you/);
			await page.keyboard.press("n");
			await page.waitForFunction(() => document.querySelector('[data-review-file="0"]')?.hidden === false);
			assert.ok(await page.$('.agent-note.thread-flash[data-commentary-id="new-file"]'), "n must reach unresolved Pi notes when no thread awaits.");
			await page.keyboard.press("n");
			assert.ok(await page.$('.agent-note.thread-flash[data-commentary-id="second-note"]'), "n must cycle through the remaining unresolved notes.");
			assert.equal(await page.$('.agent-note.thread-flash[data-commentary-id="new-file"]'), null, "Only the current navigation target should be highlighted.");
			await page.keyboard.press("N");
			assert.ok(await page.$('.agent-note.thread-flash[data-commentary-id="new-file"]'), "Shift+n must step backwards through the awaiting queue.");
			await page.click('[data-overview-nav]');
			await page.click('details.reference-files > summary');
			const referenceIndex = await page.$eval('details.reference-files [data-file-nav]', (item) => Number(item.dataset.fileNav));
			await page.click(`[data-file-nav="${referenceIndex}"]`);
			assert.equal(await page.$eval(`[data-file-nav="${referenceIndex}"]`, (item) => item.classList.contains("active")), true, "Clicking a regrouped reference file should activate its own navigation item.");
			assert.equal(await page.$eval(`[data-review-file="${referenceIndex}"]`, (section) => section.dataset.reviewMode), "reference", "Reference files should remain directly inspectable.");
			assert.equal(await page.$eval(`[data-review-file="${referenceIndex}"] .file-header > span`, (label) => label.textContent), "Reference file");
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
			await page.waitForFunction(() => document.querySelector('[data-review-file="0"] [data-selection-threads] .thread-card'));
			assert.equal(await page.$eval('[data-review-file="0"] [data-selection-composer]', (composer) => composer.hidden), true, "Command+Enter should post the comment thread without finishing the pass.");
			assert.equal(await page.evaluate(() => CSS.highlights.get("pi-code-review-feedback")?.size), 1);
			assert.equal(browserPosts.length, 1, "Posting a selection comment must deliver one thread message to Pi.");
			assert.equal(browserPosts[0].thread.file, "untracked.txt");
			assert.equal(browserPosts[0].thread.side, "new");
			assert.equal(browserPosts[0].turn.body, "Please rename this.");
			const liveThreadId = browserPosts[0].thread.id;
			browserServer.postPiReply(liveThreadId, "Because generated names collide.", true);
			await page.waitForFunction(() => document.querySelector('.thread-card.awaiting .thread-turn.turn-pi'));
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
			await page.type('[data-review-file="0"] [data-commentary-reply="new-file"]', "Why not generate this?");
			await page.click('[data-commentary-post="new-file"]');
			await page.waitForFunction(() => document.querySelector('[data-commentary-thread="new-file"] .thread-card'));
			assert.equal(await page.$eval('[data-commentary-composer="new-file"]', (composer) => composer.hidden), true, "The commentary composer should collapse into its live thread.");
			assert.doesNotMatch(await page.$eval('[data-commentary-thread="new-file"] .thread-card', (card) => card.textContent), /Why this exists/, "Commentary threads must not duplicate Pi's rendered note.");
			const commentaryThreadId = browserPosts.find((post) => post.thread.source === "commentary").thread.id;
			browserServer.postPiReply(commentaryThreadId, "It stays handwritten for clarity.", false);
			await page.waitForFunction((id) => document.querySelector(`[data-thread-card="${id}"] .thread-turn.turn-pi`), {}, commentaryThreadId);
			await page.type(`[data-thread-card="${commentaryThreadId}"] [data-thread-reply]`, "Good, keep it handwritten.");
			await page.click(`[data-thread-card="${commentaryThreadId}"] [data-thread-send]`);
			await page.waitForFunction((id) => document.querySelectorAll(`[data-thread-card="${id}"] .thread-turn`).length === 3, {}, commentaryThreadId);
			assert.equal(await page.$eval(`[data-thread-card="${commentaryThreadId}"] [data-thread-reply]`, (textarea) => textarea.value), "", "Sending a thread reply must clear its draft.");
			assert.match(await page.$eval('[data-inbox]', (strip) => strip.textContent), /^1 awaiting you/, "After replying, only the unread note remains awaiting.");
			await page.click('[data-commentary-resolve="second-note"]');
			await page.waitForFunction(() => document.querySelector('[data-commentary-thread="second-note"] .thread-card.resolved'));
			assert.equal(browserPosts.length, 3, "Resolving a note must not message Pi.");
			assert.equal(await page.$eval('[data-inbox]', (strip) => strip.hidden), true, "Resolving the last unread note clears the inbox.");
			await page.click('[data-commentary-thread="second-note"] [data-thread-resolve]');
			await page.waitForFunction(() => !document.querySelector('[data-commentary-thread="second-note"] .thread-card'));
			assert.equal(await page.$eval('[data-commentary-composer="second-note"]', (composer) => composer.hidden), false, "Reopening an untouched note removes its card and restores the composer.");
			assert.match(await page.$eval('[data-inbox]', (strip) => strip.textContent), /^1 awaiting you/, "A reopened note awaits the reviewer again.");
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
			page.once("dialog", async (dialog) => { await dialog.dismiss(); });
			await page.click(`[data-file-nav="${secondReviewIndex}"]`);
			assert.equal(await page.$eval('[data-review-file="0"]', (section) => section.hidden), false, "Dismissing the draft warning must keep the current file and draft visible.");
			page.once("dialog", async (dialog) => { await dialog.accept(); });
			await page.click(`[data-file-nav="${secondReviewIndex}"]`);
			assert.equal(await page.$eval(`[data-review-file="${secondReviewIndex}"]`, (section) => section.hidden), false, "Confirming draft discard should allow explicit file navigation.");
			assert.equal(await page.$eval(`[data-file-nav="${secondReviewIndex}"]`, (item) => item.classList.contains("active")), true, "Regrouped primary navigation should activate by file index rather than DOM position.");
			page.once("dialog", async (dialog) => { await dialog.accept(); });
			await page.click("[data-finish]");
			await page.waitForFunction(() => document.querySelector('[data-phase-banner]')?.hidden === false);
			assert.ok(browserPass, "Finishing the pass must hand the summary to Pi.");
			assert.equal(browserPass.round, 1);
			assert.deepEqual(browserPass.summary, { open: 3, awaitingUser: 0, awaitingPi: 3, resolved: 2 });
			assert.equal(await page.evaluate(() => document.body.classList.contains("locked")), true, "Sending the pass locks posting.");
			assert.match(await page.$eval('[data-phase-banner-text]', (el) => el.textContent), /Pi is revising — round 2 pending/);
			assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-finish]')).display), "none", "Posting controls must hide while Pi revises.");
			await page.click('[data-resume]');
			await page.waitForFunction(() => document.querySelector('[data-phase-banner]')?.hidden === true);
			assert.equal(await page.evaluate(() => document.body.classList.contains("locked")), false, "Resume must unlock the round.");

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
			assert.equal(await page.$$eval('[data-outdated-threads] [data-carried-thread]', (shells) => shells.length), 1, "Anchor-less responses land in the overview's outdated strip.");
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
			const round3Responses = browserServer.threads().filter((thread) => thread.status === "open" && thread.turns.some((turn) => turn.author === "user")).map((thread) => ({ respondsTo: thread.id, resolution: "needs-discussion", body: "Carrying into round 3." }));
			assert.equal(browserServer.addRound({ ...ordered, id: altId(ordered.id, 62) }, nextRoundReview.id, round3Responses).round, 3, "The session advances while the drift tab is disconnected.");
			heldEvents.continue().catch(() => {});
			await driftPage.waitForFunction(() => document.body.dataset.round === "3", { timeout: 5_000 });
			assert.match(await driftPage.$eval('[data-round-chip]', (chip) => chip.textContent), /round 3/, "A current-round tab that slept through round-ready must catch up on reconnect.");
			await driftPage.close();

			const plainServer = await createCodeReviewServer(plainReview, { onThreadPost: async () => {}, onFinishPass: async () => ({ stale: false }) });
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
				await plainPage.close();
			} finally {
				await plainServer.close();
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
	console.log("pi-code-review regression checks passed.");
} finally {
	await rm(fixture, { recursive: true, force: true });
}
