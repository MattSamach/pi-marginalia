# pi-code-review

A Pi package for agent-guided browser reviews of local Git changes. Pi chooses a logical file order, explains each file and selected line ranges, and then converses with you through live comment threads: each comment you post is delivered to Pi immediately, and Pi's answers stream back into the exact thread in your browser.

## Install locally

```bash
cd /Volumes/git/pi-code-review
npm install
pi install /Volumes/git/pi-code-review
```

Reload an existing Pi session with `/reload` after installation.

## Use

Ask Pi to walk you through its current changes. The bundled `guided-code-review` skill reviews one logical commit unit at a time with an extremely concise pre-PR overview, an ordered manifest, file summaries, and optional anchored commentary. After explicit approval and commit permission, Pi commits that reviewed unit before continuing to the next already-authorized implementation unit.

For a review without agent commentary:

```text
/review-browser
/review-browser --help
```

The snapshot contains staged and unstaged changes against `HEAD`, plus untracked files as all-addition diffs. Files omitted from Pi's manifest are appended, so commentary cannot hide changes. Pi may classify binaries and deterministic generated artifacts as `reviewMode: "reference"`; they remain inspectable under a collapsed **Reference files** sidebar group and remain part of the snapshot and commit.

In the browser:

Everything that needs your attention is one uniform queue: every Pi commentary note starts as an open thread awaiting you, exactly like a Pi reply.

1. Read the brief overview; each general comment you post there starts its own topic thread, and the tally tracks all threads (notes included) from first load.
2. Use the left sidebar to follow Pi's primary review order; expand **Reference files** only when you want to inspect low-value generated or binary artifacts.
3. Read the unified diff and Pi's commentary on the right. Changed-line pairs highlight the words that actually differ (GitHub-style intraline emphasis); whole-line rewrites stay unhighlighted rather than shouting.
4. Select changed/context code within one file, write your comment, and press Command+Enter (Ctrl+Enter on other platforms) to post it. Each post opens a live thread with Pi. Add Shift (`⇧⌘⏎`) to **quiet-add** instead: the thread is created and visible but nothing reaches Pi until you send the round — GitHub-PR-style batch review without a mode toggle. Quiet replies keep a queued thread queued; replying with plain `⌘⏎` escalates it, delivering the whole backlog at once. Delivery is tracked **per message**, so `⇧⌘⏎` also works mid-conversation on a live thread: the reply becomes a *pending* message (badged on the card) that Pi doesn't see until you send the round, reply live (which delivers the whole pending backlog in order — Pi never sees a gap), or click its **Send now**. The send button counts every undelivered message (“Send round to Pi (3 to send)”), and the Phase 5 contract guarantees queued threads get anchored resolutions in the next round. Until the round is sent, queued messages stay yours: **Edit** and **Delete** on each undelivered message (no edit history — Pi never saw the original), and deleting a thread's last message removes the thread entirely. Anything delivered — live posts, escalated backlogs, sent rounds — is immutable.
5. Reply beneath any Pi commentary note to discuss it, or click its **Resolve** to settle it without messaging Pi.
6. Pi's answers stream into each thread. The topbar counts everything awaiting you — unread notes and Pi replies alike; press `n` (or click the strip) to walk them. Sidebar badges count per file.
7. Resolve threads yourself — Pi can only propose resolution. Replying to a resolved thread reopens it.
8. Review without the mouse: `j`/`k` walk the active file's hunks with a visible focus ring, `]`/`[` switch files, `o` returns to the overview, and `r` (or `⏎`) jumps to the current thread's reply box — `Esc` leaves the text box (keeping your draft), `e` resolves the current thread or note, `n` continues, `Shift+n` steps backwards, `⇧⌘⏎` quiet-adds in a comment box (elsewhere it opens the send-round confirmation — a keyboard-first modal where `⏎` sends and `Esc` cancels), `x` marks the current file viewed, and `?` (or the header hint) shows the shortcuts guide.
9. Read formatted commentary: Pi's notes, file summaries, and every thread message render markdown — inline code, fenced blocks, bold/italic, lists, and http(s) links — through a built-in sanitizing renderer (all HTML escaped, link schemes whitelisted, no third-party dependency).
10. Track progress with the viewed checklist: every file has a **Viewed** checkbox (header or `x`), mirrored as a sidebar checkmark and progress bar. It is reviewer-side bookkeeping only — never sent to Pi — and stays available while Pi revises. A new round keeps a file's checkmark only when its diff is byte-identical to the previous round.
11. Expand hidden context: gaps between hunks (and above the first or below the last) show a divider with GitHub-style expanders — reveal 20 lines from either end or the whole gap at once. Content comes lazily from the blob pinned at the snapshot's HEAD commit, so it stays true to the frozen review no matter how the worktree has drifted since. Expanded lines are visual context only: comments still anchor to the diff and its original context lines. Untracked, added, deleted, binary, and truncated files have no expandable gaps.
12. Approve to close: the green **Approve** button tallies open threads (clicking jumps to the first blocker) and unlocks only when every thread — queued and carried included — is resolved. The confirmation screen shows file stats, warns if the repository has drifted from the snapshot, and lets you edit the proposed commit message. Confirming closes the session terminally: Pi receives your final commit message, mutations lock, and pages stay readable.
13. Trust the topbar drift badge: while the page is open, the server periodically re-checks the repository against the frozen snapshot (a cheap fingerprint gates the full re-collection). If they diverge — edits, staging, or a commit — a **no longer matches this snapshot** badge appears; informational only; reading and commenting stay open, and the badge clears if the tree returns. It is hidden while Pi revises, when drift is expected. The drifted files themselves carry an amber dot in the sidebar, and the badge tooltip lists every drifted path — including files that joined the changeset after the snapshot.
14. Click **Send round to Pi** to hand Pi one summary of the pass. It lists open threads you engaged with; your untouched notes are never echoed back to Pi.
15. Link to a line: click any line number to put a `#loc=file:L42` permalink in the address bar (old-side lines use `O`); opening one navigates to the file and rings the row — with an honest hint when the target sits in an unexpanded gap. Focused threads already permalink via `#thread=`.
16. Drafts survive reloads: unfinished comments — selection drafts (anchor and quote included), thread and note replies, overview feedback — persist in the browser's storage keyed by the snapshot, restore when the page reopens, and clear the moment they post.
17. Drafts never block navigation: switch files, jump threads, or follow permalinks freely — an open selection draft stays live in its section, marked by a ✎ pencil on its sidebar entry. You are asked to discard only where the draft would actually die: replacing it with a new selection, sending the round, or approving.

