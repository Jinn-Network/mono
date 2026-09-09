# Tier 1 scenarios

> **Superseded run-role, retained contract prose.** The release-prep skill's
> mechanical run-role is retired (see `.claude/skills/release-prep/SKILL.md`);
> the publish gate is the two SHA-bound check-runs `hermetic-gate` and
> `environment-suite`. This file is retained because it is the only prose
> documenting the Tier 1 scenario contracts, including which of them those
> workflows still execute and which are covered only by the non-blocking weekly
> `release-tier-1.yml` run.

Four scenarios, all single-operator. Coverage differs per scenario: T1.1's contract is executed by `hermetic-gate.yml` via `yarn test:hermetic` (`operator/test/hermetic/bootstrap-from-scratch.test.ts`) and T1.4's via that workflow's `e2e:app-flow` step. **T1.2's and T1.3's contracts have no home in either gate workflow** — neither `hermetic-gate.yml` nor `environment-suite.yml` runs them. They are covered instead by `.github/workflows/release-tier-1.yml`, which invokes their `release:tier-1:T1.2` and `release:tier-1:T1.3` vitest wrappers on a weekly schedule (Mondays 06:00 UTC) plus manual dispatch — non-blocking by construction, so a regression there is "investigate before the next cut", not a blocked PR. None of the four use the substrate from Plan A — Tier 1 is bootstrap-from-scratch territory.

## T1.1 — bootstrap-fresh-anvil

**Catches:** u34i / h74p / k1ng / 3nc5 bootstrap-reliability bugs.

**What it does:** Anvil-forks Base mainnet, generates a fresh master EOA, funds it, runs the bootstrap state machine through all 11 phases. Asserts `result.ok === true`.

**Implementation:** `operator/test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts`

**Wall-clock budget:** 90s

## T1.2 — harness-readiness-contract

**Catches:** vh74 per-harness auth regressions; harness-readiness shape drift; missing harnesses.

**What it does:** Spawns a fresh-HOME daemon (setup mode is enough — no bootstrap needed). Queries `/v1/harnesses/readiness` (index) and `/v1/harnesses/:name/readiness` (per harness). Asserts every known harness (`claude-code-learner`, `codex-code-learner`, `hermes-agent`) returns a valid contract response: 200 with correct shape, 404 `{error: 'harness_not_found'}`, or 503 `{error: 'subsystem_not_ready'}`.

**Implementation:** `operator/test/release/tier-1/T1.2-harness-readiness-contract.ts` — run in CI only by its `release:tier-1:T1.2` vitest wrapper, which `.github/workflows/release-tier-1.yml` runs weekly; no gate workflow invokes it. (`operator/scripts/release/run-tier-1.ts:5,105-107` also runs it under a local `yarn release:tier-1`, which no workflow invokes.)

**Wall-clock budget:** 30s

## T1.3 — contract conformance

**Catches:** read-contract drift — a producer that stops stamping `contractVersion` or stamps the wrong one; a schema shape change landed without a version-bump decision; a stale committed `openapi.v1.json`.

**What it does:** Boot-less by design — no daemon, no RPC, no filesystem state beyond the checkout. Three checks: calls the real `assembleStatusV1` against a minimal `GatheredStatusRaw` and validates the output against `statusV1ResponseSchema`, asserting the stamped `contractVersion` equals `CURRENT_CONTRACT_VERSION`; recomputes the schema hash and asserts it matches `CONTRACT_SHAPE_SHA`; regenerates `openapi.v1.json` and asserts it is clean. (Spec: `docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md` §8.)

**Implementation:** `operator/test/release/tier-1/T1.3-contract-conformance.ts` — run in CI only by its `release:tier-1:T1.3` vitest wrapper, which `.github/workflows/release-tier-1.yml:78` runs weekly; no gate workflow invokes it. (`operator/scripts/release/run-tier-1.ts:6,111-113` also runs it under a local `yarn release:tier-1`.)

## T1.4 — operator-console app-flow journeys

**Catches:** broken operator-console journeys — JS errors, React error boundary firings, and regressions in the claim-policy and posting-status flows against a mocked daemon API.

**What it does:** Playwright. Runs two named console journeys — claim policy and posting status — against a mocked daemon API, asserting each renders past the spinner and completes its flow without a JS error or a visible error boundary.

**Implementation:** `apps/operator-console/e2e/claim-policy-flow.e2e.ts` and `apps/operator-console/e2e/posting-status.e2e.ts`, run by `yarn --cwd apps/operator-console e2e:app-flow` (`apps/operator-console/package.json:13`). `operator/package.json:144` defines `release:tier-1:T1.4` as byte-identical to that command, and `hermetic-gate.yml:398` runs `yarn e2e:app-flow` — which is why T1.4's contract is executed by the gate. `operator/scripts/release/run-tier-1.ts:22` still names its wrapper `runT14ConsoleRouteSmoke` after the retired all-routes shape.

**Wall-clock budget:** bounded by `apps/operator-console/playwright.config.ts` — 60s per test, `workers: 1`.

## Contract docs in testing-jinn-app

The "what does this scenario actually exercise" docs are in `testing-jinn-app` references (Plan B). release-prep references just point at them:

- T1.4: [`testing-jinn-app/references/scenario-spa-route-smoke.md`](../../testing-jinn-app/references/scenario-spa-route-smoke.md) — **describes the retired all-routes shape**, not the two journeys T1.4 now runs. Retained for provenance; the live contract is the two `.e2e.ts` files named above.
- (T1.1-T1.3 are simple enough to be fully described by their implementation files; no separate contract doc needed.)
