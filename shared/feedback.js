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
	if (thread.carried !== undefined) values.push(`carried-from-round="${Number(thread.carried.fromRound)}"`, `resolution="${attr(thread.carried.resolution)}"`);
	return values.join(" ");
}

function roundAttribute(round) {
	return round === undefined ? "" : ` round="${Number(round)}"`;
}

/** Format one reviewer thread post (or an escalated backlog of turns) as the user message delivered to Pi. */
export function formatThreadMessageXml(review, thread, turns, round) {
	const lines = [`<code-review-thread snapshot="${attr(review.id)}"${roundAttribute(round)} ${threadAttributes(thread)}${anchorAttributes(thread)}>`];
	if (thread.highlight !== undefined) lines.push(`  <highlight>${cdata(thread.highlight)}</highlight>`);
	for (const turn of Array.isArray(turns) ? turns : [turns]) {
		lines.push(`  <message author="${attr(turn.author)}">${cdata(turn.body)}</message>`);
	}
	lines.push("</code-review-thread>");
	return lines.join("\n");
}

/** Format the finish-pass summary delivered to Pi when the reviewer completes a pass. */
export function formatReviewPassXml(review, threads, summary, stale, note, round) {
	const unreadNotes = threads.filter((thread) => thread.status === "open" && !thread.turns.some((turn) => turn.author === "user")).length;
	const queued = threads.filter((thread) => thread.status === "open" && thread.queued === true).length;
	const lines = [
		`<code-review-pass snapshot="${attr(review.id)}"${roundAttribute(round)} stale="${stale ? "true" : "false"}" open="${summary.open}" awaiting-user="${summary.awaitingUser}" awaiting-pi="${summary.awaitingPi - queued}" resolved="${summary.resolved}" unread-notes="${unreadNotes}" queued="${queued}">`,
	];
	if (note) lines.push(`  <note>${cdata(note)}</note>`);
	for (const thread of threads) {
		if (thread.status !== "open") continue;
		if (!thread.turns.some((turn) => turn.author === "user")) continue;
		const last = thread.turns[thread.turns.length - 1];
		if (thread.queued === true) {
			// Quiet threads were never delivered individually; the pass carries their
			// full reviewer content instead of only the newest message.
			lines.push(`  <open-thread ${threadAttributes(thread)} queued="true" last-author="${attr(last?.author ?? "user")}">`);
			if (thread.highlight !== undefined) lines.push(`    <highlight>${cdata(thread.highlight)}</highlight>`);
			for (const turn of thread.turns) {
				if (turn.author !== "user") continue;
				lines.push(`    <message author="user">${cdata(turn.body)}</message>`);
			}
		} else {
			lines.push(`  <open-thread ${threadAttributes(thread)} last-author="${attr(last?.author ?? "user")}">`);
			if (last) lines.push(`    <last-message>${cdata(last.body)}</last-message>`);
		}
		lines.push("  </open-thread>");
	}
	lines.push("</code-review-pass>");
	return lines.join("\n");
}