While Pi is busy, posts queue and are delivered together the moment Pi settles, so a slow turn never blocks you; Pi then answers each queued thread in one pass.

### Review rounds

A review session is an ordered sequence of immutable, fingerprinted rounds. Sending a round opens a **quiet window** behind a *“Pi is revising — round N+1 pending”* banner while Pi applies your feedback as one batch: reading, navigation, and composing all stay open, but everything you write queues for the next round — nothing reaches Pi mid-revision, and resolving and re-sending wait. The composer buttons say so (“Queue for next round”). When Pi reopens the review with `previousRoundId`, the revised changes arrive as the next round and your open tab advances to it automatically. Prior rounds stay reachable read-only through the topbar round switcher — threads included — and mutations against them are rejected on the server, not just hidden. If a new round never arrives (Pi crashed or was interrupted), the banner's **Resume reviewing this round** unlocks the current round; if Pi reopens with an unchanged snapshot, the current round unlocks instead of adding a hollow round.

### Thread continuity

Open threads never silently die between rounds. A next round is rejected unless it answers **every** open thread of the pass with exactly one response — `addressed`, `declined`, or `needs-discussion` — and Pi must explicitly designate where each carried conversation now lives: a validated line anchor in the new snapshot, a file-level placement, or (only when the anchor is truly gone) the overview's **Outdated threads** strip. There is no heuristic re-anchoring: placement is Pi's auditable claim, and your original highlight travels verbatim inside the carried card so the claim is checkable at a glance.

Carried threads keep their ids and full conversation history, count as awaiting you, and work with `n`/`e` like any thread; `addressed` responses arrive as one-click resolution proposals. A thread at its 50-turn cap stops accepting replies; resolving it remains available. Each carried card's *from round N* label deep-links to the read-only origin round, scrolled to the thread at its original anchor. Threads you resolved earlier don't carry — they collect in a collapsed **Resolved in earlier rounds** archive on the overview. Your untouched Pi notes also don't carry; fresh rounds bring fresh notes.

If files change during the review, the pass message is marked `stale="true"`. The page never remaps or refreshes annotations; iteration happens in whole rounds.

## Plan reviews

