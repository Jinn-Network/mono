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

```bash
# Run all of Tier 1 against the current working tree
cd client && tsx scripts/release/run-tier-1.ts <candidate-version>

# Or via yarn
yarn release:tier-1 <candidate-version>
```

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

Detailed contracts: [`references/tier-2-scenarios.md`](references/tier-2-scenarios.md) (placeholder; expanded by Plan D)

Tier 2 implementations land in Plan D. release-prep's runner will be extended at that point to call a `run-tier-2.ts` orchestrator alongside `run-tier-1.ts`.

## Failure classification

[`references/failure-classification.md`](references/failure-classification.md)

## Evidence format

[`references/evidence-format.md`](references/evidence-format.md)

## What this skill does NOT do

- Decide ship/no-ship (release-readiness)
- Triage gaps as blocking-vs-deferrable (release-readiness)
- Run Tier 3 (release-readiness)
- Modify the candidate branch in any way (read-only)
