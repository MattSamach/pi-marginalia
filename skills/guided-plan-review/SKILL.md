---
name: guided-plan-review
description: Open a Pi-led browser review of a markdown plan or design document, iterated in rounds until the reviewer approves. Use when the user wants to plan interactively, review a proposal, or converge on a design before (or instead of) implementation.
---

# Guided plan review

Use `open_plan_review` to hand the reviewer a rendered plan they can annotate. The same live-thread, round, and approval machinery as guided code review applies; this skill covers what differs for documents.

## Workflow

1. Draft the complete plan as one markdown document with real headings. The document is sliced into sections at its **shallowest heading level**, and that outline becomes the sidebar — structure the headings the way you want the plan navigated. The reviewer sees the whole document as one continuous page with no per-section chrome: your headings themselves are the section markers, and your per-section commentary renders as a quiet margin rail beside its section's text. The outline scrolls, it does not paginate.
2. Call `open_plan_review` once with `title`, the full `markdown`, optional per-section `sections` entries, and optionally `proposedApprovalNote` prefilling the reviewer's approve screen.
   - `summary` and `commentary` are different instruments — never say the same thing in both. A summary is orientation (why the section is shaped this way); it renders as a labeled, non-replyable card. A commentary note opens a thread the reviewer is expected to answer; anchor it to lines whenever it is about specific text, and leave it anchorless only for genuinely section-wide questions. If a section needs no orientation beyond its own text, omit the summary entirely.
3. Answer live comment threads promptly with `reply_review_thread`, following the same live-thread rules as code review. Plan threads invite essays — resist. Replies share the margin rail with the prose they annotate, so a long one buries the plan itself. Answer in a few sentences; let the next round's document carry the elaboration.
   - Not every message needs a reply: pure acknowledgments that ask nothing get nothing (at most a `resolves: true` proposal when the concern is clearly settled). And while the session is open, the browser is the conversation — no thread narration or summaries in chat; chat carries only errors, out-of-scope questions, and the approval handoff. This constrains your narration, not your answers — messages the reviewer sends in chat get normal chat replies.
4. When the `plan-review-pass` message arrives, revise the plan as **one batch** and call `open_plan_review` again with the **full updated markdown** and `previousRoundId` set to that pass's `snapshot` id. The reviewer's browser advances to the new round automatically.
5. Repeat rounds until the reviewer approves. The `plan-review-approved` message carries their final `approval-note` and closes the session terminally.

## Sections and anchors

- Sections are identified by **slug** (lowercased heading, non-alphanumerics dashed, deduplicated with `-2` suffixes). Wire messages name sections in their `file` attribute. Content before the first heading becomes an `introduction` section.
- All line numbers are **absolute 1-based lines of the plan markdown source**, not section-relative and not rendered positions. Commentary anchors must fall inside their section's line range.
- Manifest `sections` reference headings by exact text, case-insensitively. If a heading appears more than once in the document, reference it by slug instead — ambiguous heading references fail loudly.
- Headings inside code fences are code, not structure.

## Reading reviewer threads

- `<highlight>` quotes carry the **rendered text the reviewer saw**, not the raw markdown: emphasis markers, backticks, link targets, and heading hashes are absent. Locate the anchor by the quoted words plus the `new-start`/`new-end` source lines.
- Selection anchors always use `side="new"`; there is no old side in a plan.
- Section commentary replies carry `commentary-id` exactly as file commentary does in code reviews.

## Next rounds

- `threadResponses` is required when the previous round has open threads whose reviewer content you received: exactly one `{respondsTo, resolution, body}` per thread, anchored with `file` (heading text or slug of the **new** plan) and `startLine`/`endLine` in the **new** markdown. Omit `file` only when the concern's home is truly gone from the plan.
- Response bodies obey the same narrow-rail rule as thread replies: lead with the answer, under ~80 words. These bodies are re-sent every round a thread stays open, so verbosity compounds.
- Threads whose content never reached you (queued or pending drafts) carry automatically as held threads — do not respond to them. A held thread's anchor is written in its origin round's coordinates (`anchor-from-round`); trust its `<highlight>` text over the line numbers.
- The new round's sidebar marks sections whose content changed since the previous round; unchanged sections carry no mark. Superseded rounds stay readable in the round archive.
- An unchanged document reopens the current round instead of advancing; answer its threads in place.

## Approval

Approval closes the session with the reviewer's approval note. It is **not** an instruction to start implementing: follow the workflow of your session — the user may want the plan written to a file, handed to another session, or simply recorded. Ask if the destination is not already agreed.

## What plans do not have

No git, no diffs, no staleness badge, no viewed checklist, no expandable context, and no old-side line references. `list_review_threads` and `get_review_thread` work identically to code reviews.
