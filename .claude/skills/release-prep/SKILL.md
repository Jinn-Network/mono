# release-prep

> **SUPERSEDED — historical / reference only.** Per the two-gate redesign
> (`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md` §12),
> release-prep's mechanical run-role is **retired** — release validation now runs
> in CI, not on a laptop. Do not invoke this skill to gate a release. Use:
>
> - **`.github/workflows/hermetic-gate.yml`** — deterministic, per-PR; posts the
>   `hermetic-gate` check-run (was Tier 1 + parts of Tier 2/3).
> - **`.github/workflows/environment-suite.yml`** — real testnet, gates the cut;
>   posts the `environment-suite` check-run (was the real `yarn e2e` phases +
>   Tier 2 cross-op + Tier 3).
>
> `release-readiness` orchestrates: it dispatches `environment-suite.yml` on the
> candidate SHA and reads the two SHA-bound check-runs — it no longer invokes
> release-prep. The Tier 1/2/3 ladder and the hand-typed marker are retired
> (the publish guard verifies the two check-runs instead, spec §7).
>
> **Where the substrate helpers went:** the only living value here is the
> substrate/operator-provisioning tooling this skill once drove. Per spec §12 it
> is repurposed into **warm-operator lifecycle tooling** that serves
> `environment-suite.yml` — keeping the dedicated, pre-staked testnet warm
> operator (spec §11) healthy, funded, and its `CLAUDE_CODE_OAUTH_TOKEN` fresh.

---

The text below documents the retired mechanical run-role for historical reference.

Mechanical gate-runner skill. Runs Tier 1 (and eventually Tier 2) scenarios against a candidate branch, classifies failures, emits a marker block ready to paste into a GitHub Release body.

This skill is *not* the audit layer — that's `release-readiness`. release-prep runs gates and reports; it doesn't decide blocking vs deferrable. release-readiness invokes release-prep as a subagent.

## When to use

> Retired — see the superseded banner above. The two CI workflows replace every
> bullet below.

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

The tier runners execute under plain `tsx` and do **not** auto-load `operator/.env`.
Scenarios that need secrets — `BASE_SEPOLIA_RPC_URL` (T2.1, T2.3), `BASE_RPC_URL`,
`OPENROUTER_API_KEY`, `TENDERLY_*` — silently **skip or fail** with an "env not set"
error when those vars are unexported. Source `operator/.env`, **then unset
`JINN_PASSWORD`**, before every local invocation:

```bash
cd operator
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
> `real-bug` verdict on T2.1/T2.3. `operator/.env` carries the *developer's own*
> `JINN_PASSWORD`, so a blind `. ./.env` poisons every substrate scenario. Unset it.

In CI the secrets are injected as GitHub Actions env vars, so the `.env` step is a
no-op there (the file is absent) — it is only needed for local release-prep runs.

## Tier 1 scenarios

Detailed contracts: [`references/tier-1-scenarios.md`](references/tier-1-scenarios.md)

| ID | Name | Wall-clock budget |
|---|---|---|
| T1.1 | bootstrap-fresh-anvil | 90s |
| T1.2 | harness-readiness-contract | 30s |
| T1.4 | SPA route smoke | 30s |

All three run in parallel. Wall-clock for the tier ≈ max of the budgets (~90s).

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
