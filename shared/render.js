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

function renderCommentary(file) {
	const cards = file.commentary.map((entry) => `<article class="agent-note" data-commentary-id="${attribute(entry.id)}" data-anchor-side="${attribute(entry.side)}"${entry.startLine === undefined ? "" : ` data-anchor-start="${entry.startLine}"`}>
  <button type="button" class="agent-note-anchor"${entry.startLine === undefined ? " disabled" : ""}>${text(rangeLabel(entry))}</button>
  <div class="agent-note-body">${text(entry.body)}</div>
  <label>Reply to Pi<textarea data-commentary-reply="${attribute(entry.id)}" maxlength="20000" placeholder="Respond to this explanation"></textarea></label>
</article>`).join("\n");
	return `<aside class="commentary-column" aria-label="Pi commentary for ${attribute(file.path)}">
  <h2>Pi commentary</h2>
  <div class="file-summary">${file.summary ? text(file.summary) : "No file-level commentary supplied."}</div>
  ${cards || '<p class="empty-note">No anchored commentary for this file.</p>'}
  <section class="user-comments"><h3>Your diff comments</h3><div data-user-comments></div></section>
  <section class="selection-composer" data-selection-composer hidden>
    <div class="selection-quote" data-selection-quote></div>
    <textarea data-selection-feedback maxlength="20000" placeholder="Comment on this selection"></textarea>
    <div class="composer-actions"><button type="button" data-selection-cancel>Cancel</button><button type="button" data-selection-add title="Add comment (Command or Ctrl+Enter)" disabled>Add comment</button></div>
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
	return `<section class="review-file${index === 0 ? " active" : ""}" data-review-file="${index}" data-path="${attribute(file.path)}"${index === 0 ? "" : " hidden"}>
  <header class="file-header"><div><span class="status status-${attribute(file.status)}">${text(file.status)}</span><h1>${text(file.path)}</h1>${rename}</div><span>${index + 1} / ${file.reviewCount}</span></header>
  <div class="file-layout"><main class="diff-column">${body}</main>${renderCommentary(file)}</div>
</section>`;
}

export function renderReviewHtml(review, nonce) {
	const files = review.files.map((file) => ({ ...file, reviewCount: review.files.length }));
	const nav = files.map((file, index) => `<button type="button" class="file-nav-item${index === 0 ? " active" : ""}" data-file-nav="${index}" title="${attribute(file.path)}"><span class="status-dot status-${attribute(file.status)}"></span><span>${text(file.path)}</span>${file.binary ? '<span class="badge">binary</span>' : file.omitted ? '<span class="badge">omitted</span>' : file.truncated ? '<span class="badge">truncated</span>' : ""}</button>`).join("\n");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(review.title)}</title><link rel="icon" href="data:,"><style>${STYLE}</style></head>
<body><header class="topbar"><div><strong>${text(review.title)}</strong><span class="snapshot" title="${attribute(review.id)}">snapshot ${text(review.id.slice(0, 12))}</span></div><div class="toolbar-actions"><span data-global-status>Select changed code or reply to Pi.</span><button type="button" data-submit disabled>Submit feedback</button></div></header>
<div class="review-shell"><nav class="file-sidebar" aria-label="Changed files">${nav}</nav><div class="review-content" id="review-root">${files.map(renderFile).join("\n")}</div></div>
<script nonce="${attribute(nonce)}">${CLIENT_SOURCE}</script></body></html>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--panel:#f6f8fa;--border:#d0d7de;--text:#1f2328;--muted:#59636e;--add:#dafbe1;--add-gutter:#aceebb;--del:#ffebe9;--del-gutter:#ffcecb;--hunk:#ddf4ff;--accent:#0969da;--warning:#9a6700} @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--add:#12261e;--add-gutter:#1f4a31;--del:#2d1517;--del-gutter:#5d2025;--hunk:#132b3a;--accent:#58a6ff;--warning:#d29922}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}.topbar{align-items:center;background:var(--panel);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;min-height:56px;padding:.65rem 1rem;position:sticky;top:0;z-index:20}.snapshot{color:var(--muted);font:12px ui-monospace,monospace;margin-left:.75rem}.toolbar-actions{align-items:center;display:flex;gap:.8rem}.toolbar-actions span{color:var(--muted);font-size:12px}.toolbar-actions button,.composer-actions button{background:var(--accent);border:0;border-radius:6px;color:white;font-weight:650;padding:.5rem .8rem}.toolbar-actions button:disabled,.composer-actions button:disabled{opacity:.45}.review-shell{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:calc(100vh - 56px)}.file-sidebar{background:var(--panel);border-right:1px solid var(--border);height:calc(100vh - 56px);overflow:auto;padding:.5rem;position:sticky;top:56px}.file-nav-item{align-items:center;background:transparent;border:0;border-radius:6px;color:inherit;display:flex;gap:.45rem;padding:.5rem;text-align:left;width:100%}.file-nav-item:hover,.file-nav-item.active{background:color-mix(in srgb,var(--accent) 14%,transparent)}.file-nav-item>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status-dot{border-radius:50%;flex:0 0 8px;height:8px;background:var(--muted)}.status-added,.status-untracked{color:#1a7f37}.status-deleted{color:#cf222e}.status-renamed{color:#8250df}.badge{border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:10px;margin-left:auto;padding:0 .35rem}.review-content{min-width:0;padding:1rem}.review-file[hidden]{display:none}.file-header{align-items:end;border:1px solid var(--border);border-radius:8px 8px 0 0;display:flex;justify-content:space-between;padding:.7rem 1rem}.file-header h1{display:inline;font:600 14px ui-monospace,monospace;margin:.5rem}.file-header>span,.old-path{color:var(--muted);font-size:12px}.status{font-size:11px;font-weight:700;text-transform:uppercase}.file-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:1rem}.diff-column{border:1px solid var(--border);border-top:0;min-width:0;overflow:auto}.diff-table{border-collapse:collapse;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;table-layout:auto;width:100%}.diff-table td{border:0;padding:0 .45rem;vertical-align:top}.line-number,.line-marker{color:var(--muted);text-align:right;user-select:none;width:1%;white-space:nowrap}.line-marker{padding-right:.1rem!important}.diff-code{white-space:pre;min-width:100%}.diff-add{background:var(--add)}.diff-add .line-number,.diff-add .line-marker{background:var(--add-gutter)}.diff-del{background:var(--del)}.diff-del .line-number,.diff-del .line-marker{background:var(--del-gutter)}.diff-hunk{background:var(--hunk);color:var(--muted)}.diff-meta{color:var(--muted)}.unselectable{user-select:none}.file-banner{padding:2rem;text-align:center;color:var(--muted)}.file-banner.warning{color:var(--warning)}.commentary-column{border:1px solid var(--border);border-radius:8px;height:max-content;max-height:calc(100vh - 90px);overflow:auto;padding:1rem;position:sticky;top:72px}.commentary-column h2,.commentary-column h3{font-size:14px;margin:0 0 .6rem}.file-summary{background:var(--panel);border-radius:6px;padding:.7rem;white-space:pre-wrap}.agent-note{border-top:1px solid var(--border);margin-top:.8rem;padding-top:.8rem}.agent-note-anchor{background:transparent;border:0;color:var(--accent);cursor:pointer;font-size:11px;font-weight:700;padding:0}.agent-note-anchor:disabled{color:var(--muted);cursor:default}.agent-note-body{margin:.35rem 0;white-space:pre-wrap}.agent-note label{color:var(--muted);font-size:11px}.agent-note textarea,.selection-composer textarea,.user-comment textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:inherit;font:13px system-ui,sans-serif;margin-top:.3rem;min-height:60px;padding:.5rem;resize:vertical;width:100%}.user-comments{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.selection-composer{background:var(--panel);border:1px solid var(--accent);border-radius:8px;margin-top:1rem;padding:.7rem}.selection-quote,.user-comment-quote{border-left:3px solid var(--accent);color:var(--muted);font:11px ui-monospace,monospace;margin-bottom:.4rem;max-height:5rem;overflow:auto;padding-left:.5rem;white-space:pre-wrap}.composer-actions{display:flex;gap:.4rem;justify-content:flex-end;margin-top:.4rem}.composer-actions button:first-child{background:transparent;border:1px solid var(--border);color:inherit}.user-comment{border-top:1px solid var(--border);padding:.65rem 0}::highlight(pi-code-review-feedback){background:#fff1a8;text-decoration:underline 2px #bf8700}.submitted textarea{opacity:.65;pointer-events:none}.submitted button[data-submit],.submitted .composer-actions{display:none}@media(max-width:900px){.review-shell{grid-template-columns:1fr}.file-sidebar{display:flex;height:auto;overflow:auto;position:static}.file-nav-item{min-width:180px}.file-layout{grid-template-columns:1fr}.commentary-column{max-height:none;position:static}}@media(max-width:600px){.topbar{align-items:flex-start;gap:.5rem}.toolbar-actions span{display:none}.review-content{padding:.5rem}.file-layout{display:block}.commentary-column{margin-top:.75rem}}
`;
