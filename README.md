# pi-code-review

A Pi package for static, agent-guided browser reviews of local Git changes. Pi can choose a logical file order, explain each file and selected line ranges, then receive your diff comments and replies as one focused XML user message.

## Install locally

```bash
cd /Volumes/git/pi-code-review
npm install
pi install /Volumes/git/pi-code-review
```

Reload an existing Pi session with `/reload` after installation.

## Use

Ask Pi to walk you through its current changes. Pi calls `open_code_review` with an ordered manifest containing file summaries and optional anchored commentary.

For a review without agent commentary:

```text
/review-browser
/review-browser --help
```

The snapshot contains staged and unstaged changes against `HEAD`, plus untracked files as all-addition diffs. Files omitted from Pi's manifest are appended, so commentary cannot hide changes.

In the browser:

1. Use the left sidebar to follow Pi's file order.
2. Read the unified diff and Pi's commentary on the right.
3. Select changed/context code within one file to add a comment. Press Command+Enter (Ctrl+Enter on other platforms) to add the active comment without submitting the review.
4. Reply directly beneath any Pi commentary card.
5. Submit one static feedback batch.

If files change before submission, the resulting message is marked `stale="true"`. The page never remaps or refreshes annotations; open a new snapshot for updated code.

## Feedback schema

Only feedback and precise anchors are returned—not the diff or manifest:

```xml
<code-review-feedback snapshot="…" stale="false">
  <comment file="src/service.ts" side="new" new-start="42" new-end="44">
    <highlight><![CDATA[const result = await execute(input);]]></highlight>
    <feedback><![CDATA[Why is this serial?]]></feedback>
  </comment>
  <reply file="src/service.ts" commentary-id="error-handling">
    <feedback><![CDATA[Could we preserve the original error?]]></feedback>
  </reply>
</code-review-feedback>
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

Binary file contents are never rendered. Renames, additions, deletions, and modifications are listed. A banner identifies binary, truncated, and overall-cap-omitted files.

## Security model

Each snapshot uses a server bound only to `127.0.0.1`. A random bootstrap token is exchanged for an `HttpOnly`, `SameSite=Strict` cookie and removed from the address bar. The server enforces a nonce-based script CSP, same-origin JSON POSTs, body/count/string limits, validated file/commentary anchors, and safe HTML escaping. All snapshot servers close on Pi session shutdown.

## Development

```bash
npm install
npm run typecheck
npm test
npm run check
```

The browser regression runs when a compatible Chrome/Chromium executable is available and otherwise reports a skip.

## v1 scope

This release intentionally supports immutable snapshots and one submission batch. Live refresh, comment remapping, iterative review rounds, and provider-hosted merge-request integrations are roadmap items rather than implicit behavior.
