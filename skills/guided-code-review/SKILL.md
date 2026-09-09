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
8. Address actionable feedback, validate again, and open a fresh snapshot. Repeat until the unit is explicitly approved.
9. Follow the approval and commit loop below, then continue to the next already-authorized implementation unit when one remains.

## Overview

The overview is an **EXTREMELY concise, pre-PR introduction** to the current code-review iteration. It should take roughly 30 seconds to read.

- Keep the complete overview under 100 words; prefer 50–80.
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

## Approval and commit loop

- Feedback submission is not approval by itself. Require an explicit statement that the current unit is approved.
- Never commit a stale review or include changes made after the approved snapshot. If the worktree changed, validate and reopen the review.
- Approval and permission to commit are separate unless the user clearly provides both. After approval, follow the repository's commit-proof policy and ask whether to commit; if the user says “approved and commit,” that is explicit permission.
- Commit only the reviewed unit with a descriptive message. Do not include unrelated or unreviewed files.
- After the commit succeeds, move to the next logical unit only when it belongs to an implementation plan the user already authorized and the next scope is clear. Otherwise, stop and ask.
- Repeat implementation, validation, review, approval, and commit for each remaining unit. Never wait until the end to combine independently reviewable units into one large commit.
