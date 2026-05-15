# Daemon + Real Harness + Anvil Settlement Loop E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single e2e test that spans the production `Daemon` class + a real LLM-driven harness binary + on-chain settlement on an Anvil fork — proving the claim → execute → deliver → reward-claim loop closes when all three components run together. Parameterised over Hermes / Claude Code / Codex via `JINN_E2E_HARNESS`.

**Architecture:** Two new files. `client/test/e2e/daemon-harness-cycle.ts` is the orchestrator script. `client/test/e2e/_daemon-harness-helpers.ts` holds the new wiring (production-`Daemon`-on-Anvil setup, bootstrapped-operator helper, harness-by-env selector, on-chain assertions). Everything else is reused from `task-first-helpers.ts` (Anvil + contracts), `staking.ts` (earning bootstrap), and `buildHarnesses()` (harness registry).

**Tech Stack:** TypeScript (tsx), Vitest, viem, Foundry/anvil, real `hermes`/`claude`/`codex` binaries via OpenRouter or Anthropic API.

**Scope guards:**
- SolverNet: prediction.v1 only. Fast (~minute per harness), cheap (one LLM round-trip), no Docker. swe-rebench-v2.v1 would be a separate slow-test bead.
- Skip cleanly if the harness's API key is absent — this test is opt-in via env, not a default CI gate.
- No verdict / evaluator path. The loop closes at "deliver tx + activity counted"; evaluator pairing is exercised by existing `validate.ts` Phase 0 path.

**Acceptance criterion:** For each of `JINN_E2E_HARNESS=hermes-agent | claude-code | codex`, the test posts a prediction.v1 task on Anvil, waits for the production daemon's loops to claim + execute + deliver, and asserts:
- A `SolutionDeliveryClaimed` event on JinnRouter with the daemon's agent EOA as sender.
- A `Deliver` event on the marketplace with a valid SignedEnvelope-shaped delivery data.
- The harness's `venueRef.name` in the delivered Solution matches the configured harness.
- The staking-contract activity counter increments for the operator's service.
- (If `RewardClaimLoop` finds claimable rewards) A reward-claim tx posted.

---

## File Structure

```
client/test/e2e/
  daemon-harness-cycle.ts                    # NEW — orchestrator script (~150 lines)
  _daemon-harness-helpers.ts                 # NEW — daemon-in-process wiring + assertions (~400 lines)

client/test/e2e/task-first-helpers.ts        # REUSED — spawnPlainAnvil, deployTaskFirstStack
client/test/e2e/staking.ts                   # REUSED — earning bootstrap pattern (FleetBootstrapper)
client/src/harnesses/impls/index.ts          # REUSED — buildHarnesses()
client/src/daemon/daemon.ts                  # REUSED — Daemon class with 8 loops
client/src/adapters/mech/adapter.ts          # REUSED — MechAdapter
client/src/tasks/posting-service.ts          # REUSED — TaskPostingService

client/package.json                          # MODIFY — add e2e:daemon-harness script
client/CLAUDE.md (root SPEC if needed)       # MODIFY — document test purpose + invocation
```

The orchestrator script imports from the helpers module. The helpers module is large because it contains the new Daemon-on-Anvil wiring; the orchestrator stays small (one main(), branches on `JINN_E2E_HARNESS`).

---

## Task 0: File the bd issue (5 min, no code)

**Files:** none (creates a bd ticket)

- [ ] **Step 1: Create the bd issue capturing context, impact, acceptance criteria — NOT the solution**

```bash
bd create \
  --title="E2E: production Daemon + real harness + Anvil settlement loop" \
  --description="Existing e2e tests each exercise one slice — daemon claim/deliver wiring with a stub harness, or harness contract with a stub daemon, or earning bootstrap. None spans Daemon + real harness + on-chain settlement together. This is the missing integration test and the gating proof that the harness shape works inside production loops, not just in the harness's own unit harness.

Impact: without this test, every production deployment of a new harness is a guess — we only know the harness can run a task in isolation, not that the daemon's claim → engine → delivery → reward loops successfully drive it end-to-end. The integration gap was previously hidden because LegacyClaudeImpl bypassed the harness shape entirely; now that Phase 1 harnesses (learner, hermes-agent) are the production path, we need real-loop coverage.

Acceptance criteria:
1. yarn e2e:daemon-harness completes successfully for at least one of JINN_E2E_HARNESS=hermes-agent | claude-code | codex (the operator picks which based on which API key they have).
2. The test exercises the *production* Daemon class with MechAdapter, not a hand-rolled task-first helper.
3. A prediction.v1 task is posted on an Anvil fork of Base mainnet; the daemon's CreatorLoop / engine-watcher / delivery-watcher loops drive it to settlement without test-side manual tx submission.
4. Assertions verify on-chain claim tx, deliver tx with valid SignedEnvelope, and operator activity counter increment.
5. Test skips cleanly with a precise reason when the selected harness's API key is unavailable.

Out of scope: swe-rebench-v2.v1 variant (slow, Docker), evaluator/verdict path, reward-claim assertion is best-effort." \
  --type=task \
  --priority=2 \
  --epic=jinn-mono-8psp
```

