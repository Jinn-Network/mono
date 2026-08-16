# Tier 1 scenarios

Three scenarios, all single-operator, all run on every push to `next` (canary cadence) plus inside `release-prep` for any candidate version. None of them use the substrate from Plan A — Tier 1 is bootstrap-from-scratch territory.

## T1.1 — bootstrap-fresh-anvil

**Catches:** u34i / h74p / k1ng / 3nc5 bootstrap-reliability bugs.

**What it does:** Anvil-forks Base mainnet, generates a fresh master EOA, funds it, runs the bootstrap state machine through all 11 phases. Asserts `result.ok === true`.

**Implementation:** `operator/test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts`

**Wall-clock budget:** 90s

## T1.2 — harness-readiness-contract

**Catches:** vh74 per-harness auth regressions; harness-readiness shape drift; missing harnesses.

**What it does:** Spawns a fresh-HOME daemon (setup mode is enough — no bootstrap needed). Queries `/v1/harnesses/readiness` (index) and `/v1/harnesses/:name/readiness` (per harness). Asserts every known harness (`claude-code-learner`, `codex-code-learner`, `hermes-agent`) returns a valid contract response: 200 with correct shape, 404 `{error: 'harness_not_found'}`, or 503 `{error: 'subsystem_not_ready'}`.

**Implementation:** `operator/test/release/tier-1/T1.2-harness-readiness-contract.ts`

**Wall-clock budget:** 30s

## T1.4 — SPA route smoke

**Catches:** broken routes, missing mocks, JS errors, React error boundary firings.

**What it does:** Playwright test. Loads every route in `operator/src/dashboard/spa/src/routes.ts` against a mocked daemon API. For each, asserts no JS error, no error boundary visible, no console error (after filtering harmless patterns), route renders past the spinner.

**Implementation:** `operator/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts`

**Wall-clock budget:** 30s per route × ~12 routes ≈ 5min sequential. (Currently Playwright's worker config is `workers: 1` — full parallelisation can be enabled when budget tightens.)

## Contract docs in testing-jinn-app

The "what does this scenario actually exercise" docs are in `testing-jinn-app` references (Plan B). release-prep references just point at them:

- T1.4: [`testing-jinn-app/references/scenario-spa-route-smoke.md`](../../testing-jinn-app/references/scenario-spa-route-smoke.md)
- (T1.1-T1.2 are simple enough to be fully described by their implementation files; no separate contract doc needed.)
