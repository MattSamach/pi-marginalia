import { readFileSync } from "node:fs";

const CLIENT_SOURCE = readFileSync(new URL("../client/review.js", import.meta.url), "utf8");

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
  <div class="agent-note-body">${text(entry.body)}</div>
  <div data-commentary-thread="${attribute(entry.id)}"></div>
  <div data-commentary-composer="${attribute(entry.id)}"><label>Reply to Pi<textarea data-commentary-reply="${attribute(entry.id)}" maxlength="20000" placeholder="Respond to this explanation"></textarea></label><div class="composer-actions"><button type="button" data-commentary-resolve="${attribute(entry.id)}" title="Mark this note read; never messages Pi">Resolve</button><button type="button" data-commentary-post="${attribute(entry.id)}" title="Reply (⌘⏎ live · ⇧⌘⏎ quiet)" disabled>Reply</button></div></div>
</article>`).join("\n");
	return `<aside class="commentary-column" aria-label="Pi commentary for ${attribute(file.path)}">
  <h2>Pi commentary</h2>
  <div class="file-summary">${file.summary ? text(file.summary) : "No file-level commentary supplied."}</div>
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

function renderDiffLine(fileIndex, line, lineIndex) {
	const oldValue = line.oldLine ?? "";
	const newValue = line.newLine ?? "";
	const selectable = ["add", "del", "context"].includes(line.kind);
	return `<tr class="diff-line diff-${line.kind}" data-file-index="${fileIndex}" data-line-index="${lineIndex}" data-kind="${line.kind}"${line.oldLine === undefined ? "" : ` data-old-line="${line.oldLine}"`}${line.newLine === undefined ? "" : ` data-new-line="${line.newLine}"`}>
  <td class="line-number" aria-label="Old line">${oldValue}</td><td class="line-number" aria-label="New line">${newValue}</td><td class="line-marker" aria-hidden="true">${line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
  <td class="diff-code${selectable ? "" : " unselectable"}" id="diff-${fileIndex}-${lineIndex}"><span>${text(line.content) || "\u00a0"}</span></td>
</tr>`;
}

function renderFile(file, index, carriedByFile, viewedSet) {
	let body;
	if (file.binary) body = '<div class="file-banner">Binary content is not rendered.</div>';
	else if (file.omitted) body = '<div class="file-banner warning">Omitted because the overall review rendering cap was reached.</div>';
	else body = `<table class="diff-table" aria-label="Unified diff for ${attribute(file.path)}"><tbody>${file.lines.map((line, lineIndex) => renderDiffLine(index, line, lineIndex)).join("\n")}</tbody></table>${file.truncated ? `<div class="file-banner warning">Diff truncated at 200 KiB or 2,000 lines (${file.patchBytes.toLocaleString()} bytes, ${file.totalDiffLines.toLocaleString()} total lines).</div>` : ""}`;
	const rename = file.oldPath ? `<span class="old-path">from ${text(file.oldPath)}</span>` : "";
	const referenceBadge = file.reviewMode === "reference" ? '<span class="badge reference-badge">reference</span>' : "";
	const position = file.reviewMode === "reference" ? "Reference file" : `${file.reviewOrdinal} / ${file.reviewCount}`;
	return `<section class="review-file${file.initiallyActive ? " active" : ""}" data-review-file="${index}" data-path="${attribute(file.path)}" data-review-mode="${attribute(file.reviewMode)}"${file.initiallyActive ? "" : " hidden"}>
  <header class="file-header"><div><span class="status status-${attribute(file.status)}">${text(file.status)}</span><h1>${text(file.path)}</h1>${rename}${referenceBadge}</div><div class="file-header-side"><span>${position}</span><label class="viewed-toggle" title="Mark this file viewed (x)"><input type="checkbox" data-viewed-toggle${viewedSet.has(file.path) ? " checked" : ""}>Viewed</label></div></header>
  <div class="file-layout"><main class="diff-column">${body}</main>${renderCommentary(file, carriedByFile.get(file.path) ?? [])}</div>
</section>`;
}

function renderFileNav(file, index, viewedSet) {
	const badges = [file.binary ? "binary" : undefined, file.omitted ? "omitted" : undefined, file.truncated ? "truncated" : undefined].filter(Boolean);
	return `<button type="button" class="file-nav-item${file.initiallyActive ? " active" : ""}" data-file-nav="${index}" title="${attribute(file.path)}"><span class="status-dot status-${attribute(file.status)}"></span><span>${text(file.path)}</span><span class="viewed-check" data-viewed-check="${attribute(file.path)}"${viewedSet.has(file.path) ? "" : " hidden"}>✓</span>${badges.map((badge) => `<span class="badge">${badge}</span>`).join("")}<span class="badge unread-badge" data-unread-badge hidden></span></button>`;
}

