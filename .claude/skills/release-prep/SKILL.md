# release-prep

Mechanical gate-runner skill. Runs Tier 1 (and eventually Tier 2) scenarios against a candidate branch, classifies failures, emits a marker block ready to paste into a GitHub Release body.

This skill is *not* the audit layer — that's `release-readiness`. release-prep runs gates and reports; it doesn't decide blocking vs deferrable. release-readiness invokes release-prep as a subagent.

## When to use

- Invoked by `release-readiness` during its Phase 5 validation.
- Invoked manually when an operator wants gate evidence for a candidate SHA.
- (Future) invoked by a CI workflow that wants on-every-push Tier 1 evidence.

## Input contract

```typescript
interface ReleasePrepInput {
  branchSha: string;
  candidateVersion: string;
  outputDir?: string;
  scenarios?: ScenarioId[];     // optional; default = all enabled
}
```

## Output

- `<outputDir>/summary.json` — structured verdict list
- `<outputDir>/marker.txt` — marker block for the release body
- `<outputDir>/T1.1.log`, `T1.2.log`, etc. — per-scenario evidence

## How to invoke

The tier runners execute under plain `tsx` and do **not** auto-load `client/.env`.
Scenarios that need secrets — `BASE_SEPOLIA_RPC_URL` (T2.1, T2.3), `BASE_RPC_URL`,
`OPENROUTER_API_KEY`, `TENDERLY_*` — silently **skip or fail** with an "env not set"
error when those vars are unexported. Source `client/.env`, **then unset
`JINN_PASSWORD`**, before every local invocation:

```bash
cd client
set -a && . ./.env && set +a          # export the secrets the runners need
unset JINN_PASSWORD                    # MUST unset — see warning below

# Run all of Tier 1 against the current working tree
tsx scripts/release/run-tier-1.ts <candidate-version>
# Or via yarn
yarn release:tier-1 <candidate-version>
```

> **Why `unset JINN_PASSWORD`:** Tier 2 / Tier 3 spawn operator daemons against the
> test substrate (`~/jinn-dev/operators/`). Each substrate operator carries its own
> `.jinn-client/keystore-password` file. An inherited `JINN_PASSWORD` overrides that
> file, fails keystore decryption, and the daemon exits with `exitCode 50` before
> its API is reachable — surfacing as a misleading "daemon did not become reachable"
> `real-bug` verdict on T2.1/T2.3. `client/.env` carries the *developer's own*
> `JINN_PASSWORD`, so a blind `. ./.env` poisons every substrate scenario. Unset it.

In CI the secrets are injected as GitHub Actions env vars, so the `.env` step is a
no-op there (the file is absent) — it is only needed for local release-prep runs.

## Tier 1 scenarios

Detailed contracts: [`references/tier-1-scenarios.md`](references/tier-1-scenarios.md)

| ID | Name | Wall-clock budget |
|---|---|---|
| T1.1 | bootstrap-fresh-anvil | 90s |
| T1.2 | harness-readiness-contract | 30s |
| T1.3 | indexer-round-trip | 60s |
| T1.4 | SPA route smoke | 30s |

All four run in parallel. Wall-clock for the tier ≈ max of the budgets (~90s).

## Tier 2 scenarios

Detailed contracts: [`references/tier-2-scenarios.md`](references/tier-2-scenarios.md)

| ID | Name | Wall-clock budget |
|---|---|---|
| T2.1 | cross-operator-donation | 5min |
| T2.2 | producer-evaluator-anvil-fork | 5min |
| T2.3 | multi-op-spa-flow | 5min |

All three run in parallel against separate substrate workspaces. Wall-clock for the tier ≈ max of the budgets (~5min).

Tier 2 is invoked from release-readiness's Phase 5 (per spec §4). Standalone invocation:

```bash
set -a && . ./client/.env && set +a && unset JINN_PASSWORD   # see "How to invoke"
yarn release:tier-2 <candidate-version>
```

## Failure classification

[`references/failure-classification.md`](references/failure-classification.md)

## Evidence format

[`references/evidence-format.md`](references/evidence-format.md)

## What this skill does NOT do

- Decide ship/no-ship (release-readiness)
- Triage gaps as blocking-vs-deferrable (release-readiness)
- Run Tier 3 (release-readiness)
- Modify the candidate branch in any way (read-only)
