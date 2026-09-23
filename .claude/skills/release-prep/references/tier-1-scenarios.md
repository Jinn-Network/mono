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

**What it does:** Boot-less by design — no daemon, no RPC, no filesystem state beyond the checkout. Four checks, run as five logged phases: calls the real `assembleStatusV1` against a minimal `GatheredStatusRaw` and validates the output against `statusV1ResponseSchema` (phase 1), asserting the stamped `contractVersion` equals `CURRENT_CONTRACT_VERSION` (phase 2); recomputes the schema hash and asserts it matches `CONTRACT_SHAPE_SHA` (phase 3); regenerates `openapi.v1.json` and asserts it is clean (phase 4); and asserts `notificationsV1ResponseSchema` rejects a payload with no `contractVersion` and round-trips a stamped one (phase 5). (Spec: `docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md` §8. The implementation file's own header docstring predates phase 5 and still says "Three checks" — read the phases, not the docstring.)

**Implementation:** `operator/test/release/tier-1/T1.3-contract-conformance.ts` — run in CI only by its `release:tier-1:T1.3` vitest wrapper, which `.github/workflows/release-tier-1.yml:78` runs weekly; no gate workflow invokes it. (`operator/scripts/release/run-tier-1.ts:6,111-113` also runs it under a local `yarn release:tier-1`.)

**Wall-clock budget:** none declared — `run-tier-1.ts:111-113` sets no `wallClockBudgetMs` for T1.3 (only T1.1 declares one, 90s). Boot-less, so it runs in seconds.

## T1.4 — operator-console app-flow journeys

**Catches:** regressions in the claim-policy save round-trip (mode and execution-wiring rendering, the restart-required surface, the shape of the `PUT` body the console sends) and in the Network task-posts panel (windowed 1h/6h/24h counts, and the zero-state copy).

**What it does:** Playwright. Runs two named console journeys against a mocked daemon API. The claim-policy flow asserts the tab renders with the expected mode and one `prediction.v1` wiring row, edits the policy, and asserts both the restart-required surface and the exact `claimPolicy` body of the single `PUT` the console issues. The posting-status flow asserts the task-posts panel renders its three windowed counts, and separately that it renders the zero-state copy when there are no posts.

It does **not** assert on JS errors, console errors, or React error boundaries — the only `pageerror` listener in the console e2e suite is in `live-console.e2e.ts`, which `e2e:app-flow` does not name and `playwright.config.ts:9` additionally `testIgnore`s. The retired all-routes shape did make those assertions; this one does not, so that regression class is not gated here.

**Implementation:** `apps/operator-console/e2e/claim-policy-flow.e2e.ts` and `apps/operator-console/e2e/posting-status.e2e.ts` — the two files `apps/operator-console/package.json:13` hands to Playwright as `e2e:app-flow`. Both `operator/package.json:144` (`release:tier-1:T1.4`) and `operator/package.json:185` (`e2e:app-flow`) delegate to that one console script, and `hermetic-gate.yml:397-398` runs `yarn e2e:app-flow` with `working-directory: operator` — which is why T1.4's contract is executed by the gate. `operator/scripts/release/run-tier-1.ts:22` still names its wrapper `runT14ConsoleRouteSmoke` after the retired all-routes shape.

**Wall-clock budget:** bounded by `apps/operator-console/playwright.config.ts` — 60s per test, `workers: 1`.

## Contract docs in testing-jinn-app

The "what does this scenario actually exercise" docs are in `testing-jinn-app` references (Plan B). release-prep references just point at them:

- T1.4: [`testing-jinn-app/references/scenario-spa-route-smoke.md`](../../testing-jinn-app/references/scenario-spa-route-smoke.md) — **describes the retired all-routes shape**, not the two journeys T1.4 now runs. Retained for provenance; the live contract is the two `.e2e.ts` files named above.
- (T1.1-T1.3 are simple enough to be fully described by their implementation files; no separate contract doc needed.)
