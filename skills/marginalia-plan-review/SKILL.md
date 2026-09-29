---
name: marginalia-plan-review
description: Open a Pi-led browser review of a markdown plan or design document, iterated in rounds until the reviewer approves. Use when the user wants to plan interactively, review a proposal, or converge on a design before (or instead of) implementation.
---

# Guided plan review

Use `open_plan_review` to hand the reviewer a rendered plan they can annotate. The same live-thread, round, and approval machinery as guided code review applies; this skill covers what differs for documents.

## Workflow

1. Draft the complete plan as one markdown document with real headings. The document is sliced into sections at its **shallowest heading level**, and that outline becomes the sidebar — structure the headings the way you want the plan navigated. The reviewer sees the whole document as one continuous page with no per-section chrome: your headings themselves are the section markers, and your per-section commentary renders as a quiet margin rail beside its section's text. The outline scrolls, it does not paginate.
2. Call `open_plan_review` once with `title`, the full `markdown`, optional per-section `sections` entries, and optionally `proposedApprovalNote` prefilling the reviewer's approve screen.
   - There are no section summaries: the plan text itself is the orientation. Everything in the rail is a commentary note that opens a thread; anchor notes to lines whenever they are about specific text, and leave one anchorless only for a genuinely section-wide question.
3. Answer live comment threads promptly with `reply_review_thread`, following the same live-thread rules as code review. Plan threads invite essays — resist. Replies share the margin rail with the prose they annotate, so a long one buries the plan itself. Answer in a few sentences; let the next round's document carry the elaboration.
   - Not every message needs a reply: pure acknowledgments that ask nothing get nothing (at most a `resolves: true` proposal when the concern is clearly settled). And while the session is open, the browser is the conversation — no thread narration or summaries in chat; chat carries only errors, out-of-scope questions, and the approval handoff. This constrains your narration, not your answers — messages the reviewer sends in chat get normal chat replies.
4. When the `plan-review-pass` message arrives, revise the plan as **one batch** and call `open_plan_review` again with the **full updated markdown** and `previousRoundId` set to that pass's `snapshot` id. The reviewer's browser advances to the new round automatically.
5. Repeat rounds until the reviewer approves. The `plan-review-approved` message carries their final `approval-note` and closes the session terminally.

## Sections and anchors

- Sections are identified by **slug** (lowercased heading, non-alphanumerics dashed, deduplicated with `-2` suffixes). Wire messages name sections in their `file` attribute. Content before the first heading becomes an `introduction` section.
- All line numbers are **absolute 1-based lines of the plan markdown source**, not section-relative and not rendered positions. Commentary anchors must fall inside their section's line range.
- Manifest `sections` reference headings by exact text, case-insensitively. If a heading appears more than once in the document, reference it by slug instead — ambiguous heading references fail loudly.
- Headings inside code fences are code, not structure.

## Architecture diagrams

Routing: when the user wants to iterate on diagrams themselves — a topology, a presentation figure, no surrounding prose — use `open_diagram_review` (named diagrams + optional captions; same session engine, same threads and rounds). Use this tool with inline mermaid fences when diagrams accompany a written plan.

Readability guardrails — the document column is ~760px; oversized diagrams shrink only down to 12px text, and beyond that the reviewer must pan:

