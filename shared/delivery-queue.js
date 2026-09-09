/**
 * Coalesces review messages for Pi: immediate delivery while idle, one combined
 * batch per settle while Pi is busy, preserving post order.
 */
export function createReviewMessageQueue(deliver) {
	const pending = [];
	return {
		/** Deliver now when idle with nothing queued; otherwise queue. Returns whether the message was queued. */
		post(message, idle) {
			if (idle && pending.length === 0) {
				deliver([message]);
				return false;
			}
			pending.push(message);
			return true;
		},
		/** Deliver every queued message as one batch once idle. Returns how many were delivered. A throwing deliver keeps the batch queued for the next flush. */
		flush(idle) {
			if (!idle || pending.length === 0) return 0;
			const batch = pending.slice();
			deliver(batch);
			pending.length = 0;
			return batch.length;
		},
		size: () => pending.length,
	};
}
