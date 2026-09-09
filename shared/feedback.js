function cleanXml(value) {
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "\uFFFD");
}

function cdata(value) {
	return `<![CDATA[${cleanXml(value).replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function attr(value) {
	return cleanXml(String(value)).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function anchorAttributes(thread) {
	const values = [];
	if (thread.side !== undefined) values.push(`side="${attr(thread.side)}"`);
	if (thread.oldStart !== undefined) values.push(`old-start="${thread.oldStart}"`, `old-end="${thread.oldEnd}"`);
	if (thread.newStart !== undefined) values.push(`new-start="${thread.newStart}"`, `new-end="${thread.newEnd}"`);
	return values.length ? ` ${values.join(" ")}` : "";
}

function threadAttributes(thread) {
	const values = [`thread="${attr(thread.id)}"`, `kind="${attr(thread.source)}"`, `status="${attr(thread.status)}"`];
	if (thread.file !== undefined) values.push(`file="${attr(thread.file)}"`);
	if (thread.commentaryId !== undefined) values.push(`commentary-id="${attr(thread.commentaryId)}"`);
	return values.join(" ");
}

/** Format one reviewer thread post as the user message delivered to Pi. */
export function formatThreadMessageXml(review, thread, turn) {
	const lines = [`<code-review-thread snapshot="${attr(review.id)}" ${threadAttributes(thread)}${anchorAttributes(thread)}>`];
	if (thread.highlight !== undefined) lines.push(`  <highlight>${cdata(thread.highlight)}</highlight>`);
	lines.push(`  <message author="${attr(turn.author)}">${cdata(turn.body)}</message>`);
	lines.push("</code-review-thread>");
	return lines.join("\n");
}

/** Format the finish-pass summary delivered to Pi when the reviewer completes a pass. */
export function formatReviewPassXml(review, threads, summary, stale, note) {
	const lines = [
		`<code-review-pass snapshot="${attr(review.id)}" stale="${stale ? "true" : "false"}" open="${summary.open}" awaiting-user="${summary.awaitingUser}" awaiting-pi="${summary.awaitingPi}" resolved="${summary.resolved}">`,
	];
	if (note) lines.push(`  <note>${cdata(note)}</note>`);
	for (const thread of threads) {
		if (thread.status !== "open") continue;
		const last = thread.turns[thread.turns.length - 1];
		lines.push(`  <open-thread ${threadAttributes(thread)} last-author="${attr(last?.author ?? "user")}">`);
		if (last) lines.push(`    <last-message>${cdata(last.body)}</last-message>`);
		lines.push("  </open-thread>");
	}
	lines.push("</code-review-pass>");
	return lines.join("\n");
}