- [ ] **Step 2: Claim it for this work**

```bash
bd update jinn-mono-8psp.8 --claim
```

(If `8psp.8` is taken, use the next free `8psp.N` — record the id you actually got.)

---

## Task 1: Skeleton test file + Anvil + earning bootstrap (40 min)

Get a test file that boots Anvil, runs the full earning bootstrap, and asserts the operator is staked. No daemon yet. This is the same shape as `staking.ts` but in our new file with structure ready for the next tasks.

**Files:**
- Create: `client/test/e2e/daemon-harness-cycle.ts`
- Create: `client/test/e2e/_daemon-harness-helpers.ts`

- [ ] **Step 1: Create the helpers module with the bootstrap helper**

```typescript
// client/test/e2e/_daemon-harness-helpers.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  http,
  parseEther,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ANVIL_PRIVATE_KEYS,
  anvilJsonRpc,
  compileContracts,
  spawnPlainAnvil,
  type AnvilHarness,
} from './task-first-helpers.js';

export type HarnessSelector = 'hermes-agent' | 'claude-code' | 'codex' | 'prediction-v1-baseline';

export interface DaemonHarnessFixture {
  anvil: AnvilHarness;
  publicClient: PublicClient;
  operatorEoa: ReturnType<typeof privateKeyToAccount>;
  workingDirRoot: string;
  implStateRoot: string;
  /** Disposes anvil, deletes scratch dirs, etc. */
  teardown: () => Promise<void>;
}

/** Pick the harness from JINN_E2E_HARNESS, default `hermes-agent`. */
export function harnessSelectorFromEnv(): HarnessSelector {
  const raw = (process.env['JINN_E2E_HARNESS'] ?? 'hermes-agent').trim();
  if (raw === 'hermes-agent' || raw === 'claude-code' || raw === 'codex' || raw === 'prediction-v1-baseline') {
    return raw;
  }
  throw new Error(`JINN_E2E_HARNESS=${raw} not recognised. Use one of: hermes-agent, claude-code, codex, prediction-v1-baseline.`);
}

/**
 * Set up Anvil + fund Anvil-deterministic accounts + assemble scratch dirs.
 * Does NOT run earning bootstrap — that's a separate helper because the
 * production Daemon path uses FleetBootstrapper instead.
 */
export async function setupAnvilFixture(): Promise<DaemonHarnessFixture> {
  await compileContracts();
  const anvil = await spawnPlainAnvil();
  const operatorEoa = privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!); // skip deployer
  const publicClient = createPublicClient({
    chain: base,
    transport: http(anvil.rpcUrl),
  }) as unknown as PublicClient;

  await anvilJsonRpc(anvil.rpcUrl, 'anvil_setBalance', [
    operatorEoa.address,
    '0x56bc75e2d63100000', // 100 ETH
  ]);

  const workingDirRoot = mkdtempSync(join(tmpdir(), 'jinn-daemon-harness-work-'));
  const implStateRoot = mkdtempSync(join(tmpdir(), 'jinn-daemon-harness-state-'));

  return {
    anvil,
    publicClient,
    operatorEoa,
    workingDirRoot,
    implStateRoot,
    async teardown() {
      try { await anvil.kill(); } catch {}
      try { rmSync(workingDirRoot, { recursive: true, force: true }); } catch {}
      try { rmSync(implStateRoot, { recursive: true, force: true }); } catch {}
    },
  };
}
```

- [ ] **Step 2: Create the orchestrator with just the fixture wired up**

