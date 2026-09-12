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
	// Carried threads anchor where Pi re-declared them in the current snapshot.
	if (thread.carried !== undefined && thread.carried.startLine !== undefined) {
		return ` side="${attr(thread.carried.side)}" start-line="${thread.carried.startLine}" end-line="${thread.carried.endLine}"`;
	}
	const values = [];
	if (thread.side !== undefined) values.push(`side="${attr(thread.side)}"`);
	if (thread.startLine !== undefined) values.push(`start-line="${thread.startLine}"`, `end-line="${thread.endLine}"`);
	if (thread.oldStart !== undefined) values.push(`old-start="${thread.oldStart}"`, `old-end="${thread.oldEnd}"`);
	if (thread.newStart !== undefined) values.push(`new-start="${thread.newStart}"`, `new-end="${thread.newEnd}"`);
	// A held thread's anchor is written in its origin round's coordinates: the
	// lines still exist positionally in the current snapshot, but code may have
	// shifted onto them. Mark the coordinate system so the numbers never claim
	// the current snapshot's authority.
	if (values.length && thread.heldFrom !== undefined) values.push(`anchor-from-round="${Number(thread.heldFrom)}"`);
	return values.length ? ` ${values.join(" ")}` : "";
}

function deliveredUserTurns(thread) {
	return thread.turns.filter((turn) => turn.author === "user" && turn.delivered === true).length;
}

/**
 * deliveredOverride lets the pass report the count as of this transmission:
 * the pass itself delivers queued/pending messages, so their block counts them.
 */
function threadAttributes(thread, deliveredOverride) {
	const values = [`thread="${attr(thread.id)}"`, `kind="${attr(thread.source)}"`, `status="${attr(thread.status)}"`];
	if (thread.file !== undefined) values.push(`file="${attr(thread.file)}"`);
	if (thread.commentaryId !== undefined) values.push(`commentary-id="${attr(thread.commentaryId)}"`);
	if (thread.carried !== undefined) values.push(`carried-from-round="${Number(thread.carried.fromRound)}"`, `resolution="${attr(thread.carried.resolution)}"`);
	if (thread.heldFrom !== undefined) values.push(`held-from-round="${Number(thread.heldFrom)}"`);
	values.push(`delivered-user-turns="${deliveredOverride ?? deliveredUserTurns(thread)}"`);
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
		lines.push(`  <message author="${attr(turn.author)}"${turn.seq === undefined ? "" : ` turn="${turn.seq}"`}>${cdata(turn.body)}</message>`);
	}
	lines.push("</code-review-thread>");
	return lines.join("\n");
}

/**
 * Full unified context of one thread, for on-demand recovery (the get tool).
 * lastTurns returns only the newest N messages; omitted-turns reports the cut.
 */
export function formatThreadContextXml(review, thread, round, lastTurns) {
	const turns = thread.turns;
	const shown = Number.isInteger(lastTurns) && lastTurns > 0 && lastTurns < turns.length ? turns.slice(turns.length - lastTurns) : turns;
	const omitted = turns.length - shown.length;
	const lines = [`<review-thread snapshot="${attr(review.id)}"${roundAttribute(round)} ${threadAttributes(thread)}${anchorAttributes(thread)} pending="${thread.pending ?? 0}"${omitted > 0 ? ` omitted-turns="${omitted}"` : ""}>`];
	if (thread.highlight !== undefined) lines.push(`  <highlight>${cdata(thread.highlight)}</highlight>`);
	for (const turn of shown) {
		lines.push(`  <message author="${attr(turn.author)}"${turn.seq === undefined ? "" : ` turn="${turn.seq}"`}${turn.author === "user" && turn.delivered === false ? " pending=\"true\"" : ""}>${cdata(turn.body)}</message>`);
	}
	lines.push("</review-thread>");
	return lines.join("\n");
}

