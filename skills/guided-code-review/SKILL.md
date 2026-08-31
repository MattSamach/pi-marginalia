---
name: guided-code-review
description: Open a Pi-led browser review of the current uncommitted Git changes. Use when the user asks to review, walk through, or explain the agent's current code changes interactively.
---

# Guided code review

Use `open_code_review` to present the current changes in the order that makes them fastest to understand.

## Workflow

1. Inspect the complete staged, unstaged, and untracked change set against `HEAD`.
2. Choose a logical review order based on behavior and dependencies, not lexical file order.
3. Write the review overview and concise file guidance.
4. Call `open_code_review` once with every changed file. The tool appends omitted changed files, but explicitly ordering all files produces the clearest walkthrough.

## Overview

The overview is an **EXTREMELY concise, pre-PR introduction** to the current code-review iteration. It should take roughly 30 seconds to read.

- Keep the complete overview under 100 words; prefer 50–80.
- `intent`: exactly one short sentence describing the problem and resulting behavior.
- `changes`: two to four outcome-level bullets.
- `validation`: one or two bullets naming meaningful checks actually performed.
- `reviewFocus`: at most one material area where human judgment is especially useful; omit otherwise.
- `risks`: at most one material risk, limitation, or deferred gap; omit otherwise.

Describe outcomes, not development history. Do not enumerate files, repeat file summaries or commentary, include session-specific narrative, or add GitHub PR ceremony such as ticket templates, rollout boilerplate, screenshot sections, or exhaustive checklists.

## File guidance

- Give each file a short purpose and review focus.
- Add commentary only where it materially improves understanding or requests human judgment.
- Prefer no anchored commentary over narrating obvious code.
- Use stable, descriptive commentary IDs.
- Ensure every line anchor is visible on the requested old/new diff side.