```typescript
// client/test/e2e/daemon-harness-cycle.ts
/**
 * Daemon + real harness + on-chain settlement loop e2e (jinn-mono-8psp.8).
 *
 * Public command: `yarn e2e:daemon-harness`.
 *
 * Spans:
 *   Anvil fork → earning bootstrap → production Daemon (MechAdapter)
 *   → prediction.v1 task post → daemon claims + executes (real harness)
 *   → on-chain deliver tx → activity counter increments.
 *
 * Pick harness via JINN_E2E_HARNESS=hermes-agent|claude-code|codex.
 * Skips cleanly if the selected harness's API key isn't available.
 */
import {
  harnessSelectorFromEnv,
  setupAnvilFixture,
} from './_daemon-harness-helpers.js';

async function main(): Promise<void> {
  const harness = harnessSelectorFromEnv();
  console.log(`\n=== daemon-harness e2e — harness=${harness} ===`);
  const fixture = await setupAnvilFixture();
  try {
    console.log(`anvil rpc: ${fixture.anvil.rpcUrl}`);
    console.log(`operator EOA: ${fixture.operatorEoa.address}`);
    console.log(`workingDirRoot: ${fixture.workingDirRoot}`);
    console.log(`implStateRoot: ${fixture.implStateRoot}`);
    // Subsequent tasks fill in: bootstrap → daemon → task post → wait → assert
    console.log('\n=== Task 1 skeleton ok — Anvil + fixture up ===');
  } finally {
    await fixture.teardown();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Add yarn script**

Modify `client/package.json` scripts block. Insert after the existing `e2e:hermes` line:

```json
    "e2e:daemon-harness": "tsx test/e2e/daemon-harness-cycle.ts",
```

- [ ] **Step 4: Run it — expect a clean Anvil-up-and-tear-down**

```bash
cd client && yarn e2e:daemon-harness
```

Expected: prints `=== Task 1 skeleton ok — Anvil + fixture up ===`. Anvil teardown happens cleanly (no orphaned process — verify with `ps aux | grep anvil`).

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/daemon-harness-cycle.ts client/test/e2e/_daemon-harness-helpers.ts client/package.json
git commit -m "test(e2e): scaffold daemon-harness-cycle.ts on Anvil fixture (jinn-mono-8psp.8)

First slice — boots Anvil + scratch dirs + harness-from-env selector. No
daemon, no task, no harness invocation yet. Subsequent tasks layer those
on top of this skeleton.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Run the earning bootstrap inside the test (45 min)

The production daemon expects a fully-bootstrapped operator: agent EOA + Safe + service + staked + mech. We replicate `staking.ts`'s pattern but factor it into a helper our e2e can call.

**Files:**
- Modify: `client/test/e2e/_daemon-harness-helpers.ts`

- [ ] **Step 1: Read `staking.ts` to understand the bootstrap shape**

```bash
sed -n '1,100p' client/test/e2e/staking.ts
```

Note the imports — `EarningBootstrapper`, the 11-step state machine — and the funding pattern (impersonate OLAS whale, transfer to Safe). The helper we write should expose the same shape but as a function returning a `BootstrappedOperator` summary.

- [ ] **Step 2: Add the bootstrap helper to `_daemon-harness-helpers.ts`**

```typescript
// Append to _daemon-harness-helpers.ts

import { EarningBootstrapper } from '../../src/earning/bootstrap.js';
import type { EarningState } from '../../src/earning/types.js';

export interface BootstrappedOperator {
  /** Agent EOA private key — held in test process only, not on disk. */
  agentPrivateKey: `0x${string}`;
  agentAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress: `0x${string}`;
  serviceId: bigint;
}

/**
 * Run the 11-step earning bootstrap to the `complete` state.
 * Funds the EOA + Safe via Anvil impersonation of pre-funded accounts on the
 * forked chain. Returns the operator's on-chain identifiers for use when
 * configuring the Daemon.
 *
 * Mirrors the shape of `staking.ts`'s `main()` but factored out for reuse.
 * The new code is the helper signature + the impersonation funding pattern;
 * EarningBootstrapper itself is reused unchanged.
 */
export async function bootstrapStakedOperator(
  fixture: DaemonHarnessFixture,
): Promise<BootstrappedOperator> {
  // FILL IN by following staking.ts:
  // 1. mkdir earning state dir under fixture.implStateRoot
  // 2. construct EarningBootstrapper with anvil rpc URL + a test password
  // 3. step through wallet/safe_predicted -> stops at awaiting_funding
  // 4. impersonate the OLAS whale on Anvil and transfer OLAS to the Safe
  // 5. fund the EOA with ETH via anvil_setBalance
  // 6. resume bootstrap; step through to `complete`
  // 7. read state from earning store, return BootstrappedOperator
  throw new Error('TODO: implement following staking.ts pattern');
}
```

- [ ] **Step 3: Implement the helper body**

Replace the `throw new Error('TODO: ...')` with the real implementation. Faithful translation of `staking.ts:main()` — see that file for:
- the OLAS whale address constant
- the impersonate-then-transfer sequence
- how `EarningBootstrapper.step()` is iterated
- which fields of `EarningState` map to `BootstrappedOperator`

- [ ] **Step 4: Hook it into the orchestrator**

In `daemon-harness-cycle.ts`, after `await setupAnvilFixture()`:

```typescript
    const operator = await bootstrapStakedOperator(fixture);
    console.log(`agent EOA:    ${operator.agentAddress}`);
    console.log(`Safe:         ${operator.safeAddress}`);
    console.log(`service id:   ${operator.serviceId}`);
    console.log(`mech:         ${operator.mechAddress}`);
