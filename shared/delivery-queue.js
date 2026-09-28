/**
 * Coalesces review messages for Pi: immediate delivery while idle, one combined
 * batch per settle while Pi is busy, preserving post order.
 *
 * Entries are strings or { key?, payload?, merge?, render } objects. While
 * queued, a keyed entry absorbs later same-key posts through merge(prev, next)
 * so a busy-burst of same-thread turns renders as ONE envelope at flush.
 * Keyless entries (strings, pass and approval messages) are ordering barriers:
 * nothing merges across them, so thread context never migrates past a pass.
 * Rendering happens at delivery time and is idempotent — a failed flush keeps
 * every entry, merged state included, for the next settle.
 */
export function createReviewMessageQueue(deliver) {
	const pending = [];
	const asEntry = (message) => (typeof message === "string" ? { render: () => message } : message);
	return {
		/** Deliver now when idle with nothing queued; otherwise queue (merging into a same-key entry queued since the last barrier). Returns whether the message was queued. */
		post(message, idle) {
			const entry = asEntry(message);
			if (idle && pending.length === 0) {
				deliver([entry.render(entry.payload)]);
				return false;
			}
			if (entry.key !== undefined && entry.merge) {
				for (let index = pending.length - 1; index >= 0; index--) {
					const candidate = pending[index];
					if (candidate.key === undefined) break;
					if (candidate.key === entry.key) {
						candidate.payload = entry.merge(candidate.payload, entry.payload);
						return true;
					}
				}
			}
			pending.push(entry);
			return true;
		},
		/** Deliver every queued message as one batch once idle. Returns how many were delivered. A throwing deliver keeps the batch queued for the next flush. */
		flush(idle) {
			if (!idle || pending.length === 0) return 0;
			deliver(pending.map((entry) => entry.render(entry.payload)));
			const count = pending.length;
			pending.length = 0;
			return count;
		},
		size: () => pending.length,
	};
}
