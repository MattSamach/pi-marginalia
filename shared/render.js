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

function renderOverview(review) {
	if (!review.overview) return "";
	const overview = review.overview;
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
    <section class="overview-feedback"><h2>General feedback</h2><div data-overview-thread></div><div data-overview-composer><textarea data-overview-feedback maxlength="20000" placeholder="Discuss the change set with Pi"></textarea><div class="composer-actions"><button type="button" data-overview-post disabled>Post to Pi</button></div></div></section>
  </main>
</section>`;
}

function renderCommentary(file) {
	const cards = file.commentary.map((entry) => `<article class="agent-note" data-commentary-id="${attribute(entry.id)}" data-anchor-side="${attribute(entry.side)}"${entry.startLine === undefined ? "" : ` data-anchor-start="${entry.startLine}"`}>
  <button type="button" class="agent-note-anchor"${entry.startLine === undefined ? " disabled" : ""}>${text(rangeLabel(entry))}</button>
  <div class="agent-note-body">${text(entry.body)}</div>
  <div data-commentary-thread="${attribute(entry.id)}"></div>
  <div data-commentary-composer="${attribute(entry.id)}"><label>Reply to Pi<textarea data-commentary-reply="${attribute(entry.id)}" maxlength="20000" placeholder="Respond to this explanation"></textarea></label><div class="composer-actions"><button type="button" data-commentary-post="${attribute(entry.id)}" title="Reply (Command or Ctrl+Enter)" disabled>Reply</button></div></div>
</article>`).join("\n");
	return `<aside class="commentary-column" aria-label="Pi commentary for ${attribute(file.path)}">
  <h2>Pi commentary</h2>
  <div class="file-summary">${file.summary ? text(file.summary) : "No file-level commentary supplied."}</div>
  ${cards || '<p class="empty-note">No anchored commentary for this file.</p>'}
  <section class="user-comments"><h3>Your comment threads</h3><div data-selection-threads></div></section>
  <section class="selection-composer" data-selection-composer hidden>
    <div class="selection-quote" data-selection-quote></div>
    <textarea data-selection-feedback maxlength="20000" placeholder="Comment on this selection"></textarea>
    <div class="composer-actions"><button type="button" data-selection-cancel>Cancel</button><button type="button" data-selection-add title="Post comment (Command or Ctrl+Enter)" disabled>Post comment</button></div>
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

function renderFile(file, index) {
	let body;
	if (file.binary) body = '<div class="file-banner">Binary content is not rendered.</div>';
	else if (file.omitted) body = '<div class="file-banner warning">Omitted because the overall review rendering cap was reached.</div>';
	else body = `<table class="diff-table" aria-label="Unified diff for ${attribute(file.path)}"><tbody>${file.lines.map((line, lineIndex) => renderDiffLine(index, line, lineIndex)).join("\n")}</tbody></table>${file.truncated ? `<div class="file-banner warning">Diff truncated at 200 KiB or 2,000 lines (${file.patchBytes.toLocaleString()} bytes, ${file.totalDiffLines.toLocaleString()} total lines).</div>` : ""}`;
	const rename = file.oldPath ? `<span class="old-path">from ${text(file.oldPath)}</span>` : "";
	const referenceBadge = file.reviewMode === "reference" ? '<span class="badge reference-badge">reference</span>' : "";
	const position = file.reviewMode === "reference" ? "Reference file" : `${file.reviewOrdinal} / ${file.reviewCount}`;
	return `<section class="review-file${file.initiallyActive ? " active" : ""}" data-review-file="${index}" data-path="${attribute(file.path)}" data-review-mode="${attribute(file.reviewMode)}"${file.initiallyActive ? "" : " hidden"}>
  <header class="file-header"><div><span class="status status-${attribute(file.status)}">${text(file.status)}</span><h1>${text(file.path)}</h1>${rename}${referenceBadge}</div><span>${position}</span></header>
  <div class="file-layout"><main class="diff-column">${body}</main>${renderCommentary(file)}</div>
</section>`;
}

function renderFileNav(file, index) {
	const badges = [file.binary ? "binary" : undefined, file.omitted ? "omitted" : undefined, file.truncated ? "truncated" : undefined].filter(Boolean);
	return `<button type="button" class="file-nav-item${file.initiallyActive ? " active" : ""}" data-file-nav="${index}" title="${attribute(file.path)}"><span class="status-dot status-${attribute(file.status)}"></span><span>${text(file.path)}</span>${badges.map((badge) => `<span class="badge">${badge}</span>`).join("")}<span class="badge unread-badge" data-unread-badge hidden></span></button>`;
}

export function renderReviewHtml(review, nonce) {
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
	const reviewNav = reviewEntries.length ? `<div class="sidebar-label">Review files</div>${reviewEntries.map(({ file, index }) => renderFileNav(file, index)).join("\n")}` : "";
	const referenceNav = referenceEntries.length ? `<details class="reference-files"${!hasOverview && reviewEntries.length === 0 ? " open" : ""}><summary>Reference files (${referenceEntries.length})<span class="badge unread-badge" data-reference-unread hidden></span></summary>${referenceEntries.map(({ file, index }) => renderFileNav(file, index)).join("\n")}</details>` : "";
	const status = hasOverview ? "Read the overview, then discuss each file with Pi." : "Select changed code or reply to Pi.";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(review.title)}</title><link rel="icon" href="data:,"><style>${STYLE}</style></head>
<body><header class="topbar"><div><strong>${text(review.title)}</strong><span class="snapshot" title="${attribute(review.id)}">snapshot ${text(review.id.slice(0, 12))}</span></div><div class="toolbar-actions"><button type="button" class="inbox-strip" data-inbox hidden title="Next thread awaiting you (n)"></button><span data-global-status>${status}</span><button type="button" data-finish>Finish review pass</button></div></header>
<div class="review-shell"><nav class="file-sidebar" aria-label="Review navigation">${overviewNav}${reviewNav}${referenceNav}</nav><div class="review-content" id="review-root">${renderOverview(review)}${files.map(renderFile).join("\n")}</div></div>
<script nonce="${attribute(nonce)}">${CLIENT_SOURCE}</script></body></html>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--panel:#f6f8fa;--border:#d0d7de;--text:#1f2328;--muted:#59636e;--add:#dafbe1;--add-gutter:#aceebb;--del:#ffebe9;--del-gutter:#ffcecb;--hunk:#ddf4ff;--accent:#0969da;--warning:#9a6700} @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--add:#12261e;--add-gutter:#1f4a31;--del:#2d1517;--del-gutter:#5d2025;--hunk:#132b3a;--accent:#58a6ff;--warning:#d29922}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}.topbar{align-items:center;background:var(--panel);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;min-height:56px;padding:.65rem 1rem;position:sticky;top:0;z-index:20}.snapshot{color:var(--muted);font:12px ui-monospace,monospace;margin-left:.75rem}.toolbar-actions{align-items:center;display:flex;gap:.8rem}.toolbar-actions span{color:var(--muted);font-size:12px}.toolbar-actions button,.composer-actions button{background:var(--accent);border:0;border-radius:6px;color:white;font-weight:650;padding:.5rem .8rem}.toolbar-actions button:disabled,.composer-actions button:disabled{opacity:.45}.review-shell{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:calc(100vh - 56px)}.file-sidebar{background:var(--panel);border-right:1px solid var(--border);height:calc(100vh - 56px);overflow:auto;padding:.5rem;position:sticky;top:56px}.file-nav-item{align-items:center;background:transparent;border:0;border-radius:6px;color:inherit;display:flex;gap:.45rem;padding:.5rem;text-align:left;width:100%}.file-nav-item:hover,.file-nav-item.active{background:color-mix(in srgb,var(--accent) 14%,transparent)}.file-nav-item>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-nav-item>span:nth-child(3){margin-left:auto}.sidebar-label{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em;margin:.7rem .5rem .25rem;text-transform:uppercase}.reference-files{border-top:1px solid var(--border);margin-top:.7rem;padding-top:.45rem}.reference-files summary{color:var(--muted);cursor:pointer;font-size:11px;font-weight:700;padding:.35rem .5rem}.reference-files[open] summary{margin-bottom:.15rem}.reference-files .file-nav-item{color:var(--muted)}.overview-icon{color:var(--accent);flex:0 0 8px;font-size:9px}.status-dot{border-radius:50%;flex:0 0 8px;height:8px;background:var(--muted)}.status-added,.status-untracked{color:#1a7f37}.status-deleted{color:#cf222e}.status-renamed{color:#8250df}.badge{border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:10px;padding:0 .35rem}.reference-badge{margin-left:.45rem}.review-content{min-width:0;padding:1rem}.review-file[hidden],.review-overview[hidden]{display:none}.overview-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.8rem 1rem}.overview-header h1{font-size:18px;margin:.25rem 0 0}.overview-header>span{color:var(--muted);font-size:12px}.overview-body{border:1px solid var(--border);border-radius:0 0 8px 8px;max-width:760px;padding:1rem 1.2rem}.overview-body section+section{margin-top:1rem}.overview-body h2{font-size:13px;margin:0 0 .35rem}.overview-body p,.overview-body ul{margin:.25rem 0}.overview-body ul{padding-left:1.25rem}.overview-feedback{border-top:1px solid var(--border);color:var(--muted);display:block;font-size:12px;font-weight:600;margin-top:1rem;padding-top:1rem}.file-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.7rem 1rem}.file-header h1{display:inline;font:600 14px ui-monospace,monospace;margin:.5rem}.file-header>span,.old-path{color:var(--muted);font-size:12px}.status{font-size:11px;font-weight:700;text-transform:uppercase}.file-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:1rem}.diff-column{border:1px solid var(--border);border-top:0;min-width:0;overflow:auto}.diff-table{border-collapse:collapse;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;table-layout:auto;width:100%}.diff-table td{border:0;padding:0 .45rem;vertical-align:top}.line-number,.line-marker{color:var(--muted);text-align:right;user-select:none;width:1%;white-space:nowrap}.line-marker{padding-right:.1rem!important}.diff-code{white-space:pre;min-width:100%}.diff-add{background:var(--add)}.diff-add .line-number,.diff-add .line-marker{background:var(--add-gutter)}.diff-del{background:var(--del)}.diff-del .line-number,.diff-del .line-marker{background:var(--del-gutter)}.diff-hunk{background:var(--hunk);color:var(--muted)}.diff-meta{color:var(--muted)}.unselectable{user-select:none}.file-banner{padding:2rem;text-align:center;color:var(--muted)}.file-banner.warning{color:var(--warning)}.commentary-column{border:1px solid var(--border);border-radius:8px;height:max-content;max-height:calc(100vh - 90px);overflow:auto;padding:1rem;position:sticky;top:72px}.commentary-column h2,.commentary-column h3{font-size:14px;margin:0 0 .6rem}.file-summary{background:var(--panel);border-radius:6px;padding:.7rem;white-space:pre-wrap}.agent-note{border-top:1px solid var(--border);margin-top:.8rem;padding-top:.8rem}.agent-note-anchor{background:transparent;border:0;color:var(--accent);cursor:pointer;font-size:11px;font-weight:700;padding:0}.agent-note-anchor:disabled{color:var(--muted);cursor:default}.agent-note-body{margin:.35rem 0;white-space:pre-wrap}.agent-note label{color:var(--muted);font-size:11px}.agent-note textarea,.selection-composer textarea,.thread-card textarea,.overview-feedback textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:inherit;font:13px system-ui,sans-serif;margin-top:.3rem;min-height:60px;padding:.5rem;resize:vertical;width:100%}.user-comments{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.selection-composer{background:var(--panel);border:1px solid var(--accent);border-radius:8px;margin-top:1rem;padding:.7rem}.selection-quote,.user-comment-quote{border-left:3px solid var(--accent);color:var(--muted);font:11px ui-monospace,monospace;margin-bottom:.4rem;max-height:5rem;overflow:auto;padding-left:.5rem;white-space:pre-wrap}.composer-actions{display:flex;gap:.4rem;justify-content:flex-end;margin-top:.4rem}.composer-actions button:first-child{background:transparent;border:1px solid var(--border);color:inherit}::highlight(pi-code-review-feedback){background:#fff1a8;text-decoration:underline 2px #bf8700}.toolbar-actions .inbox-strip{background:color-mix(in srgb,var(--accent) 16%,transparent);border:1px solid var(--accent);border-radius:999px;color:var(--accent);font-weight:700}.thread-card{border:1px solid var(--border);border-radius:8px;margin-top:.65rem;padding:.6rem .7rem}.thread-card.awaiting{border-color:var(--accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent)}.thread-card.resolved{opacity:.62}.thread-card-header{align-items:center;display:flex;gap:.5rem;justify-content:space-between}.thread-status{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.thread-card.awaiting .thread-status{color:var(--accent)}.thread-turn{margin:.45rem 0;white-space:pre-wrap}.thread-turn .turn-author{color:var(--muted);display:block;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.thread-turn.turn-pi .turn-author{color:var(--accent)}.pi-proposes{background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:6px;color:var(--accent);font-size:11px;font-weight:650;margin-top:.4rem;padding:.35rem .5rem}.thread-flash{animation:thread-flash 1.2s ease-out}@keyframes thread-flash{0%{box-shadow:0 0 0 3px var(--accent)}100%{box-shadow:0 0 0 1px transparent}}.unread-badge{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}.thread-tally{color:var(--muted);display:flex;flex-wrap:wrap;gap:.9rem;font-size:12px}.thread-tally strong{color:var(--text)}@media(max-width:900px){.review-shell{grid-template-columns:1fr}.file-sidebar{display:flex;height:auto;overflow:auto;position:static}.file-nav-item{min-width:180px}.file-layout{grid-template-columns:1fr}.commentary-column{max-height:none;position:static}}@media(max-width:600px){.topbar{align-items:flex-start;gap:.5rem}.toolbar-actions span{display:none}.review-content{padding:.5rem}.file-layout{display:block}.commentary-column{margin-top:.75rem}}
`;