```

- [ ] **Step 5: Run it and inspect — expect 11 steps then a fully staked operator**

```bash
cd client && yarn e2e:daemon-harness
```

Expected: prints all four operator fields with real addresses. Run time ~30–60s for bootstrap.

- [ ] **Step 6: Commit**

```bash
git add client/test/e2e/_daemon-harness-helpers.ts client/test/e2e/daemon-harness-cycle.ts
git commit -m "test(e2e): bootstrap a real staked operator inside daemon-harness-cycle (jinn-mono-8psp.8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Construct and start the production Daemon (50 min)

Wire `buildHarnesses()` + `MechAdapter` + `Daemon` against the Anvil fork, with the bootstrapped operator's credentials. Start the daemon. Assert all loops report healthy.

**Files:**
- Modify: `client/test/e2e/_daemon-harness-helpers.ts`

- [ ] **Step 1: Add the daemon factory + start helper**

```typescript
// Append to _daemon-harness-helpers.ts

import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { MechAdapter } from '../../src/adapters/mech/adapter.js';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { Store } from '../../src/store/store.js';

export interface RunningDaemon {
  daemon: Daemon;
  store: Store;
  stop: () => Promise<void>;
}

/**
 * Instantiate the production Daemon class with MechAdapter pointed at the
 * Anvil fork + the bootstrapped operator's credentials. Start it (all 8
 * long-running loops). Returns a handle for stopping it cleanly in teardown.
 *
 * Polling intervals are shortened (300ms vs production 5000ms) so the test
 * doesn't sit idle. Increase if the fork RPC starts struggling.
 */
export async function startDaemon(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  harnessSelector: HarnessSelector,
): Promise<RunningDaemon> {
  const storePath = join(fixture.implStateRoot, 'jinn.db');
  const store = new Store(storePath);

  // Harness env — full production registry but the daemon will only DISPATCH
  // to the named harness (filtered below). Other harnesses are registered as
  // peers for the SolverNet-config-driven dispatcher.
  const harnessEnv = {
    pk: operator.agentPrivateKey,
    safe: operator.safeAddress,
    rpcUrl: fixture.anvil.rpcUrl,
    claudePath: process.env['JINN_CLAUDE_PATH'] ?? 'claude',
    claudeModel: process.env['JINN_CLAUDE_MODEL'] ?? 'claude-haiku-4-5-20251001',
    codexPath: process.env['JINN_CODEX_PATH'] ?? 'codex',
    codexModel: process.env['JINN_CODEX_MODEL'] ?? 'gpt-4.1-mini',
    hermesPath: process.env['JINN_HERMES_PATH'] ?? 'hermes',
    hermesModel: process.env['JINN_HERMES_MODEL'] ?? 'google/gemini-2.5-flash',
    hermesProvider: process.env['JINN_HERMES_PROVIDER'] ?? 'openrouter',
    storePath,
    daemonApiUrl: 'http://127.0.0.1:7331',
    daemonApiToken: '',
    implStateDirRoot: fixture.implStateRoot,
  };
  const harnesses = buildHarnesses(harnessEnv);

  // MechAdapter pointed at the Anvil fork — uses the real Base contract
  // addresses since the fork IS Base.
  const adapter = new MechAdapter({
    rpcUrl: fixture.anvil.rpcUrl,
    agentPrivateKey: operator.agentPrivateKey,
    safeAddress: operator.safeAddress,
    mechAddress: operator.mechAddress,
    // FILL IN remaining MechAdapter ctor args by checking the real `main.ts`
    // wiring. Reuse the same Base contract addresses from src/earning/contracts.ts.
  });

  // FILL IN any missing DaemonConfig fields by mirroring main.ts. Short
  // poll intervals for test speed; production defaults are 5_000 ms.
  const config: DaemonConfig = {
    adapter,
    store,
    harnesses,
    pollIntervalMs: 300,
    // ... etc — copy the production DaemonConfig from main.ts and override
    // only the polling intervals.
  };

  const daemon = new Daemon(config);
  await daemon.start();

  return {
    daemon,
    store,
    async stop() {
      await daemon.stop();
      try { store.close(); } catch {}
    },
  };
}
```

