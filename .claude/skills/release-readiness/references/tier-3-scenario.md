# Tier 3 scenario — producer-evaluator real-testnet

> **SUPERSEDED (historical contract).** The two-gate redesign ([`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md`](../../../../docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md)) moved this real-testnet coverage into CI: it now runs inside `.github/workflows/environment-suite.yml` and posts the `environment-suite` check-run. release-readiness **reads** that check-run (Phase 5); it does **not** run this scenario on a laptop or manage a daemon mutex. The impl paths below remain accurate as the scenario `environment-suite` executes — keep this file as the scenario contract, not as a live laptop runbook.

The single Tier 3 scenario, as `environment-suite.yml` runs it (historically: release-readiness Phase 5, human-invoked, on a laptop).

**Implementation:** `operator/test/release/tier-3/T3.1-producer-evaluator-real.ts`

**Orchestrator:** `operator/scripts/release/run-tier-3.ts`

## Pre-conditions

- Daily-driver daemons SIGTERM'd (ports 7331, 7332 free). release-readiness Phase 5 manages this.
- substrate-topup verified: op-a + op-b have ≥ 0.002 ETH on Base Sepolia; OLAS bond current.
- OpenRouter API key available (env `OPENROUTER_API_KEY` or daemon config).
- `JINN_T31_REAL=1` environment variable to acknowledge real-network spend.

## Execution flow

1. Spawn op-a daemon: `HOME=~/jinn-dev/operators/op-a node dist/bin/jinn.js run --no-ui` (port 7360)
2. Spawn op-b daemon: `HOME=~/jinn-dev/operators/op-b ...` (port 7361)
3. op-a posts a small SWE-rebench v2 task (instance from fixtures/known-instance.ts)
4. op-a claims, solves via real Hermes (real OpenRouter API call, ~$0.05-$0.10)
5. op-a delivers
6. op-b claims verdict request
7. op-b runs real evaluator Docker image, scores
8. op-b posts verdict
9. Assert `verdictCode === KNOWN_EXPECTED_VERDICT`

## Budgets

- Wall-clock: 10 min hard
- Cost: $0.25 cap (API + tiny gas)

## Failure modes

| Failure | Class | Result |
|---|---|---|
| Daily driver running | n/a | abort with explicit instruction |
| Daemon spawn fails | real-bug | BLOCK with daemon stderr |
| Task post fails | real-bug | BLOCK |
| Solve times out (>8 min) | flake-timing first; real-bug on retry | retry once |
| Verdict mismatches expected | real-bug | REAL REGRESSION → recommendation = BLOCK |
| API budget exceeded | n/a | abort partial; surface cost analysis |

## Output

- `tier-3-evidence/<timestamp>/T3.1.log` — phase markers + tx hashes + CIDs
- `tier-3-evidence/<timestamp>/summary.json` — structured verdict
- `tier-3-evidence/<timestamp>/marker.txt` — release-evidence marker

## Why this is load-bearing

T3.1 was the manual A3 verification that carried the v0.1.6 ship decision (the gates flaked four ways; A3 said `verdictCode=1`; we shipped). Codifying it makes that evidence pattern reproducible.