- **Direction:** prefer `flowchart TB` for chains longer than ~4 nodes; keep at most ~4 nodes side by side in any row.
- **Size:** at most ~12 nodes per diagram. Split larger systems into several diagrams, one concern each; repeat a node's id where diagrams meet.
- **Grouping:** a flowchart with more than ~8 nodes puts most of them in a few `subgraph id["Title"]` boxes — tiers, trust boundaries, regions, or pipeline stages — the way architecture diagrams frame each layer. Leave shared entry points (users, clients, DNS) outside the boxes, and keep box titles to one to three words. A back-and-forth exchange between two parties stays unboxed: boxes around it force every reply to route around them.
- **Coverage:** draw every actor, component, and relationship the prose relies on, failure and return paths included; if that exceeds ~12 nodes, split per **Size**. Reviewers check diagrams against the prose, so a missing box reads as a missing decision.
- **Return paths:** in a boxed flowchart, a retry or rollback edge points back to the gate between boxes where the flow resumes, not into an earlier box: an edge up into an earlier box can reverse the layout, drawing later stages above earlier ones.
- **Syntax:** quote every label that contains punctuation (parentheses, slashes, colons, `#`, `&`), or mermaid may fail to parse: `store[("Cache (read-through)")]`.
- **Labels:** keep node and edge labels to a few words; many labeled edges converging on one node overlap. Write edge labels as `a -->|label| b` (dotted: `a -.->|label| b`); the inline `a -. label .-> b` form can drop characters. On bidirectional pairs (A to B and back), label at most one direction — mermaid collides the two labels.
- **Color:** pick the diagram type first, as if color did not exist — the message exchange of a protocol or login flow is a sequence diagram even though sequences take no tags, while the architecture around it is still a flowchart. Then, in flowcharts and state diagrams, tag like elements with a semantic role and let the theme's palette color them — architecture: `person`, `client`, `service`, `store`, `queue`, `external`; outcomes: `positive`, `negative`, `caution`, `gate`, `milestone`; change status: `new`, `changed`, `removed`. Write `api[Gateway]:::service` or `class api,db service`; never write hex colors, and keep to about 4 roles per diagram. Color never carries meaning alone: labels still say `(new)`, `rejected`, and so on. Untagged elements stay neutral — leave questions and ordinary steps untagged. Unknown tags are rejected; a `classDef` that redefines a role name is overridden by the palette, and a `classDef` under your own name is always allowed.

Most diagrams — architectures, topologies, pipelines, deployments — are flowcharts and need nothing beyond these guardrails. Four narrower kinds have a reference file; read one only when the diagram you are about to draw is that kind:

- `references/sequence-diagrams.md`: a request flow, where the point is the order of messages passed between a few parties.
- `references/decision-flows.md`: a decision procedure, questions a person answers in turn, each answer ending in an outcome or leading to the next question. Checks a system runs on its own are an ordinary flowchart.
- `references/change-maps.md`: a change map, which modules a plan adds or changes among the ones it leaves alone.
- `references/state-machines.md`: a lifecycle, the states one thing moves through and the events that move it.

Fenced ```mermaid blocks render as live diagrams the reviewer can click: a node or edge click opens a comment thread on that element. Give every meaningful node a stable, semantic id (`api`, `orders_db`) — ids are the anchor contract, and threads follow them across rounds.

- Anchor commentary to an element with `element: "node:<id>"` or `"edge:<from>-><to>"` in `sections[].commentary` — explain a specific box or arrow in the margin beside the diagram. Only nodes and edges are elements — subgraphs/containers are not; anchor to a node inside them.
- Reviewer threads on elements arrive with an `element` attribute; reply as usual.
- In `threadResponses`, re-declare `element` (with `file`) when the discussion's element still exists in the new round — renames need the NEW id. Rejections list every element the section's diagrams define.
- Revising a diagram: change the source in the markdown; never rename ids gratuitously — each rename orphans its threads.
- On round advance the reviewer sees a diff overlay: new ids and relabeled nodes glow, new edges glow as themselves, and removed elements are listed in the rail with an origin-round link. Renames read as remove + add — one more reason ids are the contract.

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
- Link prior rounds instead of quoting them: `[the earlier framing](/round/1#loc=<section>:L12)` renders as a same-origin link in replies and commentary.
- If the plan's outcome is decided outside the browser (approved in chat, abandoned), call `close_review` with any round id and a short reason so the open tab shows a truthful closed banner.

- On next rounds, respond only to threads AWAITING you (the reviewer spoke after your last reply). Threads where you spoke last carry forward automatically when omitted from threadResponses — no re-justification round after round; respond to one voluntarily only to re-anchor it or add something new.
- Reviewer-side density: clicking annotated text pulls its card to the click; the Density picker (Auto/Comfortable/Compact) collapses non-working cards to one-line rows past a dozen open threads, and clicking a compact card expands it.
- Sessions persist across pi restarts: recent non-terminal sessions are healed at boot (announced in chat, open tabs reconnect on their own), previousRoundId resumes persisted sessions from disk, and list_review_sessions shows live and resumable sessions. Set bootHeal:false in ~/.pi/agent/marginalia.json for announce-only.
- On next rounds, commentary carries: sections left unlisted (or listed without a commentary value) keep the previous round's notes while their content is byte-identical. Re-author only sections whose commentary should change; an explicit empty commentary array clears a section's notes.
