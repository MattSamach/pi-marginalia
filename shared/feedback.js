export const FEEDBACK_LIMITS = Object.freeze({
	maxBodyBytes: 256 * 1024,
	maxComments: 100,
	maxReplies: 100,
	maxFieldLength: 20_000,
});

function cleanXml(value) {
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "\uFFFD");
}

function cdata(value) {
	return `<![CDATA[${cleanXml(value).replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function attr(value) {
	return cleanXml(String(value)).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineAttributes(anchor) {
	const values = [];
	if (anchor.oldStart !== undefined) values.push(`old-start="${anchor.oldStart}"`, `old-end="${anchor.oldEnd}"`);
	if (anchor.newStart !== undefined) values.push(`new-start="${anchor.newStart}"`, `new-end="${anchor.newEnd}"`);
	return values.length ? ` ${values.join(" ")}` : "";
}

export function formatCodeReviewFeedbackXml(snapshotId, stale, feedback) {
	const entries = [];
	for (const comment of feedback.comments) {
		entries.push([
			`  <comment file="${attr(comment.file)}" side="${attr(comment.side)}"${lineAttributes(comment)}>`,
			`    <highlight>${cdata(comment.highlight)}</highlight>`,
			`    <feedback>${cdata(comment.feedback)}</feedback>`,
			"  </comment>",
		].join("\n"));
	}
	for (const reply of feedback.replies) {
		entries.push([
			`  <reply file="${attr(reply.file)}" commentary-id="${attr(reply.commentaryId)}">`,
			`    <feedback>${cdata(reply.feedback)}</feedback>`,
			"  </reply>",
		].join("\n"));
	}
	return [`<code-review-feedback snapshot="${attr(snapshotId)}" stale="${stale ? "true" : "false"}">`, ...entries, "</code-review-feedback>"].join("\n");
}

function validText(value) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= FEEDBACK_LIMITS.maxFieldLength;
}

function validRange(start, end) {
	return start === undefined && end === undefined || Number.isInteger(start) && start > 0 && Number.isInteger(end) && end >= start;
}

/** Validate browser input against the frozen review, returning a normalized payload. */
export function parseCodeReviewFeedback(value, review) {
	if (!value || typeof value !== "object" || !Array.isArray(value.comments) || !Array.isArray(value.replies)) return undefined;
	if (value.comments.length > FEEDBACK_LIMITS.maxComments || value.replies.length > FEEDBACK_LIMITS.maxReplies) return undefined;
	if (value.comments.length + value.replies.length < 1) return undefined;
	const files = new Map(review.files.map((file) => [file.path, file]));
	const comments = [];
	for (const item of value.comments) {
		if (!item || typeof item !== "object" || !validText(item.file) || !validText(item.highlight) || !validText(item.feedback)) return undefined;
		const file = files.get(item.file);
		if (!file || file.binary || file.omitted || !["old", "new", "both"].includes(item.side)) return undefined;
		if (!validRange(item.oldStart, item.oldEnd) || !validRange(item.newStart, item.newEnd)) return undefined;
		if (item.oldStart === undefined && item.newStart === undefined) return undefined;
		if (item.side === "old" && (item.oldStart === undefined || item.newStart !== undefined)) return undefined;
		if (item.side === "new" && (item.newStart === undefined || item.oldStart !== undefined)) return undefined;
		const visibleRange = (key, start, end) => start === undefined || [start, end].every((boundary) => file.lines.some((line) => line[key] === boundary));
		if (!visibleRange("oldLine", item.oldStart, item.oldEnd) || !visibleRange("newLine", item.newStart, item.newEnd)) return undefined;
		comments.push({
			file: item.file,
			side: item.side,
			...(item.oldStart === undefined ? {} : { oldStart: item.oldStart, oldEnd: item.oldEnd }),
			...(item.newStart === undefined ? {} : { newStart: item.newStart, newEnd: item.newEnd }),
			highlight: item.highlight.trim(),
			feedback: item.feedback.trim(),
		});
	}
	const replies = [];
	const seenReplies = new Set();
	for (const item of value.replies) {
		if (!item || typeof item !== "object" || !validText(item.file) || !validText(item.commentaryId) || !validText(item.feedback)) return undefined;
		const file = files.get(item.file);
		if (!file?.commentary.some((entry) => entry.id === item.commentaryId)) return undefined;
		const key = `${item.file}\0${item.commentaryId}`;
		if (seenReplies.has(key)) return undefined;
		seenReplies.add(key);
		replies.push({ file: item.file, commentaryId: item.commentaryId, feedback: item.feedback.trim() });
	}
	return { comments, replies };
}