`open_plan_review` runs the same review machinery over a rendered **markdown plan** instead of a diff — the planning-mode counterpart to code review. The document is sliced into sections at its shallowest heading level and reads as ONE continuous page with no per-section boxes or headers (the markdown headings themselves mark the sections, with Pi's commentary in a margin rail beside its section); the sidebar becomes that outline, scrolling to sections and following the reading position (a Focus-section toggle shows one section at a time for very large plans). The reviewer selects rendered text to open threads (anchored to absolute source lines of the plan markdown), replies to Pi's per-section commentary, and sends rounds exactly as in code review. Revisions arrive as whole new rounds via `previousRoundId`; the sidebar marks the sections whose content changed, and superseded rounds stay in the archive. Approval carries a reviewer-edited **approval note** (`plan-review-approved`) and closes the session; it deliberately does not prescribe a next step — plans need not lead to code. Wire messages use `plan-review-*` root tags. Plans have no git, staleness, viewed checklist, or expandable context; drafts, permalinks (`#loc=section-slug:L42`), keyboard navigation (`j`/`k` walk rendered blocks), and quiet-add batching all work unchanged.

## Messages delivered to Pi

Each posted comment or reply arrives as one focused XML message — never the diff or manifest:

```xml
<code-review-thread snapshot="…" round="1" thread="1a2b3c4d-t1" kind="selection" status="open" file="src/service.ts" delivered-user-turns="1" side="new" new-start="42" new-end="44">
  <highlight><![CDATA[const result = await execute(input);]]></highlight>
  <message author="user" turn="1"><![CDATA[Why is this serial?]]></message>
</code-review-thread>
```

Every message is self-contained: commentary threads carry their note's anchor (`side`/`start-line`/`end-line`) and carried threads carry Pi's re-declared anchor, so no message ever arrives as a bare thread id. Two attributes make delivery auditable: `turn` is each message's creation-time sequence number (stable under deletion of undelivered messages — gaps are innocent), and `delivered-user-turns` is the thread's lifetime count of delivered reviewer messages as of that transmission — if Pi's own tally of received `<message>` elements ever falls short of it, a message was lost.

Pi answers with the `reply_review_thread` tool, optionally proposing resolution. Sending a round produces one pass summary; its `snapshot` id is what Pi passes back as `previousRoundId` to open the next round:

```xml
<code-review-pass snapshot="…" round="1" stale="false" open="2" awaiting-user="0" awaiting-pi="2" resolved="3" unread-notes="0" queued="0" pending="0">
  <open-thread thread="1a2b3c4d-t2" kind="commentary" status="open" file="src/service.ts" commentary-id="error-handling" delivered-user-turns="2" side="new" start-line="18" end-line="22" last-author="user">
    <last-message turn="3"><![CDATA[Could we preserve the original error?]]></last-message>
  </open-thread>
</code-review-pass>
```

## Rendering limits

These limits keep large repositories responsive. The snapshot fingerprint still covers content that is truncated or omitted.

| Limit | Value |
|---|---:|
| Per-file patch bytes | 200 KiB |
| Per-file diff lines | 2,000 |
| Overall rendered bytes | 2 MiB |
| Overall rendered lines | 10,000 |
| Manifest files | 500 |
| Commentary entries per file | 100 |
| Reviewer-created threads per review | 200 (commentary notes seed threads in addition) |
| Turns per thread | 50 |

Binary file contents are never rendered. Renames, additions, deletions, and modifications are listed. A banner identifies binary, truncated, and overall-cap-omitted files.

## Security model

Each review session uses one server bound only to `127.0.0.1`, hosting every round of that session. A random single-use bootstrap token is exchanged for an `HttpOnly`, `SameSite=Strict` cookie and removed from the address bar; round pages and the live-update stream (SSE) require that cookie. The server enforces a nonce-based script CSP, same-origin JSON POSTs, body/count/string limits, validated file/commentary anchors and thread ids, and safe HTML escaping. Superseded rounds reject all mutations server-side. All session servers close on Pi session shutdown.

## Development

```bash
npm install
npm run typecheck
npm test
npm run check
```

The browser regression runs when a compatible Chrome/Chromium executable is available and otherwise reports a skip.

## Scope

Snapshots are immutable: the diff never refreshes or remaps in place, while comment threads stay live on top of it; iteration happens in whole rounds with open threads carried forward explicitly. Provider-hosted merge-request integrations are roadmap items rather than implicit behavior.