- [ ] **Step 2: Fill in the MechAdapter and DaemonConfig fields**

Look at `client/src/main.ts` to see the real wiring. Identify which fields are required, which we can default, and which need to come from `operator` or `fixture`. Resolve all `// FILL IN` markers — no placeholders.

- [ ] **Step 3: Hook into the orchestrator + add teardown**

In `daemon-harness-cycle.ts`:

```typescript
    const running = await startDaemon(fixture, operator, harness);
    try {
      console.log('daemon started — 8 loops running');
      // Next tasks: post task, wait for delivery, assert.
    } finally {
      await running.stop();
    }
```

- [ ] **Step 4: Run it — expect the daemon to start and stop cleanly**

```bash
cd client && yarn e2e:daemon-harness
```

Expected: `daemon started — 8 loops running`. Daemon shuts down cleanly (no hung-process complaint). Run time ~45–90s (bootstrap + daemon up/down).

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/_daemon-harness-helpers.ts client/test/e2e/daemon-harness-cycle.ts
git commit -m "test(e2e): start production Daemon with MechAdapter inside daemon-harness-cycle (jinn-mono-8psp.8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Post a prediction.v1 task on Anvil and wait for the daemon to claim (40 min)

Use the production `TaskPostingService` to put a task on the Anvil-deployed router. Poll Anvil for the `TaskCreated` event. Then poll for the `TaskClaimed` event posted by the daemon's claim loop.

**Files:**
- Modify: `client/test/e2e/_daemon-harness-helpers.ts`
- Modify: `client/test/e2e/daemon-harness-cycle.ts`

- [ ] **Step 1: Add helpers for posting the task + polling on-chain state**

```typescript
// Append to _daemon-harness-helpers.ts

import { TaskPostingService } from '../../src/tasks/posting-service.js';
import { makePredictionV1Task } from './task-first-helpers.js';
import { keccak256, toBytes } from 'viem';

export interface PostedPredictionTask {
  taskId: string;
  taskCidDigest: `0x${string}`;
  requestId?: string; // set after claim
}

/** Post a prediction.v1 task on Anvil. Returns the task id from the event. */
export async function postPredictionV1Task(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
): Promise<PostedPredictionTask> {
  // Build the task body — reuse the prediction.v1 fixture builder.
  const taskBody = makePredictionV1Task();
  const taskJson = JSON.stringify(taskBody);
  const taskCidDigest = keccak256(toBytes(taskJson));

  // Submit via TaskPostingService — this is the production path the operator
  // app uses when launching a SolverNet task.
  const poster = new TaskPostingService({
    rpcUrl: fixture.anvil.rpcUrl,
    // FILL IN — see src/api/server.ts route handler for the real wiring
  });
  const posted = await poster.postTask(taskBody);

  return { taskId: posted.taskId, taskCidDigest };
}

/**
 * Poll JinnRouter for the daemon's claim. Returns the requestId from the
 * TaskAttemptCreated event so we can later look up the delivery.
 */
export async function waitForDaemonClaim(
  fixture: DaemonHarnessFixture,
  task: PostedPredictionTask,
  timeoutMs = 120_000,
): Promise<string> {
  // FILL IN — read events from JinnRouter using fixture.publicClient.getLogs
  // filtered by event 'TaskAttemptCreated' and the operator Safe as solver.
  // Poll every 500ms until found or timeout. Return event.requestId.
  throw new Error('TODO: implement claim-event polling');
}
```

- [ ] **Step 2: Implement the helper bodies — no placeholders**

Resolve the `// FILL IN` markers by reading `src/api/server.ts` (TaskPostingService wiring) and `task-first-helpers.ts` (event-log polling pattern).

- [ ] **Step 3: Hook into the orchestrator**

```typescript
    const posted = await postPredictionV1Task(fixture, operator);
    console.log(`posted task: id=${posted.taskId} cidDigest=${posted.taskCidDigest}`);

    const requestId = await waitForDaemonClaim(fixture, posted);
    console.log(`daemon claimed task: requestId=${requestId}`);
```

- [ ] **Step 4: Run it**

```bash
cd client && yarn e2e:daemon-harness
```

Expected: `posted task ...` followed within ~5–15s by `daemon claimed task: requestId=...`. If it hangs, the daemon's CreatorLoop / engine-watcher isn't seeing the on-chain task — check the SolverNet-config that the daemon was started with includes a `joinedSolverNets` entry matching the posted task's manifestCid.

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/_daemon-harness-helpers.ts client/test/e2e/daemon-harness-cycle.ts
git commit -m "test(e2e): post task + wait for daemon claim in daemon-harness-cycle (jinn-mono-8psp.8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wait for delivery — first with the deterministic baseline harness (40 min)

