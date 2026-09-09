---
name: guided-code-review
description: Open a Pi-led browser review of the current uncommitted Git changes. Use when the user asks to review, walk through, or explain the agent's current code changes interactively.
---

# Guided code review

Use `open_code_review` to present the current changes in the order that makes them fastest to understand.

## Commit-sized review units

Treat one browser review as one logical commit candidate: a cohesive behavior change plus the tests, documentation, and supporting refactors required to leave the repository valid. Review foundational units before code that depends on them. Do not split purely by file count, and do not combine unrelated changes merely because they were implemented together.

The complete worktree snapshot is reviewed, so it must represent only that logical unit. If it mixes multiple units or unrelated user changes, stop and agree on a safe split before reviewing; never silently stash, revert, commit, or absorb changes that are not part of the unit.

## Workflow

1. Inspect the complete staged, unstaged, and untracked change set against `HEAD`.
2. Confirm the snapshot is one coherent, independently valid commit unit. If not, split it safely before opening the review.
3. Run meaningful validation for that unit.
4. Choose a logical file order based on behavior and dependencies, not lexical path order.
5. Classify only genuinely low-value review artifacts as reference files using the rules below.
6. Write the review overview and concise file guidance.
7. Call `open_code_review` once with every changed file. The tool appends omitted changed files, but explicitly ordering and classifying all files produces the clearest walkthrough.
8. Answer live comment threads promptly while the reviewer works, following the live-thread rules below.
9. When the `code-review-pass` message arrives, address the open threads and actionable feedback, validate again, and open the next round with `previousRoundId` set to that pass's `snapshot` id. Repeat until the unit is explicitly approved.
10. Follow the approval and commit loop below, then continue to the next already-authorized implementation unit when one remains.

## Overview

The overview is an **EXTREMELY concise, pre-PR introduction** to the current code-review iteration. It should take roughly 30 seconds to read.

- Keep the complete overview under 500 words; prefer 80–200.
- `intent`: exactly one short sentence describing the problem and resulting behavior.
- `changes`: two to four outcome-level bullets.
- `validation`: one or two bullets naming meaningful checks actually performed.
- `reviewFocus`: at most one material area where human judgment is especially useful; omit otherwise.
- `risks`: at most one material risk, limitation, or deferred gap; omit otherwise.

Describe outcomes, not development history. Do not enumerate files, repeat file summaries or commentary, include session-specific narrative, or add GitHub PR ceremony such as ticket templates, rollout boilerplate, screenshot sections, or exhaustive checklists.

## Reference files

Set `reviewMode: "reference"` only when a changed file should remain visible and inspectable but focused line review has little value. The browser places these files in a collapsed **Reference files** sidebar group.

Appropriate examples include:

- binaries whose contents cannot be rendered;
- deterministic generated or compiled artifacts reviewed through their source-of-truth change;
- generated lockfiles when the corresponding dependency declaration is reviewed and package-manager validation passes;
- mechanical snapshots or fixtures whose intentional source change and regeneration check are both clear.

Use this classification conservatively. Never mark handwritten source, tests, configuration, migrations, security-sensitive files, or unexplained changes as reference merely because they are large or inconvenient to inspect. Every reference file must have a concise summary explaining why focused review is unnecessary and what source or validation provides confidence. Reference files remain part of the reviewed snapshot and eventual commit.

## File guidance

- Give each file a short purpose and review focus.
- Add commentary only where it materially improves understanding or requests human judgment.
- Prefer no anchored commentary over narrating obvious code.
- Use stable, descriptive commentary IDs.
- Ensure every line anchor is visible on the requested old/new diff side.

## Live comment threads

The review browser is conversational: reviewer comments arrive individually as `code-review-thread` messages, each carrying a thread id, anchor, and the new message.

- Reply promptly to each thread with `reply_review_thread`, using that thread id. The reply renders inside the reviewer's browser in real time.
- Answer every thread message inside exactly the thread that raised it. Thread messages can arrive mid-turn while you are working on something else, and posts made while you were busy arrive coalesced into one combined message; always take each thread id from the incoming message, answer each message with its own `reply_review_thread` call, and never post placeholder or cross-reference replies into other threads.
- Every commentary note you author seeds an open thread that counts as awaiting the reviewer, so write notes the reviewer should actually act on. Reviewers may resolve a note without replying; that never generates a message, and notes the reviewer never engaged with are omitted from pass summaries — the `unread-notes` attribute reports how many such notes remain instead of echoing your own commentary back.
- Keep thread replies concise and specific to the anchored code. Move broader design discussion into normal chat.
- Set `resolves: true` only when the concern is fully addressed. This merely proposes resolution; only the reviewer's explicit resolve action closes a thread, and proposals must never be treated as resolutions.
- **Never modify code in response to an individual thread.** Threads are discussion about the frozen snapshot; the worktree must stay byte-identical to it for the entire pass so the review stays truthful and every revision arrives as one stable, reviewable round. If a thread convinces you a change is needed, say so in the reply and queue it for the next round.
- The `code-review-pass` message means the reviewer finished the pass. It lists open threads with their last messages. Only then apply the accumulated feedback as one batch, validate, and open the next round.

## Review rounds

A review session is an ordered sequence of immutable rounds served in one browser session. Sending a pass locks the reviewer's posting controls behind a “Pi is revising” banner, so revise promptly.

- After a `code-review-pass`, apply the feedback as one batch, validate, then call `open_code_review` again with `previousRoundId` set to the pass's `snapshot` id. The revised changes open as the next round and the reviewer's browser advances automatically; never open a fresh review mid-unit unless no session is live.
- `previousRoundId` must be the current round. If the tool reports the round superseded, a newer round already exists — investigate before opening another.
- If nothing changed since the pass (for example, the threads needed only answers), reopening with an identical snapshot unlocks the existing round instead of adding a hollow one; keep answering its threads.
- Threads from superseded rounds are read-only; `reply_review_thread` rejects them. Respond to outstanding topics in the current round.
- Between the pass message and opening the next round, the current round is still live — you may still answer straggler threads there.

## Approval and commit loop

- Feedback submission is not approval by itself. Require an explicit statement that the current unit is approved.
- Never commit a stale review or include changes made after the approved snapshot. If the worktree changed, validate and reopen the review.
- Approval and permission to commit are separate unless the user clearly provides both. After approval, follow the repository's commit-proof policy and ask whether to commit; if the user says “approved and commit,” that is explicit permission.
- Commit only the reviewed unit with a descriptive message. Do not include unrelated or unreviewed files.
- After the commit succeeds, move to the next logical unit only when it belongs to an implementation plan the user already authorized and the next scope is clear. Otherwise, stop and ask.
- Repeat implementation, validation, review, approval, and commit for each remaining unit. Never wait until the end to combine independently reviewable units into one large commit.
