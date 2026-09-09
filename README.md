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
3. Read the unified diff and Pi's commentary on the right.
4. Select changed/context code within one file, write your comment, and press Command+Enter (Ctrl+Enter on other platforms) to post it. Each post opens a live thread with Pi.
5. Reply beneath any Pi commentary note to discuss it, or click its **Resolve** to settle it without messaging Pi.
6. Pi's answers stream into each thread. The topbar counts everything awaiting you — unread notes and Pi replies alike; press `n` (or click the strip) to walk them. Sidebar badges count per file.
7. Resolve threads yourself — Pi can only propose resolution. Replying to a resolved thread reopens it.
8. Triage without the mouse: `Esc` leaves the text box (keeping your draft), `e` resolves the current thread or note, `n` continues, `Shift+n` steps backwards, and `?` shows the shortcuts guide.
9. Click **Finish review pass** to hand Pi one summary of the pass. It lists open threads you engaged with; your untouched notes are never echoed back to Pi. Threads stay live afterward.

While Pi is busy, posts queue and are delivered together the moment Pi settles, so a slow turn never blocks you; Pi then answers each queued thread in one pass.

If files change during the review, the finish-pass message is marked `stale="true"`. The page never remaps or refreshes annotations; open a new snapshot for updated code.

## Messages delivered to Pi

Each posted comment or reply arrives as one focused XML message — never the diff or manifest:

```xml
<code-review-thread snapshot="…" thread="1a2b3c4d-t1" kind="selection" status="open" file="src/service.ts" side="new" new-start="42" new-end="44">
  <highlight><![CDATA[const result = await execute(input);]]></highlight>
  <message author="user"><![CDATA[Why is this serial?]]></message>
</code-review-thread>
```

Pi answers with the `reply_review_thread` tool, optionally proposing resolution. Finishing a pass sends:

```xml
<code-review-pass snapshot="…" stale="false" open="2" awaiting-user="0" awaiting-pi="2" resolved="3">
  <open-thread thread="1a2b3c4d-t2" kind="commentary" file="src/service.ts" commentary-id="error-handling" last-author="user">
    <last-message><![CDATA[Could we preserve the original error?]]></last-message>
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

Each snapshot uses a server bound only to `127.0.0.1`. A random bootstrap token is exchanged for an `HttpOnly`, `SameSite=Strict` cookie and removed from the address bar. The server enforces a nonce-based script CSP, same-origin JSON POSTs, body/count/string limits, validated file/commentary anchors and thread ids, and safe HTML escaping. The live-update stream (SSE) requires the same authenticated cookie. All snapshot servers close on Pi session shutdown.

## Development

```bash
npm install
npm run typecheck
npm test
npm run check
```

The browser regression runs when a compatible Chrome/Chromium executable is available and otherwise reports a skip.

## Scope

Snapshots are immutable: the diff never refreshes or remaps in place, while comment threads stay live on top of it. Review rounds (auto-advancing to a fresh snapshot after Pi revises), cross-round thread continuity, and provider-hosted merge-request integrations are roadmap items rather than implicit behavior.
