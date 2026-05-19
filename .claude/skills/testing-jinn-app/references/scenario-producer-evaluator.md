# Scenario T2.2 — Producer/evaluator (Anvil-fork)

**Tier:** 2 (substrate-derived workspace, Anvil-fork, runs in release-prep)
**Wall-clock budget:** 5 minutes
**Catches:** claim → solve → deliver → evaluate loop regressions; activity-counter increments; verdict pipeline end-to-end mechanically.

## Goal

op-a posts a known-solvable SWE-rebench v2 task, claims it, solves it via a *stubbed harness* (deterministic cached solution), delivers; op-b claims the verdict request, evaluates via real evaluator Docker image, posts verdict. Assert verdictCode matches expected.

This is the Anvil-fork mechanical counterpart to Tier 3's real-testnet variant. Same loop, but stubbed harness (no real OpenRouter spend) and forked chain.

## Implementation location

`client/test/release/tier-2/T2.2-producer-evaluator-fork.ts`

## Setup

- substrate workspace via `copyWorkspace({ ops: ['op-a', 'op-b'] })`
- Anvil fork of Base Sepolia at the substrate's last-known-good block; impersonate proxy owner; upgrade JinnRouter to V3 inline (existing pattern in `client/test/e2e/task-first-helpers.ts`)
- op-a config: `roles: ['solving']` for swe-rebench-v2 SolverNet
- op-b config: `roles: ['evaluating']` for same SolverNet
- Harness stub: register a fake harness that returns a canned solution for the known-instance task (so no real OpenRouter call happens)

## Steps

```typescript
import { spawnAnvilFork } from '../_support/chain/anvil';   // base-fork helper
import { baseSepolia } from 'viem/chains';

const workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
const anvil = await spawnAnvilFork({
  forkUrl: process.env['BASE_SEPOLIA_RPC_URL']!,
  chain: baseSepolia,
  silent: true,
});
const daemons = await spawnMultiOpDaemons({
  ops: [
    { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
    { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
  ],
  // JINN_RPC_URL — not BASE_RPC_URL — because config.ts gives JINN_RPC_URL
  // unconditional precedence; the spawn helper surfaces extraEnv RPC keys
  // through JINN_RPC_URL so this works either way, but using JINN_RPC_URL
  // here makes the precedence explicit.
  extraEnv: { JINN_RPC_URL: anvil.rpcUrl, JINN_HARNESS_STUB_INSTANCE: KNOWN_INSTANCE_ID },
});

// 1. op-a posts a known-solvable task
const postRes = await fetch(`http://127.0.0.1:7732/v1/tasks`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    solverType: 'swe-rebench-v2.v1',
    spec: { instanceId: KNOWN_INSTANCE_ID, repo: KNOWN_REPO, commit: KNOWN_COMMIT },
  }),
});
const { taskId, requestId } = await postRes.json();

// 2. Wait for op-a to claim + solve + deliver (auto via solving role)
const delivered = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:7732/v1/tasks/${taskId}`);
  const body = await res.json();
  return body.state === 'DELIVERED' ? body : null;
}, { timeoutMs: 90000, intervalMs: 2000 });
expect(delivered.deliveryTxHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

// 3. Wait for op-b to claim verdict request + run evaluator + post verdict
const verdict = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:7733/v1/verdicts?taskId=${taskId}`);
  const body = await res.json();
  return body.verdicts?.length > 0 ? body.verdicts[0] : null;
}, { timeoutMs: 120000, intervalMs: 2000 });

// 4. Assertions
expect(verdict.verdictCode).toBe(KNOWN_EXPECTED_VERDICT);   // 1 if patch applies + tests pass
expect(verdict.verdictTxHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

// 5. Activity counters incremented
const opAActivity = await fetch(`http://127.0.0.1:7732/v1/activity`).then(r => r.json());
expect(opAActivity.deliveriesCount).toBeGreaterThan(0);
const opBActivity = await fetch(`http://127.0.0.1:7733/v1/activity`).then(r => r.json());
expect(opBActivity.verdictsCount).toBeGreaterThan(0);

// 6. Cleanup
await daemons.teardown();
await anvil.teardown();
await workspace.teardown();
```

## Assertions (summary)

| # | Assertion | Why |
|---|---|---|
| A1 | Task post returns valid taskId + requestId | task admission works |
| A2 | op-a delivers within 90s | producer side: claim + stubbed solve + deliver loop closes |
| A3 | delivery has a valid tx hash | on-chain delivery succeeded |
| A4 | op-b posts verdict within 120s of delivery | evaluator side: claim + eval + verdict loop closes |
| A5 | verdictCode matches KNOWN_EXPECTED_VERDICT | substrate recheck + scoring is correct |
| A6 | op-a deliveriesCount incremented | activity-counter accounting works |
| A7 | op-b verdictsCount incremented | activity-counter accounting works |

## Stubbed harness

Activated via `JINN_HARNESS_STUB_INSTANCE=<instance-id>` env var. The stub:
- Pattern-matches on instance ID; only stubs the one we're testing.
- Returns a canned patch from `client/test/release/tier-2/fixtures/<instance-id>.patch`.
- Logs that it stubbed (so a real-harness-still-invoked regression would show absent stub logs).

This avoids the ~$0.10 API call per run while exercising the rest of the loop.

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| Task post returns 4xx | real-bug | BLOCKING — admission gate broken |
| op-a never delivers within 90s | could be: harness stub not picked up; daemon misconfig; chain stall | inspect logs; flake on first, real-bug on retry |
| Delivery tx revert | real-bug | BLOCKING — JinnRouter regression |
| op-b never picks up verdict request | real-bug | BLOCKING — evaluator role inactive |
| Evaluator Docker fails to run | flake-infra (Docker daemon) or real-bug (image broken) | check `docker ps`; retry |
| verdictCode mismatches expected | real-bug | BLOCKING — substrate/scoring regression |
| Activity counter not incremented | real-bug | BLOCKING — accounting regression |

## Wall-clock

~5 minutes:
- 30s daemon spawn + Anvil fork
- 90s producer loop
- 120s evaluator loop
- 30s setup/teardown

## Dependencies

- Substrate workspace from Plan A
- Existing `spawnAnvilFork` helper at `client/test/_support/chain/anvil.ts`. Pass `forkUrl: BASE_SEPOLIA_RPC_URL` and `chain: baseSepolia` for a Base Sepolia fork (no convenience wrapper today). Teardown via `harness.teardown()`. The full Task-First fork runner at `client/test/e2e/task-first-helpers.ts` (`runBaseSepoliaForkTaskFirstFullLoop`) shows the JinnRouter V3 fork-upgrade pattern.
- Existing JinnRouter V3 fork-upgrade pattern (in `client/test/e2e/task-first-helpers.ts`)
- Stubbed harness registration mechanism — to be added or extended in Plan C/D if not present
- KNOWN_INSTANCE_ID, KNOWN_REPO, KNOWN_COMMIT, KNOWN_EXPECTED_VERDICT — fixture constants for a known-solvable SWE-rebench instance (existing pattern in `client/test/release/tier-2/fixtures/`)

## What this scenario does NOT catch

- Real OpenRouter API behavior (Tier 3 covers that)
- Real RPC behavior under load (this uses Anvil; Tier 3 uses real testnet)
- Cross-chain verdict flows