export function renderReviewHtml(review, nonce, session = { round: 1, currentRound: 1, phase: "reviewing" }, extras = { carried: [], archive: [] }) {
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
	const reviewNav = reviewEntries.length ? `<div class="sidebar-label">Review files</div>${reviewEntries.map(({ file, index }) => renderFileNav(file, index, viewedSet)).join("\n")}` : "";
	const referenceNav = referenceEntries.length ? `<details class="reference-files"${!hasOverview && reviewEntries.length === 0 ? " open" : ""}><summary>Reference files (${referenceEntries.length})<span class="badge unread-badge" data-reference-unread hidden></span></summary>${referenceEntries.map(({ file, index }) => renderFileNav(file, index, viewedSet)).join("\n")}</details>` : "";
	const viewedCount = files.filter((file) => viewedSet.has(file.path)).length;
	const viewedProgress = files.length ? `<div class="viewed-progress" data-viewed-progress title="Files marked viewed"><div class="viewed-progressbar"><div data-viewed-bar style="width:${Math.round((viewedCount / files.length) * 100)}%"></div></div><span data-viewed-count>${viewedCount} / ${files.length} viewed</span></div>` : "";
	const status = hasOverview ? "Read the overview, then discuss each file with Pi." : "Select changed code or reply to Pi.";
	const switcher = `<nav class="round-switcher" data-round-switcher${session.currentRound > 1 ? "" : " hidden"}></nav>`;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(review.title)}</title><link rel="icon" href="data:,"><style>${STYLE}</style></head>
