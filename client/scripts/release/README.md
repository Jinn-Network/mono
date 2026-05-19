# Substrate scripts

Lifecycle scripts for the test-operator substrate at `~/jinn-dev/operators/`.
Spec: `docs/superpowers/specs/2026-05-19-release-readiness-and-substrate-design.md`.

## Operations

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

The workspace lives at `~/jinn-dev/workspaces/<run-id>/`. Caller is responsible for teardown (`rm -rf $workspaceRoot`) — or use `reapWorkspaces()` to garbage-collect.

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

## Programmatic API

Each script exports its core function for use from other scripts or skills:

```typescript
import { adoptOperator } from 'client/scripts/release/substrate-adopt';
import { copyWorkspace } from 'client/scripts/release/substrate-copy';
import { verifySubstrate } from 'client/scripts/release/substrate-verify';
import { checkSubstrateTopup } from 'client/scripts/release/substrate-topup';
import { reapWorkspaces } from 'client/scripts/release/substrate-reap';
```

## Manifest schema

See `types.ts` for the Zod schema and `Manifest` TypeScript type.

## Failure modes

| Operation | Failure | Recovery |
|---|---|---|
| adopt | source dir missing earning_state.json | fix source state or pick a different source |
| verify | manifest schema mismatch | re-adopt (substrate may have changed shape) |
| verify | on-chain agentId doesn't match safeAddress | substrate is stale; investigate |
| verify | master ETH balance too low | run substrate-topup; fund manually |
| copy | requested op not in gold | run substrate-adopt for that op first |
| topup | low balance | fund manually from release-bot wallet |
| reap | none expected — idempotent | n/a |
