import { readFileSync } from "node:fs";
import { computeContextGaps } from "./git-review.js";
import { renderMarkdown } from "./markdown.js";

const CLIENT_SOURCE = readFileSync(new URL("../client/review.js", import.meta.url), "utf8");
// The markdown renderer is one source of truth used in both contexts: imported
// above for server-side rendering, and served to the browser with the module
// syntax stripped so the client renders live thread turns identically.
const MARKDOWN_SOURCE = readFileSync(new URL("./markdown.js", import.meta.url), "utf8").replace(/^export /gm, "");
// The diagram element parser ships to the browser the same way: annotation in
// the client and validation on the server share one implementation, so an
// element that validates is an element that renders clickable, by construction.
const DIAGRAM_SOURCE = readFileSync(new URL("./diagram.js", import.meta.url), "utf8").replace(/^export /gm, "");

function text(value) {
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attribute(value) {
	return text(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function rangeLabel(entry, planMode) {
	if (entry.startLine === undefined) return planMode ? "Section note" : "File note";
	// Plans have no diff sides; the side word is diff vocabulary.
	const side = planMode || entry.side === "both" ? "lines" : `${entry.side} lines`;
	return `${side} ${entry.startLine}${entry.endLine !== entry.startLine ? `–${entry.endLine}` : ""}`;
}

const RESOLUTION_LABELS = { addressed: "Addressed", declined: "Declined", "needs-discussion": "Needs discussion" };

// A ~40-character quote of the anchored content, rendered after a line-range
// chip so it reads as "lines 12–14 · const total = …" instead of a bare range.
function anchorPreview(content) {
	if (typeof content !== "string") return "";
	const compact = content.trim().replace(/\s+/g, " ");
	if (!compact) return "";
	return `<span class="anchor-preview">${text(compact.length > 40 ? `${compact.slice(0, 40)}…` : compact)}</span>`;
}

// The first anchored line's text for a commentary note: plan sections read it
// from their markdown slice, diff files from the rendered line on the note's
// side. Selection threads need no lookup — they carry their highlight.
function anchoredLineText(file, entry, planMode) {
	if (entry.startLine === undefined) return undefined;
	if (planMode) return typeof file.markdown === "string" ? file.markdown.split("\n")[entry.startLine - file.startLine] : undefined;
	const line = (file.lines ?? []).find((candidate) => (entry.side !== "new" && candidate.oldLine === entry.startLine) || (entry.side !== "old" && candidate.newLine === entry.startLine));
	return line?.content;
}

function elementLabel(reference) {
	return "\u2b21 " + String(reference).replace(/^node:/, "").replace(/^edge:(.+)->(.+)$/, "$1 \u2192 $2");
}

function renderCarriedShell(thread) {
	const carried = thread.carried;
	const anchored = carried.placement === "anchored";
	const anchorAttrs = `${anchored ? ` data-anchor-side="${attribute(carried.side)}" data-anchor-start="${carried.startLine}"` : ""}${carried.element === undefined ? "" : ` data-anchor-element="${attribute(carried.element)}"`}`;
	const anchorButton = anchored || carried.element !== undefined
		? `<button type="button" class="agent-note-anchor">${carried.element !== undefined ? text(elementLabel(carried.element)) : `${text(carried.side === "both" ? "lines" : `${carried.side} lines`)} ${carried.startLine}${carried.endLine !== carried.startLine ? `–${carried.endLine}` : ""}${anchorPreview(thread.highlight)}`}</button>`
		: "";
	const outdated = carried.placement === "outdated" ? `<span class="badge outdated-badge">outdated — anchored to round ${Number(carried.fromRound)}</span>` : "";
	return `<article class="carried-thread" data-carried-thread="${attribute(thread.id)}"${anchorAttrs}>
  <div class="carried-header">${carried.resolution === undefined ? "" : `<span class="badge resolution-badge resolution-${attribute(carried.resolution)}">${text(RESOLUTION_LABELS[carried.resolution] ?? carried.resolution)}</span>`}<a class="carried-origin" href="/round/${Number(carried.fromRound)}#thread=${attribute(thread.id)}" title="View this thread in round ${Number(carried.fromRound)} (read-only)">from round ${Number(carried.fromRound)}</a>${anchorButton}${outdated}</div>
  <div data-carried-host="${attribute(thread.id)}"></div>
</article>`;
}

function renderArchive(archive) {
	if (!archive.length) return "";
	const total = archive.reduce((count, entry) => count + entry.resolved.length, 0);
	const rounds = archive.map((entry) => `<div class="archive-round"><h3>Round ${Number(entry.round)}</h3><ul>${entry.resolved.map((thread) => `<li><a href="/round/${Number(entry.round)}#thread=${attribute(thread.id)}">${text(thread.file ?? thread.source)}</a> — ${text((thread.highlight ?? thread.lastBody ?? "").slice(0, 120))}</li>`).join("")}</ul></div>`).join("");
	return `<details class="round-archive" data-round-archive><summary>Resolved in earlier rounds (${total})</summary>${rounds}</details>`;
}

function renderOverview(review, extras) {
	if (!review.overview) return "";
	const overview = review.overview;
	const outdatedThreads = extras.carried.filter((thread) => thread.carried.placement === "outdated");
	const overviewThreads = extras.carried.filter((thread) => thread.carried.placement === "overview");
	const outdatedSection = outdatedThreads.length ? `<section class="outdated-threads" data-outdated-threads><h2>Outdated threads</h2>${outdatedThreads.map(renderCarriedShell).join("\n")}</section>` : "";
	const bullets = (items) => `<ul>${items.map((item) => `<li>${text(item)}</li>`).join("")}</ul>`;
	return `<section class="review-overview active" data-review-overview>
  <header class="overview-header"><div><span class="status">Overview</span><h1>${text(review.title)}</h1></div><span>Pre-PR iteration</span></header>
  <main class="overview-body">
    <section><h2>Intent</h2><p>${text(overview.intent)}</p></section>
    <section><h2>Key changes</h2>${bullets(overview.changes)}</section>
    <section><h2>Validation</h2>${bullets(overview.validation)}</section>
    ${overview.reviewFocus ? `<section><h2>Review focus</h2><ul><li>${text(overview.reviewFocus)}</li></ul></section>` : ""}
    ${overview.risks ? `<section><h2>Risks / limitations</h2><ul><li>${text(overview.risks)}</li></ul></section>` : ""}
    <section class="thread-tally" data-thread-tally hidden></section>
    ${outdatedSection}
    <section class="overview-feedback"><h2>General feedback</h2>${overviewThreads.map(renderCarriedShell).join("\n")}<div data-overview-thread></div><div data-overview-composer><textarea data-overview-feedback maxlength="20000" placeholder="Discuss the change set with Pi"></textarea><div class="composer-actions"><button type="button" data-overview-post title="Post (⌘⏎ live · ⇧⌘⏎ quiet)" disabled>Post to Pi</button></div></div></section>
    ${renderArchive(extras.archive)}
  </main>
</section>`;
}

function renderRemovedElements(diff) {
	if (!diff || !diff.removed.length) return "";
	const items = diff.removed.map((reference) => `<li>${text(elementLabel(reference))} <a href="/round/${Number(diff.fromRound)}" title="View it in round ${Number(diff.fromRound)}">round ${Number(diff.fromRound)}</a></li>`).join("");
	return `<section class="removed-elements" data-removed-elements><h3>Removed this round</h3><ul>${items}</ul></section>`;
}

function renderCommentary(file, carriedForFile, planMode, elementDiff) {
	const carriedCards = carriedForFile.length ? `<section class="carried-threads"><h3>Carried threads</h3>${carriedForFile.map(renderCarriedShell).join("\n")}</section>` : "";
	if (planMode) {
		// The plan reads as one continuous document, so its commentary is a quiet
		// margin rail: only real content renders chrome, and empty rails stay
		// invisible beside their section.
		const cards = file.commentary.map((entry) => `<article class="agent-note" data-commentary-id="${attribute(entry.id)}" data-anchor-side="${attribute(entry.side)}"${entry.startLine === undefined ? "" : ` data-anchor-start="${entry.startLine}" data-anchor-end="${entry.endLine ?? entry.startLine}"`}${entry.element === undefined ? "" : ` data-anchor-element="${attribute(entry.element)}"`}>
  <button type="button" class="agent-note-anchor"${entry.startLine === undefined && entry.element === undefined ? " disabled" : ""}>${entry.element === undefined ? text(rangeLabel(entry, true)) + anchorPreview(anchoredLineText(file, entry, true)) : text(elementLabel(entry.element))}</button>
  <div class="agent-note-body md">${renderMarkdown(entry.body)}</div>
  <div data-commentary-thread="${attribute(entry.id)}"></div>
  <div class="reply-composer collapsed" data-commentary-composer="${attribute(entry.id)}"><button type="button" class="reply-affordance" data-composer-expand>Reply…</button><label>Reply to Pi<textarea data-commentary-reply="${attribute(entry.id)}" maxlength="20000" placeholder="Respond to this note"></textarea></label><div class="composer-actions"><button type="button" data-commentary-resolve="${attribute(entry.id)}" title="Mark this note read; never messages Pi">Resolve</button><button type="button" data-commentary-post="${attribute(entry.id)}" title="Reply (⌘⏎ live · ⇧⌘⏎ quiet)" disabled>Reply</button></div></div>
</article>`).join("\n");
		return `<aside class="commentary-column plan-rail" data-selection-threads aria-label="Pi commentary for ${attribute(file.path)}">
  ${renderRemovedElements(elementDiff)}
  ${carriedCards}
  ${cards}
  <section class="selection-composer" data-selection-composer hidden>
    <div class="selection-quote" data-selection-quote></div>
    <textarea data-selection-feedback maxlength="20000" placeholder="Comment on this selection"></textarea>
    <div class="composer-actions"><button type="button" data-selection-cancel>Cancel</button><button type="button" data-selection-add title="Post comment (⌘⏎ live · ⇧⌘⏎ quiet)" disabled>Post comment</button></div>
  </section>
</aside>`;
	}
	const cards = file.commentary.map((entry) => `<article class="agent-note" data-commentary-id="${attribute(entry.id)}" data-anchor-side="${attribute(entry.side)}"${entry.startLine === undefined ? "" : ` data-anchor-start="${entry.startLine}" data-anchor-end="${entry.endLine ?? entry.startLine}"`}>
  <button type="button" class="agent-note-anchor"${entry.startLine === undefined ? " disabled" : ""}>${text(rangeLabel(entry, planMode))}${anchorPreview(anchoredLineText(file, entry, false))}</button>
  <div class="agent-note-body md">${renderMarkdown(entry.body)}</div>
  <div data-commentary-thread="${attribute(entry.id)}"></div>
  <div class="reply-composer collapsed" data-commentary-composer="${attribute(entry.id)}"><button type="button" class="reply-affordance" data-composer-expand>Reply…</button><label>Reply to Pi<textarea data-commentary-reply="${attribute(entry.id)}" maxlength="20000" placeholder="Respond to this explanation"></textarea></label><div class="composer-actions"><button type="button" data-commentary-resolve="${attribute(entry.id)}" title="Mark this note read; never messages Pi">Resolve</button><button type="button" data-commentary-post="${attribute(entry.id)}" title="Reply (⌘⏎ live · ⇧⌘⏎ quiet)" disabled>Reply</button></div></div>
</article>`).join("\n");
	return `<aside class="commentary-column" aria-label="Pi commentary for ${attribute(file.path)}">
  <h2>Pi commentary</h2>
  <div class="file-summary md">${file.summary ? renderMarkdown(file.summary) : "No file-level commentary supplied."}</div>
  ${carriedCards}
  ${cards || '<p class="empty-note">No anchored commentary for this file.</p>'}
  <section class="user-comments"><h3>Your comment threads</h3><div data-selection-threads></div></section>
  <section class="selection-composer" data-selection-composer hidden>
    <div class="selection-quote" data-selection-quote></div>
    <textarea data-selection-feedback maxlength="20000" placeholder="Comment on this selection"></textarea>
    <div class="composer-actions"><button type="button" data-selection-cancel>Cancel</button><button type="button" data-selection-add title="Post comment (⌘⏎ live · ⇧⌘⏎ quiet)" disabled>Post comment</button></div>
  </section>
</aside>`;
}

/**
 * Character prefix/suffix midpoint of a paired del/add line, expanded to word
 * boundaries. Returns per-side [start, end) ranges, or undefined when the
 * change spans most of both lines (whole-line emphasis is noise, not signal).
 */
export function computeIntraline(oldContent, newContent) {
	if (oldContent === newContent) return undefined;
	const wordChar = /\w/;
	let prefix = 0;
	while (prefix < oldContent.length && prefix < newContent.length && oldContent[prefix] === newContent[prefix]) prefix++;
	let suffix = 0;
	while (suffix < oldContent.length - prefix && suffix < newContent.length - prefix && oldContent[oldContent.length - 1 - suffix] === newContent[newContent.length - 1 - suffix]) suffix++;
	// Never split a surrogate pair: a boundary that strands a high surrogate in
	// the prefix (or a low one in the suffix) would render U+FFFD on both sides.
	if (prefix > 0 && /[\uD800-\uDBFF]/.test(oldContent[prefix - 1])) prefix--;
	if (suffix > 0 && /[\uDC00-\uDFFF]/.test(oldContent[oldContent.length - suffix])) suffix--;
	// Expand outward so a mid-word change highlights the whole word.
	while (prefix > 0 && wordChar.test(oldContent[prefix - 1]) && (wordChar.test(oldContent[prefix] ?? "") || wordChar.test(newContent[prefix] ?? ""))) prefix--;
	while (suffix > 0 && wordChar.test(oldContent[oldContent.length - suffix]) && (wordChar.test(oldContent[oldContent.length - suffix - 1] ?? "") || wordChar.test(newContent[newContent.length - suffix - 1] ?? ""))) suffix--;
	const ranges = {
		del: [prefix, oldContent.length - suffix],
		add: [prefix, newContent.length - suffix],
	};
	const delSpan = ranges.del[1] - ranges.del[0];
	const addSpan = ranges.add[1] - ranges.add[0];
	if ((oldContent.length === 0 || delSpan > 0.7 * oldContent.length) && (newContent.length === 0 || addSpan > 0.7 * newContent.length)) return undefined;
	return ranges;
}

function renderCodeContent(content, emphasis) {
	if (!content) return "\u00a0";
	if (!emphasis || emphasis[1] <= emphasis[0]) return text(content);
	return `${text(content.slice(0, emphasis[0]))}<span class="intraline">${text(content.slice(emphasis[0], emphasis[1]))}</span>${text(content.slice(emphasis[1]))}`;
}

function renderDiffLine(fileIndex, line, lineIndex, emphasis) {
	const oldValue = line.oldLine ?? "";
	const newValue = line.newLine ?? "";
	const selectable = ["add", "del", "context"].includes(line.kind);
	return `<tr class="diff-line diff-${line.kind}" data-file-index="${fileIndex}" data-line-index="${lineIndex}" data-kind="${line.kind}"${line.oldLine === undefined ? "" : ` data-old-line="${line.oldLine}"`}${line.newLine === undefined ? "" : ` data-new-line="${line.newLine}"`}>
  <td class="line-number" aria-label="Old line">${oldValue}</td><td class="line-number" aria-label="New line">${newValue}</td><td class="line-marker" aria-hidden="true">${line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
  <td class="diff-code${selectable ? "" : " unselectable"}" id="diff-${fileIndex}-${lineIndex}"><span>${renderCodeContent(line.content, emphasis)}</span></td>
</tr>`;
}

// Pair the i-th deletion of a del-run with the i-th addition of the add-run
// that immediately follows it — the standard unified-diff replacement shape.
function computeEmphasisMap(lines) {
	const emphasis = new Map();
	for (let index = 0; index < lines.length; index++) {
		if (lines[index].kind !== "del") continue;
		const delStart = index;
		while (index < lines.length && lines[index].kind === "del") index++;
		const addStart = index;
		while (index < lines.length && lines[index].kind === "add") index++;
		const pairs = Math.min(addStart - delStart, index - addStart);
		for (let pair = 0; pair < pairs; pair++) {
			const ranges = computeIntraline(lines[delStart + pair].content, lines[addStart + pair].content);
			if (!ranges) continue;
			emphasis.set(delStart + pair, ranges.del);
			emphasis.set(addStart + pair, ranges.add);
		}
		index--;
	}
	return emphasis;
}

// A gap divider between hunks (or before the first hunk / after the last).
// ⤴ reveals lines from the top of the gap, ⤲ from the bottom; small gaps get a
// single reveal-all control. The trailing gap's size is unknown until the
// pinned HEAD blob is read, so it offers only a top expander.
function renderExpander(fileIndex, gap) {
	const size = gap.oldEnd === Infinity ? undefined : gap.oldEnd - gap.oldStart + 1;
	const buttons = [];
	if (size !== undefined && size <= 20) buttons.push(`<button type="button" data-expand="all" title="Show the hidden line${size === 1 ? "" : "s"}">↕ ${size}</button>`);
	else {
		buttons.push('<button type="button" data-expand="down" title="Show the next 20 hidden lines">⤓ 20</button>');
		if (size !== undefined) {
			if (size <= 500) buttons.push(`<button type="button" data-expand="all" title="Show all ${size} hidden lines">↕ ${size}</button>`);
			buttons.push('<button type="button" data-expand="up" title="Show the 20 hidden lines just above">⤒ 20</button>');
		}
	}
	return `<tr class="diff-expander" data-expander data-file-index="${fileIndex}" data-gap-start="${gap.oldStart}"${size === undefined ? "" : ` data-gap-end="${gap.oldEnd}"`} data-gap-delta="${gap.delta}"><td class="line-number"></td><td class="line-number"></td><td class="line-marker" aria-hidden="true"></td><td class="diff-code unselectable">${buttons.join("")}<span class="expander-note">${size === undefined ? "unchanged lines below" : `${size} unchanged line${size === 1 ? "" : "s"}`}</span></td></tr>`;
}

function renderDiffBody(file, index) {
	const gaps = computeContextGaps(file);
	const trailingGap = gaps.find((gap) => gap.oldEnd === Infinity);
	const finiteGaps = gaps.filter((gap) => gap.oldEnd !== Infinity);
	let gapCursor = 0;
	const emphasis = computeEmphasisMap(file.lines);
	const rows = [];
	for (const [lineIndex, line] of file.lines.entries()) {
		if (line.kind === "hunk" && gapCursor < finiteGaps.length) {
			const hunkOldStart = Number(/^@@ -(\d+)/.exec(line.content)?.[1]);
			if (Number.isFinite(hunkOldStart) && finiteGaps[gapCursor].oldEnd <= hunkOldStart) rows.push(renderExpander(index, finiteGaps[gapCursor++]));
		}
		rows.push(renderDiffLine(index, line, lineIndex, emphasis.get(lineIndex)));
	}
	if (trailingGap) rows.push(renderExpander(index, trailingGap));
	return rows.join("\n");
}

function approveStats(review) {
	if (review.kind === "plan") return `${review.files.length} section${review.files.length === 1 ? "" : "s"} · ${review.markdownLines} lines`;
	const counts = new Map();
	let adds = 0;
	let dels = 0;
	for (const file of review.files) {
		counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
		for (const line of file.lines ?? []) {
			if (line.kind === "add") adds++;
			else if (line.kind === "del") dels++;
		}
	}
	const breakdown = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
	return `${review.files.length} file${review.files.length === 1 ? "" : "s"} (${breakdown}) · +${adds} −${dels} rendered`;
}

function renderFile(file, index, carriedByFile, viewedSet, planMode, elementDiffFor = () => undefined) {
	if (planMode) {
		// The plan reads as one continuous document: every section stays visible
		// and the sidebar scrolls instead of switching panels. active tracks the
		// reading position (and the visible section in the focus toggle's view).
		// No header bar, no box: the section's own markdown heading marks the
		// section, and the margin rail carries its commentary.
		const sectionDiff = elementDiffFor(file.path);
		return `<section class="review-file${file.initiallyActive ? " active" : ""}" data-review-file="${index}" data-path="${attribute(file.path)}" data-review-mode="review" aria-label="${attribute(file.sectionTitle)}"${sectionDiff && sectionDiff.changed.length ? ` data-changed-elements="${attribute(sectionDiff.changed.join(" "))}"` : ""}>
  <div class="file-layout"><main class="plan-column"><div class="plan-doc md">${renderMarkdown(file.markdown, { sourceLines: true, lineOffset: file.startLine - 1 })}</div></main>${renderCommentary(file, carriedByFile.get(file.path) ?? [], true, sectionDiff)}</div>
</section>`;
	}
	let body;
	if (file.binary) body = '<div class="file-banner">Binary content is not rendered.</div>';
	else if (file.omitted) body = '<div class="file-banner warning">Omitted because the overall review rendering cap was reached.</div>';
	else body = `<table class="diff-table" aria-label="Unified diff for ${attribute(file.path)}"><tbody>${renderDiffBody(file, index)}</tbody></table>${file.truncated ? `<div class="file-banner warning">Diff truncated at 200 KiB or 2,000 lines (${file.patchBytes.toLocaleString()} bytes, ${file.totalDiffLines.toLocaleString()} total lines).</div>` : ""}`;
	const rename = file.oldPath ? `<span class="old-path">from ${text(file.oldPath)}</span>` : "";
	const referenceBadge = file.reviewMode === "reference" ? '<span class="badge reference-badge">reference</span>' : "";
	const position = file.reviewMode === "reference" ? "Reference file" : `${file.reviewOrdinal} / ${file.reviewCount}`;
	return `<section class="review-file${file.initiallyActive ? " active" : ""}" data-review-file="${index}" data-path="${attribute(file.path)}" data-review-mode="${attribute(file.reviewMode)}"${file.initiallyActive ? "" : " hidden"}>
  <header class="file-header"><div><span class="status status-${attribute(file.status)}">${text(file.status)}</span><h1>${text(file.path)}</h1>${rename}${referenceBadge}</div><div class="file-header-side"><span>${position}</span><label class="viewed-toggle" title="Mark this file viewed (x)"><input type="checkbox" data-viewed-toggle${viewedSet.has(file.path) ? " checked" : ""}>Viewed</label></div></header>
  <div class="file-layout"><main class="diff-column">${body}</main>${renderCommentary(file, carriedByFile.get(file.path) ?? [])}</div>
</section>`;
}

function renderFileNav(file, index, viewedSet, changedSet, planMode) {
	const badges = [file.binary ? "binary" : undefined, file.omitted ? "omitted" : undefined, file.truncated ? "truncated" : undefined].filter(Boolean);
	const changeMark = changedSet?.has(file.path) ? `<span class="change-mark" title="Changed in this round">●</span>` : "";
	return `<button type="button" class="file-nav-item${file.initiallyActive ? " active" : ""}" data-file-nav="${index}" title="${attribute(file.path)}"><span class="status-dot status-${attribute(file.status)}"></span><span>${text(file.sectionTitle ?? file.path)}</span>${planMode ? "" : `<span class="viewed-check" data-viewed-check="${attribute(file.path)}"${viewedSet.has(file.path) ? "" : " hidden"}>✓</span>`}${badges.map((badge) => `<span class="badge">${badge}</span>`).join("")}${changeMark}<span class="badge unread-badge" data-unread-badge hidden></span><span class="drift-mark" data-drift-mark="${attribute(file.path)}" hidden title="Changed after this snapshot was taken">●</span><span class="draft-dot" data-draft-dot="${attribute(file.path)}" hidden title="Unfinished comment draft">✎</span></button>`;
}

export function renderReviewHtml(review, nonce, session = { round: 1, currentRound: 1, phase: "reviewing" }, extras = { carried: [], archive: [] }) {
	const defaultTheme = Object.hasOwn(THEMES, extras.appearance?.theme) ? extras.appearance.theme : DEFAULT_THEME;
	const defaultScheme = ["auto", "light", "dark"].includes(extras.appearance?.scheme) ? extras.appearance.scheme : "auto";
	const planMode = review.kind === "plan";
	const viewedSet = new Set(extras.viewed ?? []);
	const carriedByFile = new Map();
	for (const thread of extras.carried) {
		if (thread.carried.placement === "outdated" || thread.file === undefined) continue;
		const siblings = carriedByFile.get(thread.file) ?? [];
		siblings.push(thread);
		carriedByFile.set(thread.file, siblings);
	}
	const hasOverview = Boolean(review.overview);
	const reviewCount = review.files.filter((file) => file.reviewMode !== "reference").length;
	const initialFileIndex = hasOverview ? -1 : Math.max(0, review.files.findIndex((file) => file.reviewMode !== "reference"));
	let reviewOrdinal = 0;
	const files = review.files.map((file, index) => ({
		...file,
		reviewCount,
		reviewOrdinal: file.reviewMode === "reference" ? undefined : ++reviewOrdinal,
		initiallyActive: index === initialFileIndex,
	}));
	const overviewNav = hasOverview ? '<button type="button" class="file-nav-item active" data-overview-nav><span class="overview-icon">◆</span><span>Overview</span><span class="badge unread-badge" data-unread-badge hidden></span></button>' : "";
	const reviewEntries = files.map((file, index) => ({ file, index })).filter(({ file }) => file.reviewMode !== "reference");
	const referenceEntries = files.map((file, index) => ({ file, index })).filter(({ file }) => file.reviewMode === "reference");
	const changedSet = extras.changedSections ? new Set(extras.changedSections) : undefined;
	const reviewNav = reviewEntries.length ? `<div class="sidebar-label">${planMode ? "Plan sections" : "Review files"}</div>${reviewEntries.map(({ file, index }) => renderFileNav(file, index, viewedSet, changedSet, planMode)).join("\n")}` : "";
	const referenceNav = referenceEntries.length ? `<details class="reference-files"${!hasOverview && reviewEntries.length === 0 ? " open" : ""}><summary>Reference files (${referenceEntries.length})<span class="badge unread-badge" data-reference-unread hidden></span></summary>${referenceEntries.map(({ file, index }) => renderFileNav(file, index, viewedSet)).join("\n")}</details>` : "";
	const viewedCount = files.filter((file) => viewedSet.has(file.path)).length;
	const viewedProgress = files.length && !planMode ? `<div class="viewed-progress" data-viewed-progress title="Files marked viewed"><div class="viewed-progressbar"><div data-viewed-bar style="width:${Math.round((viewedCount / files.length) * 100)}%"></div></div><span data-viewed-count>${viewedCount} / ${files.length} viewed</span></div>` : "";
	const status = planMode ? "Select plan text to comment, or reply to Pi." : hasOverview ? "Read the overview, then discuss each file with Pi." : "Select changed code or reply to Pi.";
	const switcher = `<nav class="round-switcher" data-round-switcher${session.currentRound > 1 ? "" : " hidden"}></nav>`;
	return `<!doctype html>
<html lang="en" data-theme="${defaultTheme}" data-scheme="${defaultScheme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(review.title)}</title><link rel="icon" href="data:,"><script nonce="${attribute(nonce)}">try{const savedTheme=localStorage.getItem("picr-theme");const savedScheme=localStorage.getItem("picr-scheme");if(${JSON.stringify(Object.keys(THEMES))}.includes(savedTheme))document.documentElement.dataset.theme=savedTheme;if(["auto","light","dark"].includes(savedScheme))document.documentElement.dataset.scheme=savedScheme;if(localStorage.getItem("picr-sidebar")==="collapsed")document.documentElement.dataset.sidebar="collapsed";}catch(ignored){}</script><style>${STYLE}</style></head>
<body data-round="${session.round}" data-current-round="${session.currentRound}" data-phase="${attribute(session.phase)}"${session.closeReason === undefined ? "" : ` data-close-reason="${attribute(session.closeReason)}"`} data-review-id="${attribute(review.id)}"${planMode ? ' data-review-kind="plan"' : ""}><header class="topbar"><div><button type="button" class="sidebar-toggle" data-sidebar-toggle title="Toggle the navigation pane (b)" aria-label="Toggle the navigation pane">☰</button><strong>${text(review.title)}</strong><span class="round-chip" data-round-chip>round ${session.round}</span><span class="snapshot" title="${attribute(review.id)}">snapshot ${text(review.id.slice(0, 12))}</span>${planMode ? "" : '<span class="badge stale-badge" data-stale-badge hidden title="The snapshot is frozen; the repository has changed since it was taken (edits, staging, or a commit). Reading and commenting stay open; threads carry into the next round.">no longer matches this snapshot</span>'}${switcher}</div><div class="toolbar-actions"><select class="rail-filter-select" data-rail-filters hidden aria-label="Filter rail cards by thread state" title="Filter rail cards (f cycles)"><option value="all">All</option><option value="awaiting">Awaiting you</option><option value="open">Open</option><option value="resolved">Resolved</option></select><button type="button" class="inbox-strip" data-inbox hidden title="Next thread awaiting you (n)"></button><span data-global-status>${status}</span>${planMode ? '<button type="button" class="shortcuts-hint" data-view-toggle title="Show one section at a time">Focus section</button>' : ""}<button type="button" class="shortcuts-hint" data-shortcuts-hint title="Keyboard shortcuts"><kbd>?</kbd> shortcuts</button><button type="button" data-finish>Send round to Pi</button><button type="button" class="approve-button" data-approve hidden></button></div></header>
<div class="phase-banner" data-phase-banner hidden><span data-phase-banner-text></span><button type="button" data-resume hidden>Resume reviewing this round</button><a data-goto-current href="/" hidden>Go to current round</a></div>
<div class="review-shell"><nav class="file-sidebar" aria-label="Review navigation">${viewedProgress}${overviewNav}${reviewNav}${referenceNav}</nav><div class="review-content" id="review-root">${renderOverview(review, extras)}${planMode ? `<header class="plan-head"><h1>${text(review.title)}</h1></header>` : ""}${files.map((file, index) => renderFile(file, index, carriedByFile, viewedSet, planMode, (path) => extras.elementDiff?.[path])).join("\n")}</div></div>
<div class="shortcuts-overlay" data-finish-overlay hidden><div class="shortcuts-card approve-card" role="dialog" aria-label="Send this round to Pi"><h2>Send this round to Pi?</h2><p class="approve-stats" data-finish-summary></p><div class="composer-actions"><button type="button" data-finish-cancel>Cancel</button><button type="button" data-finish-confirm>Send round</button></div></div></div>
<div class="shortcuts-overlay" data-approve-overlay hidden><div class="shortcuts-card approve-card" role="dialog" aria-label="Approve this review"><h2>${planMode ? "Approve this plan" : "Approve this review"}</h2><p class="approve-stats">${text(approveStats(review))}</p>${planMode ? "" : '<p class="approve-stale-warning" data-approve-stale hidden>The repository no longer matches this snapshot — what you reviewed is not what is on disk. Approve only if the drift is expected.</p>'}<label class="approve-message-label">${planMode ? "Approval note" : "Commit message"}<textarea data-approve-message maxlength="20000">${text(review.proposedCommitMessage ?? review.title)}</textarea></label><div class="composer-actions"><button type="button" data-approve-cancel>Cancel</button><button type="button" data-approve-confirm>${planMode ? "Approve plan" : "Approve review"}</button></div></div></div>
<div class="shortcuts-overlay" data-shortcuts-overlay hidden><div class="shortcuts-card" role="dialog" aria-label="Keyboard shortcuts"><h2>Keyboard shortcuts</h2><table><tbody>
<tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>${planMode ? "Next / previous block in this section" : "Next / previous hunk in this file"}</td></tr>
<tr><td><kbd>]</kbd> / <kbd>[</kbd></td><td>Next / previous file</td></tr>
<tr><td><kbd>o</kbd></td><td>Overview</td></tr>
<tr><td><kbd>r</kbd> or <kbd>⏎</kbd></td><td>Reply to the current thread</td></tr>
<tr><td><kbd>n</kbd></td><td>Next thread awaiting you</td></tr>
<tr><td><kbd>⇧n</kbd></td><td>Previous thread awaiting you</td></tr>
<tr><td><kbd>e</kbd></td><td>Resolve the current thread</td></tr>
<tr><td><kbd>⇧e</kbd></td><td>Next resolved thread</td></tr>
${planMode ? "" : "<tr><td><kbd>x</kbd></td><td>Toggle viewed on the current file</td></tr>"}
<tr><td><kbd>Esc</kbd></td><td>Leave the text box / close this guide</td></tr>
<tr><td><kbd>⌘⏎</kbd></td><td>Post the comment or reply being typed</td></tr>
<tr><td><kbd>⇧⌘⏎</kbd></td><td>In a comment box: quiet-add for the round · elsewhere: send the round</td></tr>
<tr><td><kbd>f</kbd></td><td>Cycle the rail filter</td></tr>
<tr><td><kbd>b</kbd></td><td>Toggle the navigation pane</td></tr>
<tr><td><kbd>?</kbd></td><td>Toggle this guide</td></tr>
</tbody></table>
<div class="appearance-row"><h2>Appearance</h2><label>Theme <select data-theme-picker>${Object.entries(THEMES).map(([name, theme]) => `<option value="${name}">${theme.label}</option>`).join("")}</select></label><label>Mode <select data-scheme-picker><option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Density <select data-density-picker><option value="auto">Auto</option><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label></div>
</div></div>
${planMode && /^\s*```\s*mermaid\b/im.test(files.map((file) => file.markdown ?? "").join("\n")) ? `<script nonce="${attribute(nonce)}" src="/__pi_code_review_mermaid__.js"></script><script nonce="${attribute(nonce)}">${DIAGRAM_SOURCE}</script>` : ""}<script nonce="${attribute(nonce)}">${MARKDOWN_SOURCE}</script>
<script nonce="${attribute(nonce)}">${CLIENT_SOURCE}</script></body></html>`;
}


// Selectable color themes: every palette defines the same 17 variables for
// light and dark. Slate is the default; "classic" is the original palette.
// Scheme layering: per-theme light at (0,2,0), forced/auto dark at (0,3,0),
// so a theme's dark blocks always beat its own light block when they match.
const THEMES = {
	slate: {
		label: "Slate",
		light: "--bg:#f7f8f8;--panel:#edf0f1;--border:#d2d8db;--text:#22282c;--muted:#5d6970;--add:#dcf0ea;--add-gutter:#addcce;--del:#f9e4e4;--del-gutter:#eec3c6;--hunk:#e7ecef;--accent:#a04e24;--warning:#92600c;--ok:#147a63;--danger:#c03546;--rename:#7a56c2;--mark:#ffe9b3;--mark-line:#b07d10",
		dark: "--bg:#14181c;--panel:#1b2127;--border:#333c44;--text:#e3e8ec;--muted:#8a97a1;--add:#152a28;--add-gutter:#245247;--del:#2f181d;--del-gutter:#5c2733;--hunk:#232a31;--accent:#e0855a;--warning:#d4a437;--ok:#4cc2a4;--danger:#ee6a79;--rename:#ab8fe8;--mark:#55430f;--mark-line:#d4a437",
	},
	manuscript: {
		label: "Manuscript",
		light: "--bg:#faf6ef;--panel:#f1ead9;--border:#dcd2bb;--text:#2b2620;--muted:#6f6455;--add:#e6eed6;--add-gutter:#c6dcab;--del:#f7e1d7;--del-gutter:#eac4b2;--hunk:#ece3cf;--accent:#8a4f2d;--warning:#8a6a00;--ok:#4a7c2a;--danger:#b03a2e;--rename:#7d5aa6;--mark:#f5e5a3;--mark-line:#a97f00",
		dark: "--bg:#191512;--panel:#211c17;--border:#3e352a;--text:#ece4d8;--muted:#a29886;--add:#222c18;--add-gutter:#41582a;--del:#341d17;--del-gutter:#613325;--hunk:#2b2417;--accent:#d9a066;--warning:#d9a93d;--ok:#8fb960;--danger:#e07856;--rename:#b596d9;--mark:#57430e;--mark-line:#d9a93d",
	},
	iris: {
		label: "Iris",
		light: "--bg:#fafafc;--panel:#f0eff6;--border:#d8d6e4;--text:#232231;--muted:#615e72;--add:#dff0e6;--add-gutter:#b5dcc4;--del:#fbe5ee;--del-gutter:#f2c1d4;--hunk:#eae8f6;--accent:#5a51c9;--warning:#96640a;--ok:#2b7a4b;--danger:#c42b5f;--rename:#986ad4;--mark:#fdedb0;--mark-line:#b18a00",
		dark: "--bg:#15151f;--panel:#1c1c2a;--border:#363549;--text:#e7e6f0;--muted:#9a97ad;--add:#1a2a20;--add-gutter:#2d5340;--del:#331a26;--del-gutter:#5e2c44;--hunk:#232238;--accent:#928af0;--warning:#d3a53a;--ok:#58bd83;--danger:#f16292;--rename:#b795ee;--mark:#514010;--mark-line:#cfa32e",
	},
	classic: {
		label: "Classic",
		light: "--bg:#fff;--panel:#f6f8fa;--border:#d0d7de;--text:#1f2328;--muted:#59636e;--add:#dafbe1;--add-gutter:#aceebb;--del:#ffebe9;--del-gutter:#ffcecb;--hunk:#ddf4ff;--accent:#0969da;--warning:#9a6700;--ok:#1a7f37;--danger:#cf222e;--rename:#8250df;--mark:#fff1a8;--mark-line:#bf8700",
		dark: "--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--add:#12261e;--add-gutter:#1f4a31;--del:#2d1517;--del-gutter:#5d2025;--hunk:#132b3a;--accent:#58a6ff;--warning:#d29922;--ok:#3fb950;--danger:#f85149;--rename:#a371f7;--mark:#5a4300;--mark-line:#d29922",
	},
};
const DEFAULT_THEME = "slate";
const THEME_CSS = [
	`:root{color-scheme:light dark;${THEMES[DEFAULT_THEME].light}}`,
	`@media(prefers-color-scheme:dark){:root:not([data-scheme="light"]){${THEMES[DEFAULT_THEME].dark}}}`,
	...Object.entries(THEMES).map(([name, theme]) => [
		`:root[data-theme="${name}"]{${theme.light}}`,
		`:root[data-theme="${name}"][data-scheme="dark"]{${theme.dark}}`,
		`@media(prefers-color-scheme:dark){:root[data-theme="${name}"]:not([data-scheme="light"]){${theme.dark}}}`,
	].join("")),
	`:root[data-scheme="dark"]{color-scheme:dark}:root[data-scheme="light"]{color-scheme:light}`,
].join("\n");

const STYLE = `
${THEME_CSS}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}.topbar{align-items:center;background:var(--panel);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;min-height:56px;padding:.65rem 1rem;position:sticky;top:0;z-index:20}.snapshot{color:var(--muted);font:12px ui-monospace,monospace;margin-left:.75rem}.round-chip{background:color-mix(in srgb,var(--accent) 14%,transparent);border-radius:999px;color:var(--accent);font-size:11px;font-weight:700;margin-left:.6rem;padding:.1rem .5rem}.round-switcher{display:inline-flex;gap:.25rem;margin-left:.6rem}.round-switcher a{border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:.1rem .45rem;text-decoration:none}.round-switcher a.current{border-color:var(--accent);color:var(--accent);font-weight:700}.round-switcher a.viewing{background:color-mix(in srgb,var(--accent) 14%,transparent)}.badge.stale-badge{border-color:var(--warning);color:var(--warning);font-weight:700;margin-left:.6rem;padding:.1rem .5rem}.phase-banner{align-items:center;background:color-mix(in srgb,var(--warning) 14%,transparent);border-bottom:1px solid var(--border);color:var(--warning);display:flex;font-size:13px;font-weight:650;gap:.8rem;padding:.5rem 1rem;position:sticky;top:56px;z-index:19}.phase-banner[hidden]{display:none}.phase-banner button,.phase-banner a{background:transparent;border:1px solid var(--warning);border-radius:6px;color:var(--warning);font-size:12px;font-weight:650;padding:.25rem .6rem;text-decoration:none}.phase-banner button[data-resume]{background:var(--warning);color:var(--bg);font-weight:700}.phase-banner button[data-resume]:hover{filter:brightness(1.1)}.locked [data-selection-composer],.locked [data-commentary-composer],.locked [data-overview-composer],.locked [data-finish],.locked [data-approve],.locked .thread-card .composer-actions,.locked .thread-card textarea,.locked .thread-card .reply-affordance,.locked .pi-proposes button{display:none!important}.quiet-only [data-finish],.quiet-only [data-approve],.quiet-only [data-thread-resolve],.quiet-only [data-commentary-resolve],.quiet-only .pi-proposes button,.quiet-only .turn-tools,.quiet-only [data-turn-editor]{display:none!important}.carried-threads{border-top:1px solid var(--border);margin-top:.8rem;padding-top:.8rem}.carried-threads h3{font-size:13px;margin:0 0 .4rem}.carried-thread{margin-top:.6rem}.carried-header{align-items:center;display:flex;flex-wrap:wrap;gap:.45rem}.resolution-badge{font-weight:700}.resolution-addressed{border-color:var(--ok);color:var(--ok)}.resolution-declined{border-color:var(--danger);color:var(--danger)}.resolution-needs-discussion{border-color:var(--warning);color:var(--warning)}.outdated-badge{border-color:var(--warning);color:var(--warning)}.carried-origin{color:var(--muted);font-size:11px;text-decoration:none}.carried-origin:hover{color:var(--accent);text-decoration:underline}.outdated-threads{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.outdated-threads h2{font-size:13px;margin:0 0 .35rem}.round-archive{border-top:1px solid var(--border);color:var(--muted);font-size:12px;margin-top:1rem;padding-top:1rem}.round-archive summary{cursor:pointer;font-weight:700}.archive-round h3{font-size:12px;margin:.6rem 0 .25rem}.round-archive ul{margin:.25rem 0;padding-left:1.25rem}.round-archive a{color:var(--accent);text-decoration:none}.toolbar-actions{align-items:center;display:flex;gap:.8rem}.toolbar-actions span{color:var(--muted);font-size:12px}.toolbar-actions button,.composer-actions button{background:var(--accent);border:0;border-radius:6px;color:white;font-weight:650;padding:.5rem .8rem}.toolbar-actions button:disabled,.composer-actions button:disabled{cursor:not-allowed;opacity:.45}.review-shell{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:calc(100vh - 56px)}html[data-sidebar="collapsed"] .review-shell{grid-template-columns:minmax(0,1fr)}html[data-sidebar="collapsed"] .file-sidebar{display:none}button.sidebar-toggle{background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted);cursor:pointer;font-size:13px;line-height:1;margin-right:.65rem;padding:.35rem .5rem;vertical-align:middle}button.sidebar-toggle:hover{color:var(--text)}.file-sidebar{background:var(--panel);border-right:1px solid var(--border);height:calc(100vh - 56px);overflow:auto;padding:.5rem;position:sticky;top:56px}.file-nav-item{align-items:center;background:transparent;border:0;border-radius:6px;color:inherit;display:flex;gap:.45rem;padding:.5rem;text-align:left;width:100%}.file-nav-item:hover,.file-nav-item.active{background:color-mix(in srgb,var(--accent) 14%,transparent)}.file-nav-item>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-nav-item>span:nth-child(3){margin-left:auto}.file-nav-item>.viewed-check[hidden]+span{margin-left:auto}.sidebar-label{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em;margin:.7rem .5rem .25rem;text-transform:uppercase}.reference-files{border-top:1px solid var(--border);margin-top:.7rem;padding-top:.45rem}.reference-files summary{color:var(--muted);cursor:pointer;font-size:11px;font-weight:700;padding:.35rem .5rem}.reference-files[open] summary{margin-bottom:.15rem}.reference-files .file-nav-item{color:var(--muted)}.overview-icon{color:var(--accent);flex:0 0 8px;font-size:9px}.status-dot{border-radius:50%;flex:0 0 8px;height:8px;background:var(--muted)}.status-added,.status-untracked{color:var(--ok)}.status-deleted{color:var(--danger)}.status-renamed{color:var(--rename)}.badge{border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:10px;padding:0 .35rem}.drift-mark{color:var(--warning);flex:0 0 auto;font-size:9px}.change-mark{color:var(--warning);flex:0 0 auto;font-size:9px}.draft-dot{color:var(--accent);flex:0 0 auto;font-size:11px}.reference-badge{margin-left:.45rem}.review-content{min-width:0;padding:1rem}.review-file[hidden],.review-overview[hidden]{display:none}.overview-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.8rem 1rem}.overview-header h1{font-size:18px;margin:.25rem 0 0}.overview-header>span{color:var(--muted);font-size:12px}.overview-body{border:1px solid var(--border);border-radius:0 0 8px 8px;max-width:760px;padding:1rem 1.2rem}.overview-body section+section{margin-top:1rem}.overview-body h2{font-size:13px;margin:0 0 .35rem}.overview-body p,.overview-body ul{margin:.25rem 0}.overview-body ul{padding-left:1.25rem}.overview-feedback{border-top:1px solid var(--border);color:var(--muted);display:block;font-size:12px;font-weight:600;margin-top:1rem;padding-top:1rem}.file-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.7rem 1rem}.file-header h1{display:inline;font:600 14px ui-monospace,monospace;margin:.5rem}.file-header>span,.file-header-side>span,.old-path{color:var(--muted);font-size:12px}.file-header-side{align-items:center;display:flex;gap:.8rem}.viewed-toggle{align-items:center;color:var(--muted);cursor:pointer;display:inline-flex;font-size:12px;gap:.3rem;user-select:none}.viewed-toggle input{accent-color:var(--accent);margin:0}.viewed-check{color:var(--ok);font-weight:700}.viewed-progress{align-items:center;display:flex;gap:.5rem;padding:.4rem .5rem .1rem}.viewed-progressbar{background:var(--border);border-radius:999px;flex:1;height:5px;overflow:hidden}.viewed-progressbar div{background:var(--accent);height:100%;transition:width .2s}.viewed-progress span{color:var(--muted);font-size:11px;white-space:nowrap}button.shortcuts-hint{background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:12px;font-weight:600;padding:.35rem .55rem}button.shortcuts-hint:hover{color:var(--text)}.shortcuts-hint kbd{background:var(--panel);border:1px solid var(--border);border-radius:4px;font:11px ui-monospace,monospace;padding:0 .3rem}.status{font-size:11px;font-weight:700;text-transform:uppercase}.file-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:1rem}.diff-column{border:1px solid var(--border);border-top:0;min-width:0;overflow:auto}.diff-table{border-collapse:collapse;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;table-layout:auto;width:100%}.diff-table td{border:0;padding:0 .45rem;vertical-align:top}.line-number,.line-marker{color:var(--muted);text-align:right;user-select:none;width:1%;white-space:nowrap}.diff-line .line-number{cursor:pointer}.diff-line .line-number:hover{color:var(--accent)}.line-marker{padding-right:.1rem!important}.diff-code{white-space:pre;min-width:100%}.diff-add{background:var(--add)}.diff-add .line-number,.diff-add .line-marker{background:var(--add-gutter)}.diff-del{background:var(--del)}.diff-del .line-number,.diff-del .line-marker{background:var(--del-gutter)}.diff-add .intraline{background:var(--add-gutter);border-radius:2px}.diff-del .intraline{background:var(--del-gutter);border-radius:2px}.diff-hunk{background:var(--hunk);color:var(--muted)}tr.nav-cursor td{box-shadow:inset 0 2px var(--accent),inset 0 -2px var(--accent)}tr.nav-cursor td:first-child{box-shadow:inset 2px 2px var(--accent),inset 0 -2px var(--accent)}tr.nav-cursor td:last-child{box-shadow:inset -2px 2px var(--accent),inset 0 -2px var(--accent)}.diff-meta{color:var(--muted)}.diff-expander td{background:var(--hunk)}.diff-expander button{background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--accent);cursor:pointer;font:11px/1.4 system-ui,sans-serif;margin-right:.35rem;padding:0 .4rem}.diff-expander button:hover{background:color-mix(in srgb,var(--accent) 14%,transparent)}.diff-expander button:disabled{color:var(--muted);cursor:default}.expander-note{color:var(--muted);font:11px system-ui,sans-serif;margin-left:.35rem}.unselectable{user-select:none}.file-banner{padding:2rem;text-align:center;color:var(--muted)}.plan-column{border:0;min-width:0;overflow:visible}body[data-review-kind="plan"] .file-layout{grid-template-columns:minmax(0,760px) minmax(260px,420px)}body[data-review-kind="plan"] .review-content{max-width:1280px;padding:2.5rem 1.5rem 2.5rem 3rem}.plan-head{margin:0 0 1.75rem}.plan-head h1{font-size:24px;line-height:1.25;margin:0}.appearance-row{border-top:1px solid var(--border);display:flex;gap:1rem;margin-top:.8rem;padding-top:.8rem}.appearance-row h2{align-self:center;flex:1;margin:0}.appearance-row label{align-items:center;color:var(--muted);display:inline-flex;font-size:12px;gap:.35rem}.appearance-row select{background:var(--panel);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;padding:.3rem .35rem}.diff-line{scroll-margin-top:96px}.plan-doc [data-md-line]{scroll-margin-top:96px}tr.note-target:not(.nav-cursor) td{box-shadow:inset 0 0 0 999px color-mix(in srgb,var(--accent) 20%,transparent)}tr.note-target:not(.nav-cursor) td:first-child{box-shadow:inset 3px 0 var(--accent),inset 0 0 0 999px color-mix(in srgb,var(--accent) 20%,transparent)}@keyframes anchor-flash-row{0%,55%{box-shadow:inset 0 0 0 999px color-mix(in srgb,var(--accent) 26%,transparent)}100%{box-shadow:none}}tr.anchor-flash td{animation:anchor-flash-row 1.1s ease-out}@keyframes anchor-flash-block{0%,55%{box-shadow:inset 0 0 0 2px var(--accent),inset 0 0 0 999px color-mix(in srgb,var(--accent) 14%,transparent)}100%{box-shadow:none}}.plan-doc .anchor-flash{animation:anchor-flash-block 1.1s ease-out;border-radius:3px}.plan-doc .note-target{background:color-mix(in srgb,var(--accent) 18%,transparent);border-radius:3px;box-shadow:inset 3px 0 var(--accent)}.agent-note.note-hover,.plan-rail .agent-note.note-hover{border-color:var(--accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 45%,transparent)}.diagram-block{border:1px solid var(--border);border-radius:8px;margin:.6rem 0;overflow:hidden;position:relative}.diagram-canvas{cursor:default;max-height:75vh;overflow:auto;padding:.6rem;touch-action:none;user-select:none}:root{--diagram-canvas-light:#fdfdfc;--diagram-canvas-dark:#16191d;--diagram-ink-on-light:#1a1c1f;--diagram-ink-on-dark:#f2f3f5;--diagram-edge-label-dark:#2c3036;--diagram-node-border-light:#7c7c7c;--diagram-cluster-light:#f4f6f9;--diagram-cluster-border-light:#8a939e;--diagram-node-light:#ffffff;--diagram-cluster-dark:#1c2025;--diagram-cluster-border-dark:#6b737d;--diagram-node-dark:#262b32}.diagram-block.diagram-scheme-light .diagram-canvas{background:var(--diagram-canvas-light)}.diagram-block.diagram-scheme-dark .diagram-canvas{background:var(--diagram-canvas-dark)}.diagram-canvas svg{display:block;height:auto;max-width:none}.diagram-canvas .diagram-inner{margin:0 auto;transform-origin:0 0;width:max-content}.diagram-notice{border-top:1px solid var(--border);color:var(--muted);font-size:12px;padding:.35rem .6rem}.diagram-error{background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger);font-size:12px;font-weight:650;padding:.45rem .6rem}.diagram-block .diagram-source:not([hidden]){margin:0;border:0;border-radius:0}.diagram-zoom{display:flex;gap:.25rem;opacity:0;position:absolute;right:.4rem;top:.4rem;transition:opacity .15s;z-index:2}.diagram-block:hover .diagram-zoom{opacity:1}.diagram-zoom button{background:var(--panel);border:1px solid var(--border);border-radius:5px;color:var(--muted);cursor:pointer;font:12px ui-monospace,monospace;padding:.1rem .45rem}.diagram-zoom button:hover{color:var(--accent)}.diagram-canvas svg[aria-roledescription="sequence"] .messageText{paint-order:stroke;stroke:var(--diagram-canvas-light);stroke-width:3px;stroke-linejoin:round}.diagram-canvas [id$="-sequencenumber"] circle{fill:var(--diagram-cluster-light)!important;stroke:var(--diagram-node-border-light);stroke-width:.6px}.diagram-scheme-dark .diagram-canvas svg[aria-roledescription="sequence"] .messageText{stroke:var(--diagram-canvas-dark)}.diagram-scheme-dark .diagram-canvas [id$="-sequencenumber"] circle{fill:var(--diagram-node-dark)!important;stroke:var(--diagram-cluster-border-dark)}.diagram-canvas line[data-el]:hover,.diagram-canvas line.el-target{stroke:var(--accent)!important;stroke-width:3px!important}.diagram-canvas [data-el]{cursor:pointer}.diagram-canvas [data-el]:hover{filter:brightness(1.12) drop-shadow(0 0 3px color-mix(in srgb,var(--accent) 65%,transparent))}.diagram-canvas .el-target{filter:brightness(1.15) drop-shadow(0 0 6px var(--accent))}.diagram-canvas path.el-target,.diagram-canvas path.el-flash{stroke:var(--accent)!important;stroke-width:3px!important}.diagram-canvas path[data-el]:hover{stroke:var(--accent)!important;stroke-width:2.5px!important}.diagram-canvas .el-changed{filter:drop-shadow(0 0 5px color-mix(in srgb,var(--warning) 90%,transparent))}.removed-elements{border:1px solid var(--border);border-radius:8px;margin-top:.55rem;padding:.55rem .7rem}.removed-elements h3{color:var(--warning);font-size:11px;letter-spacing:.05em;margin:0 0 .3rem;text-transform:uppercase}.removed-elements ul{font:12px ui-monospace,monospace;margin:0;padding-left:1.1rem}.removed-elements a{color:var(--muted);font-size:11px}@keyframes el-flash{0%,20%,50%{filter:brightness(1.7) drop-shadow(0 0 12px var(--accent)) drop-shadow(0 0 4px var(--accent))}35%,65%{filter:brightness(1.1) drop-shadow(0 0 3px var(--accent))}100%{filter:none}}.diagram-canvas .el-flash{animation:el-flash 2s ease-out}.element-chip,.anchor-chip{background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:999px;color:var(--accent);font:11px ui-monospace,monospace;font-weight:700;padding:.05rem .45rem}.plan-doc{max-width:760px;padding:0}.commentary-column.plan-rail{border:0;border-radius:0;display:flow-root;height:auto;max-height:none;overflow:visible;padding:0 0 0 .25rem;position:relative}.plan-rail .file-summary{margin-top:.55rem}.summary-label{color:var(--muted);display:block;font-size:10px;font-weight:700;letter-spacing:.05em;margin-bottom:.25rem;text-transform:uppercase}.plan-rail .agent-note{border:1px solid var(--border);border-radius:8px;margin-top:.55rem;padding:.55rem .7rem}.plan-rail .carried-threads{border-top:0;margin-top:.55rem;padding-top:0}body[data-review-kind="plan"] .review-file{scroll-margin-top:64px}body[data-review-kind="plan"] .review-file+.review-file{margin-top:2rem}.plan-focus .review-file:not(.active){display:none}.plan-doc [data-md-line].nav-cursor{box-shadow:inset 3px 0 var(--accent);padding-left:.4rem}.status-section{color:var(--accent)}.file-banner.warning{color:var(--warning)}.commentary-column{border:1px solid var(--border);border-radius:8px;height:max-content;padding:1rem;position:relative}.commentary-column.rail-aligned{border:0;padding:0}.commentary-column.rail-aligned .carried-threads{border-top:0;margin-top:0;padding-top:0}.commentary-column.rail-aligned .carried-threads h3{display:none}.commentary-column{pointer-events:none}.commentary-column>*{pointer-events:auto}.commentary-column.rail-aligned .rail-card{left:0;margin:0;position:absolute;right:0}.commentary-column.plan-rail.rail-aligned .rail-card{left:.25rem;right:0}.commentary-column h2,.commentary-column h3{font-size:14px;margin:0 0 .6rem}.file-summary{background:var(--panel);border-radius:6px;padding:.7rem}.file-summary pre{background:var(--bg)}.agent-note{border-top:1px solid var(--border);margin-top:.8rem;padding-top:.8rem}.agent-note-anchor{background:transparent;border:0;color:var(--accent);cursor:pointer;font-size:11px;font-weight:700;padding:0}.agent-note-anchor:disabled{color:var(--muted);cursor:default}.anchor-preview{color:var(--muted);font:400 11px ui-monospace,monospace;margin-left:.35rem}.agent-note-body{margin:.35rem 0}.md p{margin:.35rem 0}.md p:first-child{margin-top:0}.md p:last-child{margin-bottom:0}.md ul,.md ol{margin:.35rem 0;padding-left:1.25rem}.md li{margin:.1rem 0}.md code{background:color-mix(in srgb,var(--muted) 14%,transparent);border-radius:4px;font:.92em ui-monospace,monospace;padding:0 .25rem}.md pre{background:var(--panel);border:1px solid var(--border);border-radius:6px;margin:.4rem 0;overflow:auto;padding:.5rem}.md pre code{background:transparent;border-radius:0;display:block;font:12px/1.45 ui-monospace,monospace;padding:0;white-space:pre}.md a{color:var(--accent)}.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{line-height:1.25;margin:.9em 0 .35em}.md h1{font-size:1.5em}.md h2{font-size:1.3em}.md h3{font-size:1.15em}.md h4,.md h5,.md h6{font-size:1em}.md h1:first-child,.md h2:first-child,.md h3:first-child{margin-top:0}.md blockquote{border-left:3px solid var(--border);color:var(--muted);margin:.4rem 0;padding:.1rem 0 .1rem .75rem}.md hr{border:0;border-top:1px solid var(--border);margin:.8rem 0}.md table{border-collapse:collapse;margin:.4rem 0}.md th,.md td{border:1px solid var(--border);padding:.25rem .6rem;text-align:left}.md th{background:var(--panel)}.agent-note label{color:var(--muted);font-size:11px}.agent-note textarea,.selection-composer textarea,.thread-card textarea,.overview-feedback textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:inherit;font:13px system-ui,sans-serif;margin-top:.3rem;min-height:60px;padding:.5rem;resize:vertical;width:100%}.user-comments{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.selection-composer{background:var(--panel);border:1px solid var(--accent);border-radius:8px;margin-top:1rem;padding:.7rem}.selection-quote,.user-comment-quote{border-left:3px solid var(--accent);color:var(--muted);font:11px ui-monospace,monospace;margin-bottom:.4rem;max-height:5rem;overflow:auto;padding-left:.5rem;white-space:pre-wrap}.composer-actions{display:flex;gap:.4rem;justify-content:flex-end;margin-top:.4rem}.composer-actions button:first-child{background:transparent;border:1px solid var(--border);color:inherit}.composer-actions button[data-thread-send]{background:var(--accent);border:0;color:white}::highlight(pi-code-review-feedback){background:var(--mark);text-decoration:underline 2px var(--mark-line)}.toolbar-actions .inbox-strip{background:color-mix(in srgb,var(--accent) 16%,transparent);border:1px solid var(--accent);border-radius:999px;color:var(--accent);font-weight:700}.rail-filter-select{background:var(--panel);border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:12px;padding:.3rem .35rem;width:9.5rem}.rail-filter-select[hidden]{display:none}.rail-filter-select.filtering{border-color:var(--accent);color:var(--accent)}.thread-card{border:1px solid var(--border);border-radius:8px;margin-top:.65rem;padding:.6rem .7rem}.thread-card.awaiting{border-color:var(--accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent)}.thread-card.resolved{opacity:.62}.thread-card.queued{border-style:dashed}.thread-card.queued .thread-status,.thread-card.pending .thread-status{color:var(--warning)}.reply-affordance{background:transparent;border:0;color:var(--muted);cursor:pointer;display:block;font-size:12px;font-weight:600;padding:.25rem 0;text-align:left;width:100%}.reply-affordance:hover{color:var(--accent)}.reply-composer.collapsed label,.reply-composer.collapsed textarea,.reply-composer.collapsed .composer-actions{display:none}.reply-composer:not(.collapsed) .reply-affordance{display:none}.resolved-summary{align-items:center;background:transparent;border:0;color:var(--muted);cursor:pointer;display:flex;font-size:12px;gap:.45rem;padding:0;text-align:left;width:100%}.resolved-summary:hover{color:var(--text)}.resolved-first{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.resolved-tick{color:var(--ok);font-weight:700}.resolved-detail{margin-top:.45rem}.resolved-collapsed .agent-note-body{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden}.thread-card-header{align-items:center;display:flex;gap:.5rem;justify-content:space-between}.thread-status{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.thread-card.awaiting .thread-status{color:var(--accent)}.thread-turn{margin:.45rem 0}.thread-turn .turn-author{color:var(--muted);display:block;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.thread-turn.turn-pi .turn-author{color:var(--accent)}.turn-tools{display:flex;gap:.6rem;margin-top:.15rem}.turn-tools button{background:transparent;border:0;color:var(--muted);cursor:pointer;font-size:11px;font-weight:600;padding:0}.turn-tools button:hover{color:var(--accent)}.locked .turn-tools,.locked [data-turn-editor]{display:none!important}.pi-proposes{background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:6px;color:var(--accent);font-size:11px;font-weight:650;margin-top:.4rem;padding:.35rem .5rem}.reply-state{align-items:center;color:var(--muted);display:flex;font-size:11px;font-weight:600;gap:.4rem;margin-top:.45rem}.reply-state .reply-spinner{animation:reply-spin .9s linear infinite;border:2px solid var(--border);border-radius:50%;border-top-color:var(--accent);flex:0 0 auto;height:10px;width:10px}@keyframes reply-spin{to{transform:rotate(360deg)}}.reply-state .reply-tick{font-weight:700}.thread-flash{animation:thread-flash 1.2s ease-out}@keyframes thread-flash{0%{box-shadow:0 0 0 3px var(--accent)}100%{box-shadow:0 0 0 1px transparent}}.unread-badge{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}.thread-tally{color:var(--muted);display:flex;flex-wrap:wrap;gap:.9rem;font-size:12px}.thread-tally strong{color:var(--text)}.card-compact .thread-turn:not(:first-of-type),.card-compact .reply-composer,.card-compact .pi-proposes,.card-compact .reply-state,.card-compact .turn-tools,.card-compact .user-comment-quote,.card-compact .selection-quote,.card-compact label,.card-compact textarea,.card-compact .composer-actions,.card-compact .resolved-detail,.card-compact .turn-author,.card-compact .anchor-preview{display:none}.card-compact .thread-turn:first-of-type,.card-compact .agent-note-body{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;margin:.25rem 0 0}.card-compact{cursor:pointer}.shortcuts-overlay{align-items:center;background:rgba(0,0,0,.45);display:flex;inset:0;justify-content:center;position:fixed;z-index:50}.shortcuts-overlay[hidden]{display:none}.shortcuts-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;min-width:300px;padding:1rem 1.2rem}.shortcuts-card h2{font-size:14px;margin:0 0 .6rem}.shortcuts-card table{border-collapse:collapse;font-size:13px}.shortcuts-card td{padding:.25rem .7rem .25rem 0}.shortcuts-card kbd{background:var(--panel);border:1px solid var(--border);border-radius:4px;font:11px ui-monospace,monospace;padding:.1rem .4rem}.approve-button{background:var(--ok)!important}.approve-card{max-width:520px;width:90vw}.approve-stats{color:var(--muted);font-size:12px;margin:.2rem 0 .6rem}.approve-stale-warning{background:color-mix(in srgb,var(--warning) 14%,transparent);border-radius:6px;color:var(--warning);font-size:12px;font-weight:650;margin:.2rem 0 .6rem;padding:.45rem .6rem}.approve-message-label{color:var(--muted);display:block;font-size:12px}.approve-card textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font:13px ui-monospace,monospace;margin-top:.3rem;min-height:110px;padding:.5rem;resize:vertical;width:100%}.approve-card .composer-actions button[data-approve-confirm]{background:var(--ok)}@media(max-width:900px){.rail-filter-select{display:none}.review-shell{grid-template-columns:1fr}.file-sidebar{display:flex;height:auto;overflow:auto;position:static}.file-nav-item{min-width:180px}.file-layout{grid-template-columns:1fr}}@media(max-width:600px){.topbar{align-items:flex-start;gap:.5rem}.toolbar-actions span{display:none}.review-content{padding:.5rem}.file-layout{display:block}.commentary-column{margin-top:.75rem}}
`;
