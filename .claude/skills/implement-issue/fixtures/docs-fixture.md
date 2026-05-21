Issue Type: docs | Effort: Low

Title: Fix stale script names in docs/runbooks/testing.md

**Context.** `docs/runbooks/testing.md` references two scripts that do not match `client/package.json`:

1. `yarn e2e-prediction-apy-v0` appears at line 35 ("E2E scripts live in `client/test/e2e/<scenario>.ts` and are invoked via `yarn e2e`, `yarn e2e-prediction-apy-v0`, etc.") and in the commands table at line 148. This script does not exist in `client/package.json`; the closest live commands are `test:claude-prediction-apy` (a unit-level vitest run, not an e2e scenario) and no standalone APY e2e entry.

2. The commands table at line 149 labels `yarn e2e:prediction` as "prediction-v0 e2e", but the script in `client/package.json` runs `tsx test/e2e/prediction-v1.ts` — it is the prediction-v1 e2e, not v0.

Both references were left behind when the APY e2e script was retired / renamed and when prediction v0 was superseded by v1.

**Impact.** A contributor following the runbook to run the prediction APY e2e scenario will get `yarn: error Command "e2e-prediction-apy-v0" not found` with no fallback. The v0 mislabel causes confusion when debugging v1 failures — contributors look for v0 artifacts that don't exist.

**Acceptance criteria.**
- [ ] After the change, every script name referenced in the commands table in `docs/runbooks/testing.md` exists verbatim in `client/package.json`'s `scripts` block.
- [ ] The label for `yarn e2e:prediction` accurately describes the scenario it runs (prediction-v1, not prediction-v0).

**Files/components.** `docs/runbooks/testing.md` (lines 35, 148, 149) — documentation-only change, no source files touched.
