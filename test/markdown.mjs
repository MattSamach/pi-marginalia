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

console.log("Markdown list regressions passed.");