<body data-round="${session.round}" data-current-round="${session.currentRound}" data-phase="${attribute(session.phase)}"><header class="topbar"><div><strong>${text(review.title)}</strong><span class="round-chip" data-round-chip>round ${session.round}</span><span class="snapshot" title="${attribute(review.id)}">snapshot ${text(review.id.slice(0, 12))}</span><span class="badge stale-badge" data-stale-badge hidden title="The working tree no longer matches this frozen snapshot. Reading and commenting stay open; threads carry into the next round.">worktree changed since this snapshot</span>${switcher}</div><div class="toolbar-actions"><button type="button" class="inbox-strip" data-inbox hidden title="Next thread awaiting you (n)"></button><span data-global-status>${status}</span><button type="button" class="shortcuts-hint" data-shortcuts-hint title="Keyboard shortcuts"><kbd>?</kbd> shortcuts</button><button type="button" data-finish>Send round to Pi</button></div></header>
<div class="phase-banner" data-phase-banner hidden><span data-phase-banner-text></span><button type="button" data-resume hidden>Resume reviewing this round</button><a data-goto-current href="/" hidden>Go to current round</a></div>
<div class="review-shell"><nav class="file-sidebar" aria-label="Review navigation">${viewedProgress}${overviewNav}${reviewNav}${referenceNav}</nav><div class="review-content" id="review-root">${renderOverview(review, extras)}${files.map((file, index) => renderFile(file, index, carriedByFile, viewedSet)).join("\n")}</div></div>
<div class="shortcuts-overlay" data-shortcuts-overlay hidden><div class="shortcuts-card" role="dialog" aria-label="Keyboard shortcuts"><h2>Keyboard shortcuts</h2><table><tbody>
<tr><td><kbd>n</kbd></td><td>Next thread awaiting you</td></tr>
<tr><td><kbd>⇧n</kbd></td><td>Previous thread awaiting you</td></tr>
<tr><td><kbd>e</kbd></td><td>Resolve the current thread</td></tr>
<tr><td><kbd>x</kbd></td><td>Toggle viewed on the current file</td></tr>
<tr><td><kbd>Esc</kbd></td><td>Leave the text box / close this guide</td></tr>
<tr><td><kbd>⌘⏎</kbd></td><td>Post the comment or reply being typed</td></tr>
<tr><td><kbd>⇧⌘⏎</kbd></td><td>Quiet-add: keep it for the round instead of messaging Pi now</td></tr>
<tr><td><kbd>?</kbd></td><td>Toggle this guide</td></tr>
</tbody></table></div></div>
<script nonce="${attribute(nonce)}">${CLIENT_SOURCE}</script></body></html>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--panel:#f6f8fa;--border:#d0d7de;--text:#1f2328;--muted:#59636e;--add:#dafbe1;--add-gutter:#aceebb;--del:#ffebe9;--del-gutter:#ffcecb;--hunk:#ddf4ff;--accent:#0969da;--warning:#9a6700} @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--add:#12261e;--add-gutter:#1f4a31;--del:#2d1517;--del-gutter:#5d2025;--hunk:#132b3a;--accent:#58a6ff;--warning:#d29922}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}.topbar{align-items:center;background:var(--panel);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;min-height:56px;padding:.65rem 1rem;position:sticky;top:0;z-index:20}.snapshot{color:var(--muted);font:12px ui-monospace,monospace;margin-left:.75rem}.round-chip{background:color-mix(in srgb,var(--accent) 14%,transparent);border-radius:999px;color:var(--accent);font-size:11px;font-weight:700;margin-left:.6rem;padding:.1rem .5rem}.round-switcher{display:inline-flex;gap:.25rem;margin-left:.6rem}.round-switcher a{border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:.1rem .45rem;text-decoration:none}.round-switcher a.current{border-color:var(--accent);color:var(--accent);font-weight:700}.round-switcher a.viewing{background:color-mix(in srgb,var(--accent) 14%,transparent)}.stale-badge{border-color:var(--warning);color:var(--warning);font-weight:700;margin-left:.6rem;padding:.1rem .5rem}.phase-banner{align-items:center;background:color-mix(in srgb,var(--warning) 14%,transparent);border-bottom:1px solid var(--border);color:var(--warning);display:flex;font-size:13px;font-weight:650;gap:.8rem;padding:.5rem 1rem;position:sticky;top:56px;z-index:19}.phase-banner[hidden]{display:none}.phase-banner button,.phase-banner a{background:transparent;border:1px solid var(--warning);border-radius:6px;color:var(--warning);font-size:12px;font-weight:650;padding:.25rem .6rem;text-decoration:none}.phase-banner button[data-resume]{background:var(--warning);color:var(--bg);font-weight:700}.phase-banner button[data-resume]:hover{filter:brightness(1.1)}.locked [data-selection-composer],.locked [data-commentary-composer],.locked [data-overview-composer],.locked [data-finish],.locked .thread-card .composer-actions,.locked .thread-card textarea,.locked .pi-proposes button{display:none!important}.carried-threads{border-top:1px solid var(--border);margin-top:.8rem;padding-top:.8rem}.carried-threads h3{font-size:13px;margin:0 0 .4rem}.carried-thread{margin-top:.6rem}.carried-header{align-items:center;display:flex;flex-wrap:wrap;gap:.45rem}.resolution-badge{font-weight:700}.resolution-addressed{border-color:#1a7f37;color:#1a7f37}.resolution-declined{border-color:#cf222e;color:#cf222e}.resolution-needs-discussion{border-color:var(--warning);color:var(--warning)}.outdated-badge{border-color:var(--warning);color:var(--warning)}.carried-origin{color:var(--muted);font-size:11px;text-decoration:none}.carried-origin:hover{color:var(--accent);text-decoration:underline}.outdated-threads{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.outdated-threads h2{font-size:13px;margin:0 0 .35rem}.round-archive{border-top:1px solid var(--border);color:var(--muted);font-size:12px;margin-top:1rem;padding-top:1rem}.round-archive summary{cursor:pointer;font-weight:700}.archive-round h3{font-size:12px;margin:.6rem 0 .25rem}.round-archive ul{margin:.25rem 0;padding-left:1.25rem}.round-archive a{color:var(--accent);text-decoration:none}.toolbar-actions{align-items:center;display:flex;gap:.8rem}.toolbar-actions span{color:var(--muted);font-size:12px}.toolbar-actions button,.composer-actions button{background:var(--accent);border:0;border-radius:6px;color:white;font-weight:650;padding:.5rem .8rem}.toolbar-actions button:disabled,.composer-actions button:disabled{opacity:.45}.review-shell{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:calc(100vh - 56px)}.file-sidebar{background:var(--panel);border-right:1px solid var(--border);height:calc(100vh - 56px);overflow:auto;padding:.5rem;position:sticky;top:56px}.file-nav-item{align-items:center;background:transparent;border:0;border-radius:6px;color:inherit;display:flex;gap:.45rem;padding:.5rem;text-align:left;width:100%}.file-nav-item:hover,.file-nav-item.active{background:color-mix(in srgb,var(--accent) 14%,transparent)}.file-nav-item>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-nav-item>span:nth-child(3){margin-left:auto}.file-nav-item>.viewed-check[hidden]+span{margin-left:auto}.sidebar-label{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em;margin:.7rem .5rem .25rem;text-transform:uppercase}.reference-files{border-top:1px solid var(--border);margin-top:.7rem;padding-top:.45rem}.reference-files summary{color:var(--muted);cursor:pointer;font-size:11px;font-weight:700;padding:.35rem .5rem}.reference-files[open] summary{margin-bottom:.15rem}.reference-files .file-nav-item{color:var(--muted)}.overview-icon{color:var(--accent);flex:0 0 8px;font-size:9px}.status-dot{border-radius:50%;flex:0 0 8px;height:8px;background:var(--muted)}.status-added,.status-untracked{color:#1a7f37}.status-deleted{color:#cf222e}.status-renamed{color:#8250df}.badge{border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:10px;padding:0 .35rem}.reference-badge{margin-left:.45rem}.review-content{min-width:0;padding:1rem}.review-file[hidden],.review-overview[hidden]{display:none}.overview-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.8rem 1rem}.overview-header h1{font-size:18px;margin:.25rem 0 0}.overview-header>span{color:var(--muted);font-size:12px}.overview-body{border:1px solid var(--border);border-radius:0 0 8px 8px;max-width:760px;padding:1rem 1.2rem}.overview-body section+section{margin-top:1rem}.overview-body h2{font-size:13px;margin:0 0 .35rem}.overview-body p,.overview-body ul{margin:.25rem 0}.overview-body ul{padding-left:1.25rem}.overview-feedback{border-top:1px solid var(--border);color:var(--muted);display:block;font-size:12px;font-weight:600;margin-top:1rem;padding-top:1rem}.file-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.7rem 1rem}.file-header h1{display:inline;font:600 14px ui-monospace,monospace;margin:.5rem}.file-header>span,.file-header-side>span,.old-path{color:var(--muted);font-size:12px}.file-header-side{align-items:center;display:flex;gap:.8rem}.viewed-toggle{align-items:center;color:var(--muted);cursor:pointer;display:inline-flex;font-size:12px;gap:.3rem;user-select:none}.viewed-toggle input{accent-color:var(--accent);margin:0}.viewed-check{color:#1a7f37;font-weight:700}.viewed-progress{align-items:center;display:flex;gap:.5rem;padding:.4rem .5rem .1rem}.viewed-progressbar{background:var(--border);border-radius:999px;flex:1;height:5px;overflow:hidden}.viewed-progressbar div{background:var(--accent);height:100%;transition:width .2s}.viewed-progress span{color:var(--muted);font-size:11px;white-space:nowrap}button.shortcuts-hint{background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:12px;font-weight:600;padding:.35rem .55rem}button.shortcuts-hint:hover{color:var(--text)}.shortcuts-hint kbd{background:var(--panel);border:1px solid var(--border);border-radius:4px;font:11px ui-monospace,monospace;padding:0 .3rem}.status{font-size:11px;font-weight:700;text-transform:uppercase}.file-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:1rem}.diff-column{border:1px solid var(--border);border-top:0;min-width:0;overflow:auto}.diff-table{border-collapse:collapse;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;table-layout:auto;width:100%}.diff-table td{border:0;padding:0 .45rem;vertical-align:top}.line-number,.line-marker{color:var(--muted);text-align:right;user-select:none;width:1%;white-space:nowrap}.line-marker{padding-right:.1rem!important}.diff-code{white-space:pre;min-width:100%}.diff-add{background:var(--add)}.diff-add .line-number,.diff-add .line-marker{background:var(--add-gutter)}.diff-del{background:var(--del)}.diff-del .line-number,.diff-del .line-marker{background:var(--del-gutter)}.diff-hunk{background:var(--hunk);color:var(--muted)}.diff-meta{color:var(--muted)}.unselectable{user-select:none}.file-banner{padding:2rem;text-align:center;color:var(--muted)}.file-banner.warning{color:var(--warning)}.commentary-column{border:1px solid var(--border);border-radius:8px;height:max-content;max-height:calc(100vh - 90px);overflow:auto;padding:1rem;position:sticky;top:72px}.commentary-column h2,.commentary-column h3{font-size:14px;margin:0 0 .6rem}.file-summary{background:var(--panel);border-radius:6px;padding:.7rem;white-space:pre-wrap}.agent-note{border-top:1px solid var(--border);margin-top:.8rem;padding-top:.8rem}.agent-note-anchor{background:transparent;border:0;color:var(--accent);cursor:pointer;font-size:11px;font-weight:700;padding:0}.agent-note-anchor:disabled{color:var(--muted);cursor:default}.agent-note-body{margin:.35rem 0;white-space:pre-wrap}.agent-note label{color:var(--muted);font-size:11px}.agent-note textarea,.selection-composer textarea,.thread-card textarea,.overview-feedback textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:inherit;font:13px system-ui,sans-serif;margin-top:.3rem;min-height:60px;padding:.5rem;resize:vertical;width:100%}.user-comments{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.selection-composer{background:var(--panel);border:1px solid var(--accent);border-radius:8px;margin-top:1rem;padding:.7rem}.selection-quote,.user-comment-quote{border-left:3px solid var(--accent);color:var(--muted);font:11px ui-monospace,monospace;margin-bottom:.4rem;max-height:5rem;overflow:auto;padding-left:.5rem;white-space:pre-wrap}.composer-actions{display:flex;gap:.4rem;justify-content:flex-end;margin-top:.4rem}.composer-actions button:first-child{background:transparent;border:1px solid var(--border);color:inherit}::highlight(pi-code-review-feedback){background:#fff1a8;text-decoration:underline 2px #bf8700}.toolbar-actions .inbox-strip{background:color-mix(in srgb,var(--accent) 16%,transparent);border:1px solid var(--accent);border-radius:999px;color:var(--accent);font-weight:700}.thread-card{border:1px solid var(--border);border-radius:8px;margin-top:.65rem;padding:.6rem .7rem}.thread-card.awaiting{border-color:var(--accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent)}.thread-card.resolved{opacity:.62}.thread-card.queued{border-style:dashed}.thread-card.queued .thread-status,.thread-card.pending .thread-status{color:var(--warning)}.thread-card-header{align-items:center;display:flex;gap:.5rem;justify-content:space-between}.thread-status{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.thread-card.awaiting .thread-status{color:var(--accent)}.thread-turn{margin:.45rem 0;white-space:pre-wrap}.thread-turn .turn-author{color:var(--muted);display:block;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.thread-turn.turn-pi .turn-author{color:var(--accent)}.turn-tools{display:flex;gap:.6rem;margin-top:.15rem}.turn-tools button{background:transparent;border:0;color:var(--muted);cursor:pointer;font-size:11px;font-weight:600;padding:0}.turn-tools button:hover{color:var(--accent)}.locked .turn-tools,.locked [data-turn-editor]{display:none!important}.pi-proposes{background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:6px;color:var(--accent);font-size:11px;font-weight:650;margin-top:.4rem;padding:.35rem .5rem}.thread-flash{animation:thread-flash 1.2s ease-out}@keyframes thread-flash{0%{box-shadow:0 0 0 3px var(--accent)}100%{box-shadow:0 0 0 1px transparent}}.unread-badge{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}.thread-tally{color:var(--muted);display:flex;flex-wrap:wrap;gap:.9rem;font-size:12px}.thread-tally strong{color:var(--text)}.shortcuts-overlay{align-items:center;background:rgba(0,0,0,.45);display:flex;inset:0;justify-content:center;position:fixed;z-index:50}.shortcuts-overlay[hidden]{display:none}.shortcuts-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;min-width:300px;padding:1rem 1.2rem}.shortcuts-card h2{font-size:14px;margin:0 0 .6rem}.shortcuts-card table{border-collapse:collapse;font-size:13px}.shortcuts-card td{padding:.25rem .7rem .25rem 0}.shortcuts-card kbd{background:var(--panel);border:1px solid var(--border);border-radius:4px;font:11px ui-monospace,monospace;padding:.1rem .4rem}@media(max-width:900px){.review-shell{grid-template-columns:1fr}.file-sidebar{display:flex;height:auto;overflow:auto;position:static}.file-nav-item{min-width:180px}.file-layout{grid-template-columns:1fr}.commentary-column{max-height:none;position:static}}@media(max-width:600px){.topbar{align-items:flex-start;gap:.5rem}.toolbar-actions span{display:none}.review-content{padding:.5rem}.file-layout{display:block}.commentary-column{margin-top:.75rem}}
`;
