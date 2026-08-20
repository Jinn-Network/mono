## Summary

<!--
Problem (not solution): what's wrong / what gap does this close / what need triggers this?
Use the seven work shapes from docs/engineering/handbook.md:
fix / feat / refactor / spike / chore / docs / test (plus fix(incident) for hotfixes).
The shape goes in the PR title as a Conventional Commits prefix:
  fix: SWE typed payload fallback validation
  feat(uy6v): live verdict-success on Base Sepolia
  refactor: extract Harness selection from buildHarnesses
-->

## Linked Issue

<!-- e.g. Closes #123. Per DR-2026-05-18 the canonical issue substrate is GitHub Issues; the legacy `Closes jinn-mono-<id>` form continues to resolve for archived references but new work links to GH Issue numbers. -->

## Test plan

<!--
How was this verified? Reference the test discipline for the shape:
- fix: regression test first
- feat: TDD per acceptance criteria
- refactor: TDD + integration tests on migration/contract surfaces
- chore (deps): integration test
- spike: not applicable (output is a finding)
- docs / test: skipped or meta
- fix(incident): defer test; file a follow-up Issue for the regression test BEFORE closing the incident
-->

## Agent identity (if AI-authored)

<!--
Add a Co-Authored-By trailer to your commits for AI contributions, e.g.:
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  Co-Authored-By: OpenAI Codex <noreply@openai.com>
Reviewer parity (handbook rule 4): agent PRs go through the same review gate as human PRs.
-->

### Canonical-doc changes (delete if not applicable)

- [ ] Linked GitHub Discussion: `https://github.com/Jinn-Network/mono/discussions/<n>`
- [ ] CODEOWNERS approval obtained (required only if this PR touches a human-surface path in `.github/CODEOWNERS`)
- [ ] Ran `git grep -l "Canonical references.*<changed-file>"` and re-reviewed downstream docs
- [ ] Updated downstream docs that needed it (or noted why none did)

### Prediction-freeze guardrail (delete if not applicable)

<!-- Prediction SolverNet is frozen per DR-2026-05-11-a. Prediction-only PRs require explicit Captain approval citing shared-infrastructure rationale. -->

- [ ] This PR touches Prediction-only surfaces (Polymarket task generator, prediction.v0/v1 contracts, prediction-flavored plugins/harness pieces) — Captain approval obtained, rationale: ...
