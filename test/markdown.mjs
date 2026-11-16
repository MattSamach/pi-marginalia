import assert from "node:assert/strict";
import { renderMarkdown } from "../shared/markdown.js";

for (const markers of [["1.", "2.", "3."], ["1.", "1.", "1."], ["1)", "2)", "3)"]]) {
	const markdown = markers.map((marker, index) => marker + " **Item " + (index + 1) + ".** Text.").join("\n\n");
	assert.equal(renderMarkdown(markdown), "<ol><li><strong>Item 1.</strong> Text.</li><li><strong>Item 2.</strong> Text.</li><li><strong>Item 3.</strong> Text.</li></ol>", "Blank-separated ordered items share a list, including repeated 1 markers.");
}
assert.equal(
	renderMarkdown("1. first\r\n   wrapped\r\n \r\n\r\n2. second\r\n\r\nAfter.", { sourceLines: true, lineOffset: 10 }),
	'<ol><li data-md-line="11" data-md-end="12">first wrapped</li><li data-md-line="15" data-md-end="15">second</li></ol><p data-md-line="17" data-md-end="17">After.</p>',
	"Whitespace-only blank lines preserve numbering and source ranges without absorbing following prose.",
);
assert.equal(renderMarkdown("- outer\n\n  1. inner one\n\n  2. inner two\n\n- next"), "<ul><li>outer<ol><li>inner one</li><li>inner two</li></ol></li><li>next</li></ul>", "Blank-separated nested items stay attached to the correct parent.");
assert.equal(renderMarkdown("1. first\n\nParagraph.\n\n1. new list"), "<ol><li>first</li></ol><p>Paragraph.</p><ol><li>new list</li></ol>", "Intervening prose separates ordered lists.");
for (const block of ["## Heading", "---", "> Quote", "```\ncode\n```", "| A |\n| - |\n| x |", "             2. not a list"]) {
	const prefix = renderMarkdown("1. first\n\n" + block);
	assert.equal(prefix, "<ol><li>first</li></ol>" + renderMarkdown(block), "A block after a blank line ends the list: " + block);
}

assert.equal(
	renderMarkdown("```ts\r\nx < y\r\n\r\nz\r\n```", { sourceLines: true, lineOffset: 5 }),
	'<pre data-md-line="6" data-md-end="10"><code><span data-md-line="7" data-md-end="7">x &lt; y</span>\n<span data-md-line="8" data-md-end="8"></span>\n<span data-md-line="9" data-md-end="9">z</span></code></pre>',
	"Fenced code retains whitespace and escaping while mapping each content line to its source.",
);
assert.equal(
	renderMarkdown("```\na\nb", { sourceLines: true }),
	'<pre data-md-line="1" data-md-end="3"><code><span data-md-line="2" data-md-end="2">a</span>\n<span data-md-line="3" data-md-end="3">b</span></code></pre>',
	"Unterminated code fences also have per-line anchors.",
);
assert.equal(renderMarkdown("```\nx < y\n```"), "<pre><code>x &lt; y</code></pre>", "Thread code blocks remain plain when source mapping is disabled.");
assert.doesNotMatch(renderMarkdown("```mermaid\nflowchart LR\n  a --> b\n```", { sourceLines: true }), /<span/, "Mermaid source stays intact for diagram rendering.");

console.log("Markdown regressions passed.");
