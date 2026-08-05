# `client/scripts/release/`

Mechanical gate-runners and substrate lifecycle scripts. Invoked by the `release-prep` skill (see `.claude/skills/release-prep/SKILL.md`) and by CI on every stable publish.

Spec: `docs/superpowers/specs/2026-05-19-release-readiness-and-substrate-design.md`.

## Substrate lifecycle

Operations on the test-operator substrate at `~/jinn-dev/operators/`.

### substrate-adopt

Copy an existing operator state dir into the gold substrate. One operator at a time.

```bash
yarn substrate:adopt \
  --from ~/.jinn-client/ \
  --as op-a \
  --role launcher \
  --shape current \
  --apiPort 7332
```

Excludes `engine/`, `*.log`, `jinn.db.bak*`, `config.before*`, `config.json.pre*`, `daemon-*`, `run-*` from the copy. Writes `manifest.json` with identity captured from `earning/earning_state.json`.

### substrate-copy

Per-run workspace copy from gold. Returns a JSON handle with `runId`, `workspaceRoot`, and `opPaths`.

```bash
yarn substrate:copy op-a op-b
```

The workspace lives at `~/jinn-dev/workspaces/<run-id>/`. Caller is responsible for teardown — or use `reapWorkspaces()` to garbage-collect.

### substrate-verify

Manifest schema check plus on-chain identity verification.

```bash
yarn substrate:verify op-a
yarn substrate:verify op-a --skip-on-chain
```

Exits non-zero on any failure. JSON result on stdout includes `failures`, `warnings`, and `onChain` snapshot.

### substrate-topup

Reports low balances on substrate operators. Does not auto-drip; surfaces gaps for manual top-up via faucet or release-bot wallet.

```bash
yarn substrate:topup op-a
```

Targets: 0.005 ETH master, 1.00 USDC safe. Exits non-zero if any below threshold.

### substrate-reap

Garbage-collects workspaces older than 7 days under `~/jinn-dev/workspaces/`.

```bash
yarn substrate:reap
```

Safe to run any time. JSON result on stdout shows `reaped` and `kept` workspace names.

## Tier 1 orchestrator

`run-tier-1.ts` runs all four Tier 1 scenarios in parallel and emits a structured verdict.

```bash
yarn release:tier-1 <candidate-version>
```

Output goes to `tier-1-evidence/<timestamp>/` with `summary.json`, `marker.txt`, and per-scenario `.log` files.

Per-scenario standalone invocations:

```bash
yarn release:tier-1:T1.1    # bootstrap-fresh-anvil
yarn release:tier-1:T1.2    # harness-readiness-contract
yarn release:tier-1:T1.3    # contract conformance (boot-less)
yarn release:tier-1:T1.4    # SPA route smoke
```

Exit codes:
- `0` — all scenarios passed (or only failed with non-`real-bug` classes / skipped)
- `1` — at least one `verdict=fail` with `failClass=real-bug`
- `2` — internal orchestrator error

## Tier 3 orchestrator

`run-tier-3.ts` runs the single Tier 3 scenario (T3.1 producer-evaluator-real) against the real Base Sepolia testnet. **This spends real test ETH + real OpenRouter API budget (~$0.10).** Only run when intentional.

```bash
yarn release:tier-3 <candidate-version>
```

Output goes to `tier-3-evidence/<timestamp>/`.

Per-scenario standalone (gated on `JINN_T31_REAL=1`):

```bash
yarn release:tier-3:T3.1
```

## release-readiness skill

The audit + triage + closure + handoff meta-skill. Invoked from a Claude Code session:

```bash
# Skill release-readiness --candidateVersion v0.1.7 --mode human-invoked
```

See `.claude/skills/release-readiness/SKILL.md` for the full skill contract.

## Programmatic API

Each substrate script exports its core function:

```typescript
import { adoptOperator } from 'client/scripts/release/substrate-adopt';
import { copyWorkspace } from 'client/scripts/release/substrate-copy';
import { verifySubstrate } from 'client/scripts/release/substrate-verify';
import { checkSubstrateTopup } from 'client/scripts/release/substrate-topup';
import { reapWorkspaces } from 'client/scripts/release/substrate-reap';
```

The Tier 1 orchestrator exports `runTier1()`:

```typescript
import { runTier1 } from 'client/scripts/release/run-tier-1';
```

## Files

| Path | Responsibility |
|---|---|
| `types.ts` | Manifest Zod schema + `Manifest` TS type |
| `substrate-paths.ts` | Path helpers (gold path, workspace path, run-id generation) |
| `substrate-adopt.ts` | Copy from existing operator dir → gold |
| `substrate-copy.ts` | Per-run workspace copy from gold |
| `substrate-verify.ts` | Manifest validation + on-chain identity check |
| `substrate-topup.ts` | Balance gap surfacing |
| `substrate-reap.ts` | Workspace garbage collection |
| `scenario-types.ts` | `ScenarioVerdict`, `FailClass`, `ScenarioOptions` + `classifyFailure` |
| `run-tier-1.ts` | Tier 1 orchestrator |
| `README.md` | This file |

## Failure modes

| Operation | Failure | Recovery |
|---|---|---|
| substrate-adopt | source dir missing earning_state.json | fix source state or pick a different source |
| substrate-verify | manifest schema mismatch | re-adopt (substrate may have changed shape) |
| substrate-verify | on-chain agentId doesn't match safeAddress | substrate is stale; investigate |
| substrate-verify | master ETH balance too low | run substrate-topup; fund manually |
| substrate-copy | requested op not in gold | run substrate-adopt for that op first |
| substrate-topup | low balance | fund manually from release-bot wallet |
| substrate-reap | none expected — idempotent | n/a |
| run-tier-1 | scenario crashes | check per-scenario log under `tier-1-evidence/<timestamp>/` |
