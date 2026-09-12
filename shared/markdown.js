// Minimal sanitizing markdown renderer for review bodies. Security model:
// every character of input is HTML-escaped before any transformation, and the
// output vocabulary is a fixed whitelist (p, br, ul, ol, li, strong, em, code,
// pre, a). Raw HTML never passes through; links allow only http(s) and always
// carry rel="noopener noreferrer". This file is also served verbatim to the
// browser with the export keyword stripped, so it must stay dependency-free
// and syntax-conservative.

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

/** Render untrusted markdown-ish text to whitelisted HTML. */
export function renderMarkdown(source) {
	// Strip the private-use token sentinels so input can never splice into the
	// stash, then escape everything before any structure is recognized.
	const lines = escapeHtml(String(source ?? "").replace(/[\uE000\uE001]/g, "")).split(/\r?\n/);
	const html = [];
	let paragraph = [];
	let list;
	let fence;
	const flushParagraph = () => {
		if (paragraph.length) html.push("<p>" + paragraph.join("<br>") + "</p>");
		paragraph = [];
	};
	const flushList = () => {
		if (list) html.push("<" + list.type + ">" + list.items.map((item) => "<li>" + item + "</li>").join("") + "</" + list.type + ">");
		list = undefined;
	};
	for (const line of lines) {
		if (fence) {
			if (/^\s*```/.test(line)) {
				html.push("<pre><code>" + fence.join("\n") + "</code></pre>");
				fence = undefined;
			} else fence.push(line);
			continue;
		}
		if (/^\s*```/.test(line)) {
			flushParagraph();
			flushList();
			fence = [];
			continue;
		}
		const unordered = /^\s{0,3}[-*]\s+(.*)$/.exec(line);
		const ordered = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/.exec(line);
		if (unordered || ordered) {
			flushParagraph();
			const type = unordered ? "ul" : "ol";
			if (!list || list.type !== type) {
				flushList();
				list = { type, items: [] };
			}
			list.items.push(renderInline((unordered ?? ordered)[1]));
			continue;
		}
		if (!line.trim()) {
			flushParagraph();
			flushList();
			continue;
		}
		flushList();
		paragraph.push(renderInline(line));
	}
	flushParagraph();
	flushList();
	// An unterminated fence still renders as code rather than vanishing.
	if (fence) html.push("<pre><code>" + fence.join("\n") + "</code></pre>");
	return html.join("");
}