/** Format the finish-pass summary delivered to Pi when the reviewer completes a pass. */
/** Format the terminal approval message: the reviewer signed off with a final commit message. */
export function formatReviewApprovedXml(review, round, message, stale) {
	return [
		`<code-review-approved snapshot="${attr(review.id)}"${roundAttribute(round)}${stale ? ' stale="true"' : ""}>`,
		`  <commit-message>${cdata(message)}</commit-message>`,
		"  <note>The reviewer approved this review unit with the commit message above. The review session is closed — no further rounds or thread replies. Follow the commit policy that governs this session; where the reviewer's approval satisfies it, use this commit message.</note>",
		"</code-review-approved>",
	].join("\n");
}

export function formatReviewPassXml(review, threads, summary, stale, note, round) {
	const unreadNotes = threads.filter((thread) => thread.status === "open" && !thread.turns.some((turn) => turn.author === "user")).length;
	const queued = threads.filter((thread) => thread.status === "open" && thread.queued === true).length;
	// Pending: undelivered messages on threads Pi already knows (queued threads
	// carry their whole content separately). Threads whose newest message is
	// pending are not "awaiting Pi" — Pi has not seen the ask yet.
	const pendingThreads = threads.filter((thread) => thread.status === "open" && thread.queued !== true && (thread.pending ?? 0) > 0);
	const pending = pendingThreads.reduce((count, thread) => count + thread.pending, 0);
	const pendingAwaiting = pendingThreads.filter((thread) => thread.turns[thread.turns.length - 1]?.author === "user").length;
	const lines = [
		`<code-review-pass snapshot="${attr(review.id)}"${roundAttribute(round)} stale="${stale ? "true" : "false"}" open="${summary.open}" awaiting-user="${summary.awaitingUser}" awaiting-pi="${summary.awaitingPi - queued - pendingAwaiting}" resolved="${summary.resolved}" unread-notes="${unreadNotes}" queued="${queued}" pending="${pending}">`,
	];
	if (note) lines.push(`  <note>${cdata(note)}</note>`);
	for (const thread of threads) {
		if (thread.status !== "open") continue;
		if (!thread.turns.some((turn) => turn.author === "user")) continue;
		const last = thread.turns[thread.turns.length - 1];
		if (thread.queued === true) {
			// Quiet threads were never delivered individually; the pass carries their
			// full reviewer content instead of only the newest message. The counter
			// reports the state after this pass delivers them.
			const userTurns = thread.turns.filter((turn) => turn.author === "user");
			lines.push(`  <open-thread ${threadAttributes(thread, deliveredUserTurns(thread) + thread.pending)}${anchorAttributes(thread)} queued="true" last-author="${attr(last?.author ?? "user")}">`);
			if (thread.highlight !== undefined) lines.push(`    <highlight>${cdata(thread.highlight)}</highlight>`);
			for (const turn of userTurns) {
				lines.push(`    <message author="user"${turn.seq === undefined ? "" : ` turn="${turn.seq}"`}>${cdata(turn.body)}</message>`);
			}
		} else if ((thread.pending ?? 0) > 0) {
			// Pi knows this thread but has not seen its pending tail; the pass
			// delivers exactly the new messages.
			lines.push(`  <open-thread ${threadAttributes(thread, deliveredUserTurns(thread) + thread.pending)}${anchorAttributes(thread)} pending="${thread.pending}" last-author="${attr(last?.author ?? "user")}">`);
			for (const turn of thread.turns) {
				if (turn.author !== "user" || turn.delivered !== false) continue;
				lines.push(`    <message author="user" pending="true"${turn.seq === undefined ? "" : ` turn="${turn.seq}"`}>${cdata(turn.body)}</message>`);
			}
		} else {
			lines.push(`  <open-thread ${threadAttributes(thread)}${anchorAttributes(thread)} last-author="${attr(last?.author ?? "user")}">`);
			if (last) lines.push(`    <last-message${last.seq === undefined ? "" : ` turn="${last.seq}"`}>${cdata(last.body)}</last-message>`);
		}
		lines.push("  </open-thread>");
	}
	lines.push("</code-review-pass>");
	return lines.join("\n");
}
