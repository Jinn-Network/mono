# #1826 Curated Mono Seed Kit Implementation Plan

> Issue: [#1826](https://github.com/Jinn-Network/mono/issues/1826)
> Base: `next` at `3dabe0eb9d2521afc861b136e82cc1068a499c18`

## Goal

Give the operator a deterministic, offline kit for preparing the three
`Jinn-Network/mono` evidence episodes required by the Stage 2 corpus guarantee,
without letting automation make the curation decision, publish records, or
claim that a live probe passed.

## Design

Add a pure batch auditor beside the existing seed-import source. It consumes
already schema-valid `SeedEpisode` values and reuses the canonical repository
term derivation, retrieval mark, `K=3` constant, and seed scrub pipeline. Its
machine-readable report separates:

- automated fixture facts: schema, exact repo, retrieval mark, probe vocabulary,
  distinct real commit provenance, completed/test-backed outcome, required
  failure/fix/command evidence, and scrub preflight;
- human facts: whether each record is genuinely relevant and authored well
  enough to admit;
- live facts: whether published records make the real doctor probe green and a
  session actually retrieves one.

The latter two are always `human-required` / `not-run` in this offline tool.

## Files

1. `client/packages/harness-layer/src/seed-import/curated-batch.ts`
   implements the pure/async audit report.
2. `client/scripts/validate-curated-seed-batch.ts` exposes it as a read-only
   command over an operator-prepared directory.
3. `client/packages/harness-layer/test/curated-seed-batch.test.ts` covers the
   K boundary, exact shared probe vocabulary, fail-closed marks, provenance,
   weak evidence, duplicates, scrub findings, and current checked-in corpus
   shortfall.
4. `client/packages/harness-layer/fixtures/curated-mono-candidates/` provides a
   non-loadable template and checklist, not pre-approved records.
5. `docs/runbooks/stage2-mono-curated-seeds.md` gives the exact operator
   preparation, review, publish, probe, evidence, rollback, and safety sequence.

## Verification

- focused Vitest suite, including negative controls;
- CLI against a temporary three-record batch and against the current Stage 1
  fixtures (the latter must fail honestly at one marked record);
- harness-layer typecheck;
- affected seed-import and corpus-probe suites;
- `git diff --check`.

## Human boundary

No checked-in candidate is labeled curated by this change. The operator chooses
and authors the two additional records (the existing Stage 1 source fixture is
only an available candidate), reviews the dry-run report, authorizes testnet
publication, verifies `jinn-layer corpus probe "Jinn-Network/mono" --json`, and
runs the attributed live session. Those actions remain on #1826.