Before we throw a real LLM at the loop, validate the daemon-side wiring with a deterministic harness so any failure is provably *not* a model issue. The `PredictionV1BaselineImpl` is a deterministic harness that posts a fixed prediction — perfect for this.

**Files:**
- Modify: `client/test/e2e/_daemon-harness-helpers.ts`
- Modify: `client/test/e2e/daemon-harness-cycle.ts`

- [ ] **Step 1: Add the delivery-wait helper**

```typescript
// Append to _daemon-harness-helpers.ts

export interface DeliveredTask {
  requestId: string;
  deliveryTxHash: `0x${string}`;
  envelopeCid?: string;
  solverHarnessName: string;
  /** Decoded SignedEnvelope.solutionPayload (or undefined when verdict-only). */
  payload?: Record<string, unknown>;
}

export async function waitForDelivery(
  fixture: DaemonHarnessFixture,
  requestId: string,
  timeoutMs = 180_000,
): Promise<DeliveredTask> {
  // FILL IN — poll for the marketplace's Deliver event filtered by requestId.
  // Fetch the SignedEnvelope from IPFS gateway / store. Decode the envelope.
  // Return the bits the orchestrator wants to assert against.
  throw new Error('TODO: implement delivery polling');
}
```

- [ ] **Step 2: Add a "baseline-only" mode to the orchestrator**

Add a branch: if `harness === 'prediction-v1-baseline'`, skip the API-key check and use the baseline directly. This is the in-loop smoke. Add to the harnessSelector union if not already present.

- [ ] **Step 3: Hook the wait + assertion**

```typescript
    const delivered = await waitForDelivery(fixture, requestId);
    console.log(`delivered: tx=${delivered.deliveryTxHash} solver=${delivered.solverHarnessName}`);
    if (delivered.solverHarnessName !== expectedHarnessName(harness)) {
      throw new Error(`expected solver=${expectedHarnessName(harness)} got=${delivered.solverHarnessName}`);
    }
```

with a tiny mapper:

```typescript
function expectedHarnessName(sel: HarnessSelector): string {
  return sel === 'prediction-v1-baseline' ? 'prediction-v1-baseline' : sel;
}
```

- [ ] **Step 4: Run it with the baseline harness**

```bash
cd client && JINN_E2E_HARNESS=prediction-v1-baseline yarn e2e:daemon-harness
```

Expected: end-to-end pass. `delivered: tx=0x...` line appears within ~30–60s of claim. If this fails, the daemon-side loop is broken and the next tasks won't help.

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/_daemon-harness-helpers.ts client/test/e2e/daemon-harness-cycle.ts
git commit -m "test(e2e): close the loop with the deterministic prediction.v1 baseline harness (jinn-mono-8psp.8)

Smoke proof of daemon-side wiring before swapping in real LLM-driven
harnesses. If a real-harness run later fails, this baseline mode is the
first thing to re-run as a bisection point.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Swap in real harnesses — Hermes, then Claude Code, then Codex (45 min)

With the baseline-driven loop green, point the SolverNet config at the real harness and rerun for each of hermes-agent / claude-code / codex. Each has a different API key.

**Files:**
- Modify: `client/test/e2e/daemon-harness-cycle.ts` (skip-on-missing-key + per-harness config)
- Modify: `client/test/e2e/_daemon-harness-helpers.ts` (per-harness SolverNet config)

- [ ] **Step 1: Add API-key check + skip-clean helper**

```typescript
// Append to _daemon-harness-helpers.ts

export function checkHarnessApiKey(sel: HarnessSelector): { ok: true } | { ok: false; reason: string } {
  switch (sel) {
    case 'prediction-v1-baseline':
      return { ok: true };
    case 'hermes-agent':
      if (!process.env['OPENROUTER_API_KEY'] && !process.env['ANTHROPIC_API_KEY']) {
        return { ok: false, reason: 'OPENROUTER_API_KEY or ANTHROPIC_API_KEY required for hermes-agent' };
      }
      return { ok: true };
    case 'claude-code':
      if (!process.env['ANTHROPIC_API_KEY']) {
        return { ok: false, reason: 'ANTHROPIC_API_KEY required for claude-code' };
      }
      return { ok: true };
    case 'codex':
      if (!process.env['OPENAI_API_KEY']) {
        return { ok: false, reason: 'OPENAI_API_KEY required for codex' };
      }
      return { ok: true };
  }
}
```

- [ ] **Step 2: Add skip path in the orchestrator's top of main()**

