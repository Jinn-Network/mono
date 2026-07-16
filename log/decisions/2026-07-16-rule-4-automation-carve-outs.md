---
id: DR-2026-07-16
title: "Rule 4 automation carve-outs — record the auto-merge exception (b, #1735) retroactively and the merge-prep mechanical-conflict-resolution exception (c, #1756); review parity means the independent review happens, not that a human presses merge"
date: 2026-07-16
verb: Decide
status: accepted
authors: "Ritsu (operator decisions — auto-merge carve-out 2026-07-15, merge-prep carve-out #1756); Claude Fable 5 (drafted, docs session for #1758)"
relates-to: "#1735 (Autopilot merge sweep — carve-out b); #1756 (merge-prep session, Stage B — carve-out c); #1757 (structured stuck-PR report — the escalation path); #1758 (the docs issue this DR lands with); DR-2026-06-03 (human-surface review gate — the invariant neither carve-out relaxes)"
amends: none — records decisions whose operative wording lives in docs/engineering/handbook.md §AI workflow rules, rule 4
---

## Context

AI workflow rule 4 — **agent PR review parity, no agent self-merge** — has accrued carve-outs inline in the handbook without a Decision Record backing them:

- **(b) Auto-merge of approve-eligible pipeline PRs** (operator decision, Ritsu, 2026-07-15; Autopilot merge sweep, #1735). A PR carrying the engine review label may merge automatically iff it was approved by the independent review loop (distinct reviewer identity), is un-drafted, every reported status check succeeded, GitHub reports it cleanly mergeable, and it touches no code-owned path. This shipped straight into the handbook and CLAUDE.md rule-4 text with no DR.
- **(c) Agent-authored mechanical conflict resolutions** (merge-prep session, Stage B of #1756). A flag-gated session may push a mechanical conflict resolution — lockfile/generated-file regeneration, non-overlapping textual merges — to a PR branch it did not author. This carve-out is being added to rule 4 in the same PR that lands this DR (#1758).

Rule 4 exceptions change what "no agent self-merge" means in practice; each deserves a recorded decision and rationale. This DR retroactively records (b) and records (c) at introduction time.

## Decision

**Rule 4 carries two automation carve-outs beyond the original `fix(incident)` reviewer relaxation.** The handbook rule-4 text (`docs/engineering/handbook.md` §AI workflow rules, mirrored in `CLAUDE.md` §Ten ratified AI workflow rules) is the operative wording; this DR records the decisions and their rationale.

1. **(b) Auto-merge of approve-eligible pipeline PRs** (#1735). An engine-reviewed, approved, CI-green, cleanly-mergeable, non-code-owned pipeline PR merges without a human pressing the button. The independent review — by a reviewer identity distinct from the author — has already happened; only the merge mechanics are automated.
2. **(c) Merge-prep mechanical conflict resolutions** (#1756). A flag-gated merge-prep session may push a mechanical conflict resolution (lockfile/generated-file regeneration, non-overlapping textual merges) to a PR branch it did not author. The push converts the PR back to draft, so it re-enters the full review + merge gates: nothing merges on the strength of the resolution itself — the PR must be re-approved and re-pass CI before sweep (b) can touch it. Semantic conflicts and any code-owned path always escalate to a human via the structured stuck-PR report (#1757).

## Rationale

Review parity means **the independent review happens** — it never meant a human must press merge. Both carve-outs automate mechanics while preserving the review:

- In (b), the review already happened before the sweep acts; the sweep verifies its verdict plus CI and mergeability, and executes a merge a human would have executed identically.
- In (c), the resolution itself becomes reviewed work: re-drafting the PR forces the conflict resolution back through the same approval and CI gates as any other change on the branch. The agent gains no authority over what merges — only the ability to produce a candidate resolution for review.

## Invariants that never relax

- **Independent-reviewer identity distinct from the author.** No PR merges without an approval from a reviewer that is not its author — human or agent, the identities must differ.
- **Code-owned / human-surface paths always wait for a human** (DR-2026-06-03 stands). An agent approval never satisfies the code-owner gate; carve-out (b) excludes code-owned paths entirely, and carve-out (c) escalates them rather than touching them.
- **Semantic conflicts always escalate.** The merge-prep session resolves only mechanical conflicts; anything requiring judgment about intent goes to a human via the structured stuck-PR report (#1757).

## Consequences

- The handbook and CLAUDE.md rule-4 texts gain exception (c) and the §Daily loop review step points to rule 4's exceptions instead of restating a stale subset (#1758, the PR carrying this DR).
- Future rule-4 carve-outs require a DR at introduction time — this file is the precedent and the natural home for amendments.
