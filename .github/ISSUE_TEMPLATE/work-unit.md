---
name: Work unit (default)
about: Engineering work unit — bug, feature, refactor, spike, chore, docs, test, design. Default template per the engineering handbook.
title: "<shape>: <one-line summary>"
labels: []
assignees: []
---

<!--
Per docs/engineering/handbook.md §The shapes of work + DR-2026-05-20-b, every
work-unit Issue declares a shape via the native GitHub Issue Type. SET THE
ISSUE TYPE when you create this Issue (the "Type" control next to the title) —
pick ONE of: feat / fix / refactor / spike / chore / docs / test / incident /
design. The Issue Type is the canonical declaration of shape; replicate it as a
Conventional Commits prefix in the PR title. Epics (containers) use the EPIC
template and are exempt from the work-shape Types.

Routing fields live on the "Jinn engineering" Project (v2), set at Friday
triage: Blocked on (Nothing / Human / Another issue), Effort (Low / Medium /
High), Priority (P0..P4). Add this Issue to the board to set them.

Title prefix examples:
  fix: SWE typed payload fallback validation
  feat(uy6v): live verdict-success on Base Sepolia
  refactor: extract Harness selection from buildHarnesses
  spike: <can we?> question
  chore(deps): bump @types/node to 22
  docs(handbook): clarify §Weekly retrace cadence
-->

## Run-mode

<!--
One-line pointer only — the canonical shape is the Issue Type set above.
Format: `Type: <type> — see handbook §The shapes of work for the skill chain`.
e.g. `Type: fix — see handbook §The shapes of work for the skill chain`
-->

## Context

<!--
Problem (not solution): what's wrong / what gap does this close / what need triggers this?
Include the *why*, not the *how*. Per AI workflow rule 2 (handbook), Issue bodies
frame problems; solutions live in design sessions or implementation plans.
-->

## Impact

<!-- Who is affected and how. If unclear, name the user or system that would notice if this is not done. -->

## Acceptance

<!--
Testable acceptance criteria. Format as a checklist. Per the shape's test
discipline (handbook §The shapes of work):
- fix: regression test FIRST
- feat: TDD per acceptance
- refactor: TDD + integration tests on migration / contract surfaces
- chore (deps): integration test if touches a dep
- spike: output is a finding; not testable as code
- docs / test: skipped or meta
-->

- [ ]
- [ ]

## Out of scope

<!-- Explicit non-goals. Helps reviewers know what NOT to push back on. -->

## Reference

<!--
- Related Issues / PRs / DRs / specs
- Parent epic (if any) — open the Issue, then attach via the GitHub Sub-issues UI
-->