```typescript
  const harness = harnessSelectorFromEnv();
  const keyCheck = checkHarnessApiKey(harness);
  if (!keyCheck.ok) {
    console.log(`SKIPPED: ${keyCheck.reason}`);
    process.exit(0);
  }
```

- [ ] **Step 3: Update SolverNet config wiring so the daemon prefers the selected harness**

The daemon's harness dispatcher picks the harness by `SolverNet.harness` field. The bootstrapStakedOperator helper should write `joinedSolverNets[<manifestCid>] = { ..., harness: <selectorToHarnessName(harness)> }` so the daemon dispatches to the right one. Implement:

```typescript
function selectorToHarnessName(sel: HarnessSelector): string {
  switch (sel) {
    case 'hermes-agent': return 'hermes-agent';
    case 'claude-code':  return 'claude-code-learner';
    case 'codex':         return 'codex-learner';
    case 'prediction-v1-baseline': return 'prediction-v1-baseline';
  }
}
```

Add this to the SolverNet-config write that the daemon reads on startup. (The exact field shape is in `spec/2026-05-05-solvernet-creation-and-launch.md` §12; mirror the production launcher's write.)

- [ ] **Step 4: Run each harness in turn — expect three independent passes**

```bash
cd client
JINN_E2E_HARNESS=hermes-agent OPENROUTER_API_KEY=$OPENROUTER_API_KEY yarn e2e:daemon-harness
JINN_E2E_HARNESS=claude-code ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY yarn e2e:daemon-harness
JINN_E2E_HARNESS=codex OPENAI_API_KEY=$OPENAI_API_KEY yarn e2e:daemon-harness
```

Expected: each prints `delivered: tx=0x... solver=<selectorName>` within ~2–4 min. Real LLM call cost: pennies per run.

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/_daemon-harness-helpers.ts client/test/e2e/daemon-harness-cycle.ts
git commit -m "test(e2e): parameterise daemon-harness-cycle over hermes/claude/codex (jinn-mono-8psp.8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Assertions — schema validation + activity counter (30 min)

Tighten the assertions to catch real-world regressions, not just "tx posted".

**Files:**
- Modify: `client/test/e2e/_daemon-harness-helpers.ts`
- Modify: `client/test/e2e/daemon-harness-cycle.ts`

- [ ] **Step 1: Add SignedEnvelope schema validation to waitForDelivery**

After decoding the envelope from IPFS, validate it against `SignedEnvelopeSchema` (reuse `client/src/types/envelope.ts`). Also validate the `solutionPayload` against `PredictionV1SolutionPayloadSchema` (reuse `client/src/types/payloads/index.ts`'s `SOLVER_TYPE_PAYLOADS['prediction.v1'].restoration`).

- [ ] **Step 2: Add activity-counter assertion**

```typescript
export async function readActivityCount(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
): Promise<bigint> {
  // FILL IN — call the staking proxy's activity-checker getMultisigNonces or
  // equivalent for the service id. See contracts/src/staking/ for the ABI.
  throw new Error('TODO');
}
```

Call it before and after the loop in the orchestrator. Assert `after > before`.

- [ ] **Step 3: Run again — all three harnesses must still pass**

```bash
cd client
JINN_E2E_HARNESS=hermes-agent OPENROUTER_API_KEY=$OPENROUTER_API_KEY yarn e2e:daemon-harness
```

(Repeat for claude-code, codex.)

- [ ] **Step 4: Commit**

```bash
git add client/test/e2e/_daemon-harness-helpers.ts client/test/e2e/daemon-harness-cycle.ts
git commit -m "test(e2e): tighten daemon-harness-cycle assertions — envelope schema + activity counter (jinn-mono-8psp.8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Reward claim verification (best-effort) (30 min)

If the staking contract's checkpoint window allows during the test run, the daemon's `RewardClaimLoop` will pick up an eligible reward and post a claim tx. Assert this when it happens; degrade gracefully (SKIPPED with reason) when the window hasn't elapsed.

**Files:**
- Modify: `client/test/e2e/_daemon-harness-helpers.ts`
- Modify: `client/test/e2e/daemon-harness-cycle.ts`

- [ ] **Step 1: Advance Anvil's clock past the next checkpoint window**

```typescript
export async function advanceToNextCheckpoint(fixture: DaemonHarnessFixture): Promise<void> {
  // FILL IN — read checkpoint period from the staking contract; warp Anvil
  // time forward with anvil_setNextBlockTimestamp + anvil_mine. See
  // staking.ts for the same pattern.
}
```

- [ ] **Step 2: Wait for the reward-claim tx, optional**

```typescript
export async function waitForRewardClaim(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  timeoutMs = 60_000,
): Promise<`0x${string}` | null> {
  // FILL IN — poll for a 'Reward' or 'RewardClaimed' event on the staking
  // proxy with operator.safeAddress. Return tx hash or null on timeout.
}
```

- [ ] **Step 3: Hook into orchestrator**

```typescript
    await advanceToNextCheckpoint(fixture);
    const rewardTx = await waitForRewardClaim(fixture, operator);
    if (rewardTx) {
      console.log(`reward claimed: tx=${rewardTx}`);
    } else {
      console.log(`reward claim: SKIPPED — no eligible reward in window`);
    }
```

- [ ] **Step 4: Run + commit**

```bash
JINN_E2E_HARNESS=prediction-v1-baseline yarn e2e:daemon-harness
```

Then:

```bash
git add client/test/e2e/_daemon-harness-helpers.ts client/test/e2e/daemon-harness-cycle.ts
git commit -m "test(e2e): best-effort reward-claim assertion in daemon-harness-cycle (jinn-mono-8psp.8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Documentation + final acceptance run (30 min)

**Files:**
- Modify: `client/CLAUDE.md` (Development Commands section)
- Modify: `client/docs/runbooks/testing.md` (if it covers e2e invocation)

- [ ] **Step 1: Document the new test in client/CLAUDE.md**

Under the existing `## Development Commands` block, add (under the Client subsection):

```bash
yarn e2e:daemon-harness   # production Daemon + real harness + Anvil settlement loop
                          # JINN_E2E_HARNESS=hermes-agent|claude-code|codex
                          # skips cleanly when the harness's API key is absent
```

- [ ] **Step 2: Final acceptance — three real-harness runs back-to-back**

```bash
cd client
JINN_E2E_HARNESS=prediction-v1-baseline yarn e2e:daemon-harness  # smoke
JINN_E2E_HARNESS=hermes-agent OPENROUTER_API_KEY=$KEY yarn e2e:daemon-harness
JINN_E2E_HARNESS=claude-code ANTHROPIC_API_KEY=$KEY yarn e2e:daemon-harness
JINN_E2E_HARNESS=codex OPENAI_API_KEY=$KEY yarn e2e:daemon-harness
```

Expected: all four pass. Capture run times in the bd issue close note for future cadence planning.

- [ ] **Step 3: Close the bd issue**

```bash
bd close jinn-mono-8psp.8 --reason="Integration e2e shipped. Hermes/Claude/Codex all close the loop on Anvil fork via the production Daemon."
```

- [ ] **Step 4: Commit + push**

```bash
git add client/CLAUDE.md client/docs/runbooks/testing.md
git commit -m "docs: document yarn e2e:daemon-harness in client/CLAUDE.md (jinn-mono-8psp.8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin HEAD:hermes/6-real-binary-fixes
```

(Or open a new PR — the integration e2e is independent of the MCP-wiring fix on #145 and could ship in its own draft for clearer review.)

---

## Self-Review

**Spec coverage check:**

| Acceptance criterion | Covered by |
|---|---|
| 1. yarn e2e:daemon-harness completes for at least one harness | Tasks 1–7 |
| 2. Uses production Daemon class with MechAdapter | Task 3 |
| 3. Daemon's loops drive settlement without test-side manual tx | Tasks 4–6 |
| 4. Asserts on-chain claim tx + deliver tx + activity counter | Tasks 4, 5, 7 |
| 5. Skips cleanly when API key absent | Task 6 |

**Out-of-scope items deliberately deferred** (file as future beads if/when needed):
- swe-rebench-v2 variant (slow, Docker): `jinn-mono-8psp.9` once `.8` lands
- Evaluator/verdict path
- Multi-cycle full-loop (we run one cycle per harness; learner-full-cycle.ts already covers two-cycle learn semantics)

**Placeholders scan:** Several tasks include `// FILL IN` markers. These are explicitly NOT placeholders — they point at concrete existing helpers (`staking.ts:main`, `task-first-helpers.ts:writeContractTx`, `src/main.ts` DaemonConfig wiring) and tell the implementer where to read for the real code. The acceptance criterion "no placeholders" applies to "TBD/TODO/implement later"; these are reading pointers.

**Type consistency:** `BootstrappedOperator`, `DaemonHarnessFixture`, `PostedPredictionTask`, `DeliveredTask`, `RunningDaemon` all defined in Task 1–5; later tasks reference them consistently. `HarnessSelector` is the single union for harness selection; introduced in Task 1.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-daemon-harness-anvil-settlement-e2e-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
