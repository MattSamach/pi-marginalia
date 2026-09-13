import { readFileSync } from "node:fs";
import { computeContextGaps } from "./git-review.js";
import { renderMarkdown } from "./markdown.js";

const CLIENT_SOURCE = readFileSync(new URL("../client/review.js", import.meta.url), "utf8");
// The markdown renderer is one source of truth used in both contexts: imported
// above for server-side rendering, and served to the browser with the module
// syntax stripped so the client renders live thread turns identically.
const MARKDOWN_SOURCE = readFileSync(new URL("./markdown.js", import.meta.url), "utf8").replace(/^export /gm, "");

function text(value) {
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attribute(value) {
	return text(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function rangeLabel(entry) {
	if (entry.startLine === undefined) return "File note";
	const side = entry.side === "both" ? "lines" : `${entry.side} lines`;
	return `${side} ${entry.startLine}${entry.endLine !== entry.startLine ? `–${entry.endLine}` : ""}`;
}

const RESOLUTION_LABELS = { addressed: "Addressed", declined: "Declined", "needs-discussion": "Needs discussion" };

function renderCarriedShell(thread) {
	const carried = thread.carried;
	const anchored = carried.placement === "anchored";
	const anchorAttrs = anchored ? ` data-anchor-side="${attribute(carried.side)}" data-anchor-start="${carried.startLine}"` : "";
	const anchorButton = anchored ? `<button type="button" class="agent-note-anchor">${text(carried.side === "both" ? "lines" : `${carried.side} lines`)} ${carried.startLine}${carried.endLine !== carried.startLine ? `–${carried.endLine}` : ""}</button>` : "";
	const outdated = carried.placement === "outdated" ? `<span class="badge outdated-badge">outdated — anchored to round ${Number(carried.fromRound)}</span>` : "";
	return `<article class="carried-thread" data-carried-thread="${attribute(thread.id)}"${anchorAttrs}>
  <div class="carried-header"><span class="badge resolution-badge resolution-${attribute(carried.resolution)}">${text(RESOLUTION_LABELS[carried.resolution] ?? carried.resolution)}</span><a class="carried-origin" href="/round/${Number(carried.fromRound)}#thread=${attribute(thread.id)}" title="View this thread in round ${Number(carried.fromRound)} (read-only)">from round ${Number(carried.fromRound)}</a>${anchorButton}${outdated}</div>
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
    <section class="overview-feedback"><h2>General feedback</h2><div data-overview-thread></div><div data-overview-composer><textarea data-overview-feedback maxlength="20000" placeholder="Discuss the change set with Pi"></textarea><div class="composer-actions"><button type="button" data-overview-post title="Post (⌘⏎ live · ⇧⌘⏎ quiet)" disabled>Post to Pi</button></div></div></section>
    ${renderArchive(extras.archive)}
  </main>
</section>`;
}

function renderCommentary(file, carriedForFile) {
	const carriedCards = carriedForFile.length ? `<section class="carried-threads"><h3>Carried threads</h3>${carriedForFile.map(renderCarriedShell).join("\n")}</section>` : "";
	const cards = file.commentary.map((entry) => `<article class="agent-note" data-commentary-id="${attribute(entry.id)}" data-anchor-side="${attribute(entry.side)}"${entry.startLine === undefined ? "" : ` data-anchor-start="${entry.startLine}"`}>
  <button type="button" class="agent-note-anchor"${entry.startLine === undefined ? " disabled" : ""}>${text(rangeLabel(entry))}</button>
  <div class="agent-note-body md">${renderMarkdown(entry.body)}</div>
  <div data-commentary-thread="${attribute(entry.id)}"></div>
  <div data-commentary-composer="${attribute(entry.id)}"><label>Reply to Pi<textarea data-commentary-reply="${attribute(entry.id)}" maxlength="20000" placeholder="Respond to this explanation"></textarea></label><div class="composer-actions"><button type="button" data-commentary-resolve="${attribute(entry.id)}" title="Mark this note read; never messages Pi">Resolve</button><button type="button" data-commentary-post="${attribute(entry.id)}" title="Reply (⌘⏎ live · ⇧⌘⏎ quiet)" disabled>Reply</button></div></div>
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

function renderFile(file, index, carriedByFile, viewedSet, planMode) {
	if (planMode) {
		return `<section class="review-file${file.initiallyActive ? " active" : ""}" data-review-file="${index}" data-path="${attribute(file.path)}" data-review-mode="review"${file.initiallyActive ? "" : " hidden"}>
  <header class="file-header"><div><span class="status status-section">section</span><h1>${text(file.sectionTitle)}</h1></div><div class="file-header-side"><span>${file.reviewOrdinal} / ${file.reviewCount}</span></div></header>
  <div class="file-layout"><main class="plan-column"><div class="plan-doc md">${renderMarkdown(file.markdown, { sourceLines: true, lineOffset: file.startLine - 1 })}</div></main>${renderCommentary(file, carriedByFile.get(file.path) ?? [])}</div>
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

function renderFileNav(file, index, viewedSet, changedSet) {
	const badges = [file.binary ? "binary" : undefined, file.omitted ? "omitted" : undefined, file.truncated ? "truncated" : undefined].filter(Boolean);
	const changeMark = changedSet?.has(file.path) ? `<span class="change-mark" title="Changed in this round">●</span>` : "";
	return `<button type="button" class="file-nav-item${file.initiallyActive ? " active" : ""}" data-file-nav="${index}" title="${attribute(file.path)}"><span class="status-dot status-${attribute(file.status)}"></span><span>${text(file.sectionTitle ?? file.path)}</span><span class="viewed-check" data-viewed-check="${attribute(file.path)}"${viewedSet.has(file.path) ? "" : " hidden"}>✓</span>${badges.map((badge) => `<span class="badge">${badge}</span>`).join("")}${changeMark}<span class="badge unread-badge" data-unread-badge hidden></span><span class="drift-mark" data-drift-mark="${attribute(file.path)}" hidden title="Changed after this snapshot was taken">●</span><span class="draft-dot" data-draft-dot="${attribute(file.path)}" hidden title="Unfinished comment draft">✎</span></button>`;
}

export function renderReviewHtml(review, nonce, session = { round: 1, currentRound: 1, phase: "reviewing" }, extras = { carried: [], archive: [] }) {
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
	const reviewNav = reviewEntries.length ? `<div class="sidebar-label">${planMode ? "Plan sections" : "Review files"}</div>${reviewEntries.map(({ file, index }) => renderFileNav(file, index, viewedSet, changedSet)).join("\n")}` : "";
	const referenceNav = referenceEntries.length ? `<details class="reference-files"${!hasOverview && reviewEntries.length === 0 ? " open" : ""}><summary>Reference files (${referenceEntries.length})<span class="badge unread-badge" data-reference-unread hidden></span></summary>${referenceEntries.map(({ file, index }) => renderFileNav(file, index, viewedSet)).join("\n")}</details>` : "";
	const viewedCount = files.filter((file) => viewedSet.has(file.path)).length;
	const viewedProgress = files.length && !planMode ? `<div class="viewed-progress" data-viewed-progress title="Files marked viewed"><div class="viewed-progressbar"><div data-viewed-bar style="width:${Math.round((viewedCount / files.length) * 100)}%"></div></div><span data-viewed-count>${viewedCount} / ${files.length} viewed</span></div>` : "";
	const status = planMode ? "Select plan text to comment, or reply to Pi." : hasOverview ? "Read the overview, then discuss each file with Pi." : "Select changed code or reply to Pi.";
	const switcher = `<nav class="round-switcher" data-round-switcher${session.currentRound > 1 ? "" : " hidden"}></nav>`;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(review.title)}</title><link rel="icon" href="data:,"><style>${STYLE}</style></head>
<body data-round="${session.round}" data-current-round="${session.currentRound}" data-phase="${attribute(session.phase)}" data-review-id="${attribute(review.id)}"${planMode ? ' data-review-kind="plan"' : ""}><header class="topbar"><div><strong>${text(review.title)}</strong><span class="round-chip" data-round-chip>round ${session.round}</span><span class="snapshot" title="${attribute(review.id)}">snapshot ${text(review.id.slice(0, 12))}</span><span class="badge stale-badge" data-stale-badge hidden title="The snapshot is frozen; the repository has changed since it was taken (edits, staging, or a commit). Reading and commenting stay open; threads carry into the next round.">no longer matches this snapshot</span>${switcher}</div><div class="toolbar-actions"><button type="button" class="inbox-strip" data-inbox hidden title="Next thread awaiting you (n)"></button><span data-global-status>${status}</span><button type="button" class="shortcuts-hint" data-shortcuts-hint title="Keyboard shortcuts"><kbd>?</kbd> shortcuts</button><button type="button" data-finish>Send round to Pi</button><button type="button" class="approve-button" data-approve hidden></button></div></header>
<div class="phase-banner" data-phase-banner hidden><span data-phase-banner-text></span><button type="button" data-resume hidden>Resume reviewing this round</button><a data-goto-current href="/" hidden>Go to current round</a></div>
<div class="review-shell"><nav class="file-sidebar" aria-label="Review navigation">${viewedProgress}${overviewNav}${reviewNav}${referenceNav}</nav><div class="review-content" id="review-root">${renderOverview(review, extras)}${files.map((file, index) => renderFile(file, index, carriedByFile, viewedSet, planMode)).join("\n")}</div></div>
<div class="shortcuts-overlay" data-finish-overlay hidden><div class="shortcuts-card approve-card" role="dialog" aria-label="Send this round to Pi"><h2>Send this round to Pi?</h2><p class="approve-stats" data-finish-summary></p><div class="composer-actions"><button type="button" data-finish-cancel>Cancel</button><button type="button" data-finish-confirm>Send round</button></div></div></div>
<div class="shortcuts-overlay" data-approve-overlay hidden><div class="shortcuts-card approve-card" role="dialog" aria-label="Approve this review"><h2>${planMode ? "Approve this plan" : "Approve this review"}</h2><p class="approve-stats">${text(approveStats(review))}</p><p class="approve-stale-warning" data-approve-stale hidden>The repository no longer matches this snapshot — what you reviewed is not what is on disk. Approve only if the drift is expected.</p><label class="approve-message-label">${planMode ? "Approval note" : "Commit message"}<textarea data-approve-message maxlength="20000">${text(review.proposedCommitMessage ?? review.title)}</textarea></label><div class="composer-actions"><button type="button" data-approve-cancel>Cancel</button><button type="button" data-approve-confirm>Approve review</button></div></div></div>
<div class="shortcuts-overlay" data-shortcuts-overlay hidden><div class="shortcuts-card" role="dialog" aria-label="Keyboard shortcuts"><h2>Keyboard shortcuts</h2><table><tbody>
<tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>${planMode ? "Next / previous block in this section" : "Next / previous hunk in this file"}</td></tr>
<tr><td><kbd>]</kbd> / <kbd>[</kbd></td><td>Next / previous file</td></tr>
<tr><td><kbd>o</kbd></td><td>Overview</td></tr>
<tr><td><kbd>r</kbd> or <kbd>⏎</kbd></td><td>Reply to the current thread</td></tr>
<tr><td><kbd>n</kbd></td><td>Next thread awaiting you</td></tr>
<tr><td><kbd>⇧n</kbd></td><td>Previous thread awaiting you</td></tr>
<tr><td><kbd>e</kbd></td><td>Resolve the current thread</td></tr>
${planMode ? "" : "<tr><td><kbd>x</kbd></td><td>Toggle viewed on the current file</td></tr>"}
<tr><td><kbd>Esc</kbd></td><td>Leave the text box / close this guide</td></tr>
<tr><td><kbd>⌘⏎</kbd></td><td>Post the comment or reply being typed</td></tr>
<tr><td><kbd>⇧⌘⏎</kbd></td><td>In a comment box: quiet-add for the round · elsewhere: send the round</td></tr>
<tr><td><kbd>?</kbd></td><td>Toggle this guide</td></tr>
</tbody></table></div></div>
<script nonce="${attribute(nonce)}">${MARKDOWN_SOURCE}</script>
<script nonce="${attribute(nonce)}">${CLIENT_SOURCE}</script></body></html>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--panel:#f6f8fa;--border:#d0d7de;--text:#1f2328;--muted:#59636e;--add:#dafbe1;--add-gutter:#aceebb;--del:#ffebe9;--del-gutter:#ffcecb;--hunk:#ddf4ff;--accent:#0969da;--warning:#9a6700;--ok:#1a7f37;--danger:#cf222e;--rename:#8250df;--mark:#fff1a8;--mark-line:#bf8700} @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--add:#12261e;--add-gutter:#1f4a31;--del:#2d1517;--del-gutter:#5d2025;--hunk:#132b3a;--accent:#58a6ff;--warning:#d29922;--ok:#3fb950;--danger:#f85149;--rename:#a371f7;--mark:#5a4300;--mark-line:#d29922}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}.topbar{align-items:center;background:var(--panel);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;min-height:56px;padding:.65rem 1rem;position:sticky;top:0;z-index:20}.snapshot{color:var(--muted);font:12px ui-monospace,monospace;margin-left:.75rem}.round-chip{background:color-mix(in srgb,var(--accent) 14%,transparent);border-radius:999px;color:var(--accent);font-size:11px;font-weight:700;margin-left:.6rem;padding:.1rem .5rem}.round-switcher{display:inline-flex;gap:.25rem;margin-left:.6rem}.round-switcher a{border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:.1rem .45rem;text-decoration:none}.round-switcher a.current{border-color:var(--accent);color:var(--accent);font-weight:700}.round-switcher a.viewing{background:color-mix(in srgb,var(--accent) 14%,transparent)}.badge.stale-badge{border-color:var(--warning);color:var(--warning);font-weight:700;margin-left:.6rem;padding:.1rem .5rem}.phase-banner{align-items:center;background:color-mix(in srgb,var(--warning) 14%,transparent);border-bottom:1px solid var(--border);color:var(--warning);display:flex;font-size:13px;font-weight:650;gap:.8rem;padding:.5rem 1rem;position:sticky;top:56px;z-index:19}.phase-banner[hidden]{display:none}.phase-banner button,.phase-banner a{background:transparent;border:1px solid var(--warning);border-radius:6px;color:var(--warning);font-size:12px;font-weight:650;padding:.25rem .6rem;text-decoration:none}.phase-banner button[data-resume]{background:var(--warning);color:var(--bg);font-weight:700}.phase-banner button[data-resume]:hover{filter:brightness(1.1)}.locked [data-selection-composer],.locked [data-commentary-composer],.locked [data-overview-composer],.locked [data-finish],.locked [data-approve],.locked .thread-card .composer-actions,.locked .thread-card textarea,.locked .pi-proposes button{display:none!important}.quiet-only [data-finish],.quiet-only [data-approve],.quiet-only [data-thread-resolve],.quiet-only [data-commentary-resolve],.quiet-only .pi-proposes button,.quiet-only .turn-tools,.quiet-only [data-turn-editor]{display:none!important}.carried-threads{border-top:1px solid var(--border);margin-top:.8rem;padding-top:.8rem}.carried-threads h3{font-size:13px;margin:0 0 .4rem}.carried-thread{margin-top:.6rem}.carried-header{align-items:center;display:flex;flex-wrap:wrap;gap:.45rem}.resolution-badge{font-weight:700}.resolution-addressed{border-color:var(--ok);color:var(--ok)}.resolution-declined{border-color:var(--danger);color:var(--danger)}.resolution-needs-discussion{border-color:var(--warning);color:var(--warning)}.outdated-badge{border-color:var(--warning);color:var(--warning)}.carried-origin{color:var(--muted);font-size:11px;text-decoration:none}.carried-origin:hover{color:var(--accent);text-decoration:underline}.outdated-threads{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.outdated-threads h2{font-size:13px;margin:0 0 .35rem}.round-archive{border-top:1px solid var(--border);color:var(--muted);font-size:12px;margin-top:1rem;padding-top:1rem}.round-archive summary{cursor:pointer;font-weight:700}.archive-round h3{font-size:12px;margin:.6rem 0 .25rem}.round-archive ul{margin:.25rem 0;padding-left:1.25rem}.round-archive a{color:var(--accent);text-decoration:none}.toolbar-actions{align-items:center;display:flex;gap:.8rem}.toolbar-actions span{color:var(--muted);font-size:12px}.toolbar-actions button,.composer-actions button{background:var(--accent);border:0;border-radius:6px;color:white;font-weight:650;padding:.5rem .8rem}.toolbar-actions button:disabled,.composer-actions button:disabled{opacity:.45}.review-shell{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:calc(100vh - 56px)}.file-sidebar{background:var(--panel);border-right:1px solid var(--border);height:calc(100vh - 56px);overflow:auto;padding:.5rem;position:sticky;top:56px}.file-nav-item{align-items:center;background:transparent;border:0;border-radius:6px;color:inherit;display:flex;gap:.45rem;padding:.5rem;text-align:left;width:100%}.file-nav-item:hover,.file-nav-item.active{background:color-mix(in srgb,var(--accent) 14%,transparent)}.file-nav-item>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-nav-item>span:nth-child(3){margin-left:auto}.file-nav-item>.viewed-check[hidden]+span{margin-left:auto}.sidebar-label{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em;margin:.7rem .5rem .25rem;text-transform:uppercase}.reference-files{border-top:1px solid var(--border);margin-top:.7rem;padding-top:.45rem}.reference-files summary{color:var(--muted);cursor:pointer;font-size:11px;font-weight:700;padding:.35rem .5rem}.reference-files[open] summary{margin-bottom:.15rem}.reference-files .file-nav-item{color:var(--muted)}.overview-icon{color:var(--accent);flex:0 0 8px;font-size:9px}.status-dot{border-radius:50%;flex:0 0 8px;height:8px;background:var(--muted)}.status-added,.status-untracked{color:var(--ok)}.status-deleted{color:var(--danger)}.status-renamed{color:var(--rename)}.badge{border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:10px;padding:0 .35rem}.drift-mark{color:var(--warning);flex:0 0 auto;font-size:9px}.change-mark{color:var(--warning);flex:0 0 auto;font-size:9px}.draft-dot{color:var(--accent);flex:0 0 auto;font-size:11px}.reference-badge{margin-left:.45rem}.review-content{min-width:0;padding:1rem}.review-file[hidden],.review-overview[hidden]{display:none}.overview-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.8rem 1rem}.overview-header h1{font-size:18px;margin:.25rem 0 0}.overview-header>span{color:var(--muted);font-size:12px}.overview-body{border:1px solid var(--border);border-radius:0 0 8px 8px;max-width:760px;padding:1rem 1.2rem}.overview-body section+section{margin-top:1rem}.overview-body h2{font-size:13px;margin:0 0 .35rem}.overview-body p,.overview-body ul{margin:.25rem 0}.overview-body ul{padding-left:1.25rem}.overview-feedback{border-top:1px solid var(--border);color:var(--muted);display:block;font-size:12px;font-weight:600;margin-top:1rem;padding-top:1rem}.file-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.7rem 1rem}.file-header h1{display:inline;font:600 14px ui-monospace,monospace;margin:.5rem}.file-header>span,.file-header-side>span,.old-path{color:var(--muted);font-size:12px}.file-header-side{align-items:center;display:flex;gap:.8rem}.viewed-toggle{align-items:center;color:var(--muted);cursor:pointer;display:inline-flex;font-size:12px;gap:.3rem;user-select:none}.viewed-toggle input{accent-color:var(--accent);margin:0}.viewed-check{color:var(--ok);font-weight:700}.viewed-progress{align-items:center;display:flex;gap:.5rem;padding:.4rem .5rem .1rem}.viewed-progressbar{background:var(--border);border-radius:999px;flex:1;height:5px;overflow:hidden}.viewed-progressbar div{background:var(--accent);height:100%;transition:width .2s}.viewed-progress span{color:var(--muted);font-size:11px;white-space:nowrap}button.shortcuts-hint{background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:12px;font-weight:600;padding:.35rem .55rem}button.shortcuts-hint:hover{color:var(--text)}.shortcuts-hint kbd{background:var(--panel);border:1px solid var(--border);border-radius:4px;font:11px ui-monospace,monospace;padding:0 .3rem}.status{font-size:11px;font-weight:700;text-transform:uppercase}.file-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:1rem}.diff-column{border:1px solid var(--border);border-top:0;min-width:0;overflow:auto}.diff-table{border-collapse:collapse;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;table-layout:auto;width:100%}.diff-table td{border:0;padding:0 .45rem;vertical-align:top}.line-number,.line-marker{color:var(--muted);text-align:right;user-select:none;width:1%;white-space:nowrap}.diff-line .line-number{cursor:pointer}.diff-line .line-number:hover{color:var(--accent)}.line-marker{padding-right:.1rem!important}.diff-code{white-space:pre;min-width:100%}.diff-add{background:var(--add)}.diff-add .line-number,.diff-add .line-marker{background:var(--add-gutter)}.diff-del{background:var(--del)}.diff-del .line-number,.diff-del .line-marker{background:var(--del-gutter)}.diff-add .intraline{background:var(--add-gutter);border-radius:2px}.diff-del .intraline{background:var(--del-gutter);border-radius:2px}.diff-hunk{background:var(--hunk);color:var(--muted)}tr.nav-cursor td{box-shadow:inset 0 2px var(--accent),inset 0 -2px var(--accent)}tr.nav-cursor td:first-child{box-shadow:inset 2px 2px var(--accent),inset 0 -2px var(--accent)}tr.nav-cursor td:last-child{box-shadow:inset -2px 2px var(--accent),inset 0 -2px var(--accent)}.diff-meta{color:var(--muted)}.diff-expander td{background:var(--hunk)}.diff-expander button{background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--accent);cursor:pointer;font:11px/1.4 system-ui,sans-serif;margin-right:.35rem;padding:0 .4rem}.diff-expander button:hover{background:color-mix(in srgb,var(--accent) 14%,transparent)}.diff-expander button:disabled{color:var(--muted);cursor:default}.expander-note{color:var(--muted);font:11px system-ui,sans-serif;margin-left:.35rem}.unselectable{user-select:none}.file-banner{padding:2rem;text-align:center;color:var(--muted)}.plan-column{border:1px solid var(--border);border-top:0;min-width:0;overflow:auto}.plan-doc{max-width:760px;padding:1rem 1.4rem}.plan-doc [data-md-line].nav-cursor{box-shadow:inset 3px 0 var(--accent);padding-left:.4rem}.status-section{color:var(--accent)}.file-banner.warning{color:var(--warning)}.commentary-column{border:1px solid var(--border);border-radius:8px;height:max-content;max-height:calc(100vh - 90px);overflow:auto;padding:1rem;position:sticky;top:72px}.commentary-column h2,.commentary-column h3{font-size:14px;margin:0 0 .6rem}.file-summary{background:var(--panel);border-radius:6px;padding:.7rem}.file-summary pre{background:var(--bg)}.agent-note{border-top:1px solid var(--border);margin-top:.8rem;padding-top:.8rem}.agent-note-anchor{background:transparent;border:0;color:var(--accent);cursor:pointer;font-size:11px;font-weight:700;padding:0}.agent-note-anchor:disabled{color:var(--muted);cursor:default}.agent-note-body{margin:.35rem 0}.md p{margin:.35rem 0}.md p:first-child{margin-top:0}.md p:last-child{margin-bottom:0}.md ul,.md ol{margin:.35rem 0;padding-left:1.25rem}.md li{margin:.1rem 0}.md code{background:color-mix(in srgb,var(--muted) 14%,transparent);border-radius:4px;font:.92em ui-monospace,monospace;padding:0 .25rem}.md pre{background:var(--panel);border:1px solid var(--border);border-radius:6px;margin:.4rem 0;overflow:auto;padding:.5rem}.md pre code{background:transparent;border-radius:0;display:block;font:12px/1.45 ui-monospace,monospace;padding:0;white-space:pre}.md a{color:var(--accent)}.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{line-height:1.25;margin:.9em 0 .35em}.md h1{font-size:1.5em}.md h2{font-size:1.3em}.md h3{font-size:1.15em}.md h4,.md h5,.md h6{font-size:1em}.md h1:first-child,.md h2:first-child,.md h3:first-child{margin-top:0}.md blockquote{border-left:3px solid var(--border);color:var(--muted);margin:.4rem 0;padding:.1rem 0 .1rem .75rem}.md hr{border:0;border-top:1px solid var(--border);margin:.8rem 0}.md table{border-collapse:collapse;margin:.4rem 0}.md th,.md td{border:1px solid var(--border);padding:.25rem .6rem;text-align:left}.md th{background:var(--panel)}.agent-note label{color:var(--muted);font-size:11px}.agent-note textarea,.selection-composer textarea,.thread-card textarea,.overview-feedback textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:inherit;font:13px system-ui,sans-serif;margin-top:.3rem;min-height:60px;padding:.5rem;resize:vertical;width:100%}.user-comments{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.selection-composer{background:var(--panel);border:1px solid var(--accent);border-radius:8px;margin-top:1rem;padding:.7rem}.selection-quote,.user-comment-quote{border-left:3px solid var(--accent);color:var(--muted);font:11px ui-monospace,monospace;margin-bottom:.4rem;max-height:5rem;overflow:auto;padding-left:.5rem;white-space:pre-wrap}.composer-actions{display:flex;gap:.4rem;justify-content:flex-end;margin-top:.4rem}.composer-actions button:first-child{background:transparent;border:1px solid var(--border);color:inherit}::highlight(pi-code-review-feedback){background:var(--mark);text-decoration:underline 2px var(--mark-line)}.toolbar-actions .inbox-strip{background:color-mix(in srgb,var(--accent) 16%,transparent);border:1px solid var(--accent);border-radius:999px;color:var(--accent);font-weight:700}.thread-card{border:1px solid var(--border);border-radius:8px;margin-top:.65rem;padding:.6rem .7rem}.thread-card.awaiting{border-color:var(--accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent)}.thread-card.resolved{opacity:.62}.thread-card.queued{border-style:dashed}.thread-card.queued .thread-status,.thread-card.pending .thread-status{color:var(--warning)}.thread-card-header{align-items:center;display:flex;gap:.5rem;justify-content:space-between}.thread-status{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.thread-card.awaiting .thread-status{color:var(--accent)}.thread-turn{margin:.45rem 0}.thread-turn .turn-author{color:var(--muted);display:block;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.thread-turn.turn-pi .turn-author{color:var(--accent)}.turn-tools{display:flex;gap:.6rem;margin-top:.15rem}.turn-tools button{background:transparent;border:0;color:var(--muted);cursor:pointer;font-size:11px;font-weight:600;padding:0}.turn-tools button:hover{color:var(--accent)}.locked .turn-tools,.locked [data-turn-editor]{display:none!important}.pi-proposes{background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:6px;color:var(--accent);font-size:11px;font-weight:650;margin-top:.4rem;padding:.35rem .5rem}.thread-flash{animation:thread-flash 1.2s ease-out}@keyframes thread-flash{0%{box-shadow:0 0 0 3px var(--accent)}100%{box-shadow:0 0 0 1px transparent}}.unread-badge{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}.thread-tally{color:var(--muted);display:flex;flex-wrap:wrap;gap:.9rem;font-size:12px}.thread-tally strong{color:var(--text)}.shortcuts-overlay{align-items:center;background:rgba(0,0,0,.45);display:flex;inset:0;justify-content:center;position:fixed;z-index:50}.shortcuts-overlay[hidden]{display:none}.shortcuts-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;min-width:300px;padding:1rem 1.2rem}.shortcuts-card h2{font-size:14px;margin:0 0 .6rem}.shortcuts-card table{border-collapse:collapse;font-size:13px}.shortcuts-card td{padding:.25rem .7rem .25rem 0}.shortcuts-card kbd{background:var(--panel);border:1px solid var(--border);border-radius:4px;font:11px ui-monospace,monospace;padding:.1rem .4rem}.approve-button{background:var(--ok)!important}.approve-card{max-width:520px;width:90vw}.approve-stats{color:var(--muted);font-size:12px;margin:.2rem 0 .6rem}.approve-stale-warning{background:color-mix(in srgb,var(--warning) 14%,transparent);border-radius:6px;color:var(--warning);font-size:12px;font-weight:650;margin:.2rem 0 .6rem;padding:.45rem .6rem}.approve-message-label{color:var(--muted);display:block;font-size:12px}.approve-card textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font:13px ui-monospace,monospace;margin-top:.3rem;min-height:110px;padding:.5rem;resize:vertical;width:100%}.approve-card .composer-actions button[data-approve-confirm]{background:var(--ok)}@media(max-width:900px){.review-shell{grid-template-columns:1fr}.file-sidebar{display:flex;height:auto;overflow:auto;position:static}.file-nav-item{min-width:180px}.file-layout{grid-template-columns:1fr}.commentary-column{max-height:none;position:static}}@media(max-width:600px){.topbar{align-items:flex-start;gap:.5rem}.toolbar-actions span{display:none}.review-content{padding:.5rem}.file-layout{display:block}.commentary-column{margin-top:.75rem}}
`;
