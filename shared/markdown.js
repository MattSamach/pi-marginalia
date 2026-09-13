// Minimal sanitizing markdown renderer for review bodies and plan documents.
// Security model: every character of input is HTML-escaped before any
// transformation, and the output vocabulary is a fixed whitelist (p, br, ul,
// ol, li, strong, em, code, pre, a, h1-h6, blockquote, hr, table, thead,
// tbody, tr, th, td). Raw HTML never passes through; links allow only
// http(s) and always carry rel="noopener noreferrer". This file is also
// served verbatim to the browser with the export keyword stripped, so it must
// stay dependency-free and syntax-conservative.

const TOKEN_OPEN = "\uE000";
const TOKEN_CLOSE = "\uE001";

function escapeHtml(value) {
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function emphasis(text) {
	return text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

// Input arrives escaped. Code spans are tokenized first so their contents are
// never emphasized or linkified; whole anchors are tokenized so hrefs are
// never re-processed. Only http(s) URLs become links; anything else stays text.
function renderInline(text) {
	const tokens = [];
	const stash = (html) => {
		tokens.push(html);
		return TOKEN_OPEN + (tokens.length - 1) + TOKEN_CLOSE;
	};
	// The URL class also rejects token sentinels so a code span tokenized inside
	// a URL breaks the anchor match instead of expanding markup into the href.
	let work = text.replace(/`([^`]+)`/g, (_match, code) => stash("<code>" + code + "</code>"));
	work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)\uE000\uE001]+)\)/g, (_match, label, href) => stash('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + emphasis(label) + "</a>"));
	work = emphasis(work);
	// A stashed anchor can carry earlier code-span markers in its label, so
	// reinsertion loops; indices only ever reference earlier tokens, and the
	// depth bound plus final strip guarantee no sentinel ever reaches output.
	const marker = new RegExp(TOKEN_OPEN + "(\\d+)" + TOKEN_CLOSE, "g");
	for (let depth = 0; depth < 4 && work.includes(TOKEN_OPEN); depth++) {
		work = work.replace(marker, (_match, index) => tokens[Number(index)] ?? "");
	}
	return work.replace(/[\uE000\uE001]/g, "");
}

// Table rows are pipe-delimited cells; outer pipes are optional.
function splitTableRow(line) {
	let work = line.trim();
	if (work.startsWith("|")) work = work.slice(1);
	if (work.endsWith("|")) work = work.slice(0, -1);
	return work.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line) {
	return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

/**
 * Render untrusted markdown-ish text to whitelisted HTML.
 * options.sourceLines adds data-md-line / data-md-end (1-based source line
 * ranges) to block elements so rendered blocks can anchor back to the source;
 * options.lineOffset shifts the emitted numbers when the source is a slice of
 * a larger document.
 */
export function renderMarkdown(source, options) {
	const sourceLines = Boolean(options && options.sourceLines);
	const lineOffset = (options && Number(options.lineOffset)) || 0;
	// Strip the private-use token sentinels so input can never splice into the
	// stash, then escape everything before any structure is recognized.
	const lines = escapeHtml(String(source ?? "").replace(/[\uE000\uE001]/g, "")).split(/\r?\n/);
	const html = [];
	const blockAttrs = (start, end) => (sourceLines ? ' data-md-line="' + (lineOffset + start) + '" data-md-end="' + (lineOffset + (end ?? start)) + '"' : "");
	let paragraph = [];
	let paragraphStart = 0;
	// Lists nest: a stack of open lists, each item able to hold child lists.
	let listStack = [];
	let fence;
	let fenceStart = 0;
	const flushParagraph = (endLine) => {
		if (paragraph.length) html.push("<p" + blockAttrs(paragraphStart, endLine) + ">" + paragraph.join("<br>") + "</p>");
		paragraph = [];
	};
	const renderList = (node) => "<" + node.type + ">" + node.items.map((item) => "<li" + blockAttrs(item.line, item.endLine) + ">" + item.content + item.children.map(renderList).join("") + "</li>").join("") + "</" + node.type + ">";
	const flushList = () => {
		if (listStack.length) html.push(renderList(listStack[0]));
		listStack = [];
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const lineNumber = index + 1;
		if (fence) {
			if (/^\s*```/.test(line)) {
				html.push("<pre" + blockAttrs(fenceStart, lineNumber) + "><code>" + fence.join("\n") + "</code></pre>");
				fence = undefined;
			} else fence.push(line);
			continue;
		}
		if (/^\s*```/.test(line)) {
			flushParagraph(lineNumber - 1);
			flushList();
			fence = [];
			fenceStart = lineNumber;
			continue;
		}
		// Thematic break — checked before lists so "- - -" is a rule, not an item.
		if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
			flushParagraph(lineNumber - 1);
			flushList();
			html.push("<hr" + blockAttrs(lineNumber, lineNumber) + ">");
			continue;
		}
		const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph(lineNumber - 1);
			flushList();
			const level = heading[1].length;
			html.push("<h" + level + blockAttrs(lineNumber, lineNumber) + ">" + renderInline(heading[2].trim()) + "</h" + level + ">");
			continue;
		}
		// Blockquotes match the ESCAPED marker: ">" became "&gt;" before parsing.
		if (/^\s{0,3}&gt;/.test(line)) {
			flushParagraph(lineNumber - 1);
			flushList();
			const quoteStart = lineNumber;
			const inner = [];
			while (index < lines.length && /^\s{0,3}&gt;/.test(lines[index])) {
				inner.push(lines[index].replace(/^\s{0,3}&gt;\s?/, ""));
				index++;
			}
			index--;
			const quoteParagraphs = [];
			let currentQuote = [];
			for (const innerLine of inner) {
				if (!innerLine.trim()) {
					if (currentQuote.length) quoteParagraphs.push(currentQuote);
					currentQuote = [];
				} else currentQuote.push(renderInline(innerLine));
			}
			if (currentQuote.length) quoteParagraphs.push(currentQuote);
			html.push("<blockquote" + blockAttrs(quoteStart, quoteStart + inner.length - 1) + ">" + quoteParagraphs.map((part) => "<p>" + part.join("<br>") + "</p>").join("") + "</blockquote>");
			continue;
		}
		// Tables need lookahead: a pipe-bearing row directly above a separator
		// whose column count matches — otherwise prose with pipes above a rule
		// would be swallowed into a table.
		if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]) && !isTableSeparator(line) && splitTableRow(lines[index + 1]).length === splitTableRow(line).length) {
			flushParagraph(lineNumber - 1);
			flushList();
			const tableStart = lineNumber;
			const headerCells = splitTableRow(line);
			const bodyRows = [];
			index += 2;
			while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
				bodyRows.push(splitTableRow(lines[index]));
				index++;
			}
			index--;
			const head = "<thead><tr>" + headerCells.map((cell) => "<th>" + renderInline(cell) + "</th>").join("") + "</tr></thead>";
			const body = bodyRows.length
				? "<tbody>" + bodyRows.map((row) => "<tr>" + row.map((cell) => "<td>" + renderInline(cell) + "</td>").join("") + "</tr>").join("") + "</tbody>"
				: "";
			html.push("<table" + blockAttrs(tableStart, tableStart + 1 + bodyRows.length) + ">" + head + body + "</table>");
			continue;
		}
		const listItem = /^(\s*)([-*]|\d{1,3}[.)])\s+(.*)$/.exec(line);
		if (listItem && listItem[1].length <= 12) {
			flushParagraph(lineNumber - 1);
			const type = /[-*]/.test(listItem[2]) ? "ul" : "ol";
			const indent = listItem[1].length;
			// Close deeper levels; a step of 2+ spaces past the open list nests.
			while (listStack.length > 1 && indent < listStack[listStack.length - 1].indent) listStack.pop();
			let target = listStack[listStack.length - 1];
			if (!target) {
				target = { type, indent, items: [] };
				listStack.push(target);
			} else if (indent >= target.indent + 2 && target.items.length) {
				const child = { type, indent, items: [] };
				target.items[target.items.length - 1].children.push(child);
				listStack.push(child);
				target = child;
			} else if (target.type !== type) {
				// A sibling list of the other type replaces the current level.
				if (listStack.length === 1) {
					flushList();
					target = { type, indent, items: [] };
					listStack.push(target);
				} else {
					listStack.pop();
					const parent = listStack[listStack.length - 1];
					const child = { type, indent, items: [] };
					parent.items[parent.items.length - 1].children.push(child);
					listStack.push(child);
					target = child;
				}
			}
			target.items.push({ content: renderInline(listItem[3]), children: [], line: lineNumber, endLine: lineNumber });
			continue;
		}
		if (!line.trim()) {
			flushParagraph(lineNumber - 1);
			flushList();
			continue;
		}
		flushList();
		if (!paragraph.length) paragraphStart = lineNumber;
		paragraph.push(renderInline(line));
	}
	flushParagraph(lines.length);
	flushList();
	// An unterminated fence still renders as code rather than vanishing.
	if (fence) html.push("<pre" + blockAttrs(fenceStart, lines.length) + "><code>" + fence.join("\n") + "</code></pre>");
	return html.join("");
}
