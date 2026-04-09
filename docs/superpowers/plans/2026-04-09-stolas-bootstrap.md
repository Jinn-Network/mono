# stOLAS Bootstrap Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stOLAS the default bootstrap mode so operators only need ETH (no OLAS) to stake, while preserving the current OLAS flow as `self-bond` fallback.

**Architecture:** Add `stakingMode` to config/state, branch the bootstrap state machine at key steps. In `standard` mode, the agent EOA calls `ExternalStakingDistributor.stake()` directly, which atomically creates service + Safe + bond + stakes. Existing steps for self-bond remain untouched.

**Tech Stack:** TypeScript, ethers.js v6, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-09-stolas-bootstrap-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `client/src/earning/types.ts` | Modify | Add `staking_mode` to `EarningState`, `StakingMode` type |
| `client/src/earning/contracts.ts` | Modify | Add stOLAS distributor address, ABI, preflight ABI |
| `client/src/earning/bootstrap.ts` | Modify | Add `stakingMode` option, `stepStolasStake()`, branch routing |
| `client/src/config.ts` | Modify | Add `stakingMode` config field + env override |
| `client/src/main.ts` | Modify | Pass `stakingMode` to bootstrapper |
| `client/test/earning/bootstrap.test.ts` | Modify | Add tests for standard mode branching |

---

### Task 1: Add StakingMode type and state field

**Files:**
- Modify: `client/src/earning/types.ts`

- [ ] **Step 1: Write the failing test**

Add to `client/test/earning/bootstrap.test.ts`:

```typescript
it('creates default earning state with standard staking mode', () => {
  const state = createDefaultEarningState('base');
  expect(state.staking_mode).toBe('standard');
});

it('accepts self-bond staking mode in state schema', () => {
  const state = createDefaultEarningState('base');
  state.staking_mode = 'self-bond';
  const result = EarningStateSchema.safeParse(state);
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts -t "creates default earning state"`
Expected: FAIL — `staking_mode` doesn't exist on EarningState

- [ ] **Step 3: Add StakingMode to types.ts**

In `client/src/earning/types.ts`, add the staking mode schema before `EarningStepSchema`:

```typescript
export const StakingModeSchema = z.enum(['standard', 'self-bond']);
export type StakingMode = z.infer<typeof StakingModeSchema>;
```

Add `staking_mode` to `EarningStateSchema` (after the `chain` field):

```typescript
staking_mode: StakingModeSchema.default('standard'),
```

Update `createDefaultEarningState` to include:

```typescript
staking_mode: 'standard' as StakingMode,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts`
Expected: ALL PASS (new tests + existing 9 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/earning/types.ts client/test/earning/bootstrap.test.ts
git commit -m "feat(earning): add StakingMode type and state field"
```

---

### Task 2: Add stOLAS distributor constants and ABIs

**Files:**
- Modify: `client/src/earning/contracts.ts`

- [ ] **Step 1: Write the failing test**

Add to `client/test/earning/bootstrap.test.ts`:

```typescript
import { STOLAS_DISTRIBUTOR, STOLAS_DISTRIBUTOR_ABI } from '../../src/earning/contracts.js';

it('exports stOLAS distributor address and ABI', () => {
  expect(STOLAS_DISTRIBUTOR).toBe('0x40abf47B926181148000DbCC7c8DE76A3a61a66f');
  expect(STOLAS_DISTRIBUTOR_ABI).toBeDefined();
  expect(STOLAS_DISTRIBUTOR_ABI.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts -t "exports stOLAS distributor"`
Expected: FAIL — STOLAS_DISTRIBUTOR not exported

- [ ] **Step 3: Add constants to contracts.ts**

At the end of the constants section in `client/src/earning/contracts.ts` (before the ABI section), add:

```typescript
// ---------------------------------------------------------------------------
// stOLAS ExternalStakingDistributor (Base mainnet)
// ---------------------------------------------------------------------------

export const STOLAS_DISTRIBUTOR = '0x40abf47B926181148000DbCC7c8DE76A3a61a66f';

export const STOLAS_DISTRIBUTOR_ABI = [
  {
    inputs: [{ name: 'stakingProxy', type: 'address' }],
    name: 'mapStakingProxyConfigs',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'stakingProxy', type: 'address' },
      { name: 'serviceId', type: 'uint256' },
      { name: 'agentId', type: 'uint256' },
      { name: 'configHash', type: 'bytes32' },
      { name: 'agentInstance', type: 'address' },
    ],
    name: 'stake',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// Add to EVENT_TOPICS in the existing block:
// CreateMultisigWithAgents: keccak256(toUtf8Bytes('CreateMultisigWithAgents(uint256,address)')),

export const STOLAS_STAKING_SLOTS_ABI = [
  {
    inputs: [],
    name: 'getServiceIds',
    outputs: [{ name: 'serviceIds', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'maxNumServices',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/earning/contracts.ts client/test/earning/bootstrap.test.ts
git commit -m "feat(earning): add stOLAS distributor address and ABIs"
```

---

### Task 3: Add stakingMode to config

**Files:**
- Modify: `client/src/config.ts`

- [ ] **Step 1: Write the failing test**

Add to `client/test/config.test.ts`:

```typescript
it('defaults stakingMode to standard', () => {
  const config = loadConfig();
  expect(config.stakingMode).toBe('standard');
});

it('accepts self-bond stakingMode from config file', () => {
  // Use env override since loadConfig reads env
  process.env['JINN_STAKING_MODE'] = 'self-bond';
  const config = loadConfig();
  expect(config.stakingMode).toBe('self-bond');
  delete process.env['JINN_STAKING_MODE'];
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/config.test.ts -t "defaults stakingMode"`
Expected: FAIL — `stakingMode` not in schema

- [ ] **Step 3: Add stakingMode to JinnConfigSchema**

In `client/src/config.ts`, add to `JinnConfigSchema` (after the `network` field):

```typescript
/** Staking mode: 'standard' uses stOLAS (no OLAS needed), 'self-bond' uses operator-provided OLAS. */
stakingMode: z.enum(['standard', 'self-bond']).default('standard'),
```

In the env override section of `loadConfig()`, add:

```typescript
if (env['JINN_STAKING_MODE'])       merged.stakingMode = env['JINN_STAKING_MODE'];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx vitest run test/config.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/config.ts client/test/config.test.ts
git commit -m "feat(config): add stakingMode config field (standard | self-bond)"
```

---

### Task 4: Add stakingMode to EarningBootstrapperOptions and pass from main.ts

**Files:**
- Modify: `client/src/earning/bootstrap.ts`
- Modify: `client/src/main.ts`

- [ ] **Step 1: Add stakingMode to EarningBootstrapperOptions**

In `client/src/earning/bootstrap.ts`, add to `EarningBootstrapperOptions`:

```typescript
stakingMode?: 'standard' | 'self-bond';
```

Add a private field to the class:

```typescript
private readonly stakingMode: 'standard' | 'self-bond';
```

In the constructor, after `this.stopAt`:

```typescript
this.stakingMode = options.stakingMode ?? 'standard';
```

In the `bootstrap()` method, after `state = await this.store.patch({ chain: this.chain });`, add:

```typescript
if (!state.staking_mode || state.staking_mode !== this.stakingMode) {
  // Only update staking_mode if no service has been created yet
  if (state.service_id === null) {
    state = await this.store.patch({ staking_mode: this.stakingMode });
  }
}
```

- [ ] **Step 2: Pass stakingMode from main.ts**

In `client/src/main.ts`, add `stakingMode` to the `EarningBootstrapper` constructor call:

```typescript
const bootstrapper = new EarningBootstrapper({
  earningDir: config.earningDir,
  chain: NETWORK_CHAIN,
  rpcUrl: config.rpcUrl,
  stakingMode: config.stakingMode,
  testnetL2DeploymentPath: config.testnetL2DeploymentPath,
  testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
  testnetMechDeploymentPath: config.testnetMechDeploymentPath,
  stopAt: (config.network === 'testnet' && CHAIN_CONFIG.mechMarketplace === '0x0000000000000000000000000000000000000000')
    ? 'service_staked'
    : 'complete',
});
```

- [ ] **Step 3: Run full test suite**

Run: `cd client && npx vitest run`
Expected: ALL 33+ tests pass (no regressions)

- [ ] **Step 4: Commit**

```bash
git add client/src/earning/bootstrap.ts client/src/main.ts
git commit -m "feat(earning): wire stakingMode through bootstrapper options"
```

---

### Task 5: Branch state machine for standard mode

**Files:**
- Modify: `client/src/earning/bootstrap.ts`
- Modify: `client/test/earning/bootstrap.test.ts`

This is the core task. We modify three step handlers to branch on `stakingMode` and add `stepStolasStake()`.

- [ ] **Step 1: Write failing tests for standard mode branching**

Add to `client/test/earning/bootstrap.test.ts`:

```typescript
describe('standard (stOLAS) mode', () => {
  it('skips safe_predicted step in standard mode', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-earning-'));
    dirs.push(earningDir);

    const store = new EarningStateStore(earningDir);
    const state = createDefaultEarningState('base');
    state.step = 'safe_predicted';
    state.staking_mode = 'standard';
    state.agent_address = '0x00000000000000000000000000000000000000a1';
    await store.save(state);

    const bootstrapper = new EarningBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    // Mock refreshPredictedSafeAddress to be a no-op (no Safe to predict in standard mode)
    vi.spyOn(bootstrapper as any, 'refreshPredictedSafeAddress').mockImplementation(async (s: any) => s);
    vi.spyOn(bootstrapper as any, 'refreshServiceProgressState').mockImplementation(async (s: any) => s);

    // stepPredictSafe in standard mode should skip straight to awaiting_funding
    const result = await (bootstrapper as any).stepPredictSafe(state, 'test-password');
    expect(result.step).toBe('awaiting_funding');
    expect(result.safe_address).toBeNull();
  });

  it('checks only ETH balance in standard mode awaiting_funding', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-earning-'));
    dirs.push(earningDir);

    const store = new EarningStateStore(earningDir);
    const state = createDefaultEarningState('base');
    state.step = 'awaiting_funding';
    state.staking_mode = 'standard';
    state.agent_address = '0x00000000000000000000000000000000000000a1';
    await store.save(state);

    const bootstrapper = new EarningBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    // Agent EOA has enough ETH
    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);
    vi.spyOn((bootstrapper as any).store, 'patch').mockImplementation(async (patch: Record<string, unknown>) => ({
      ...state,
      ...patch,
      updated_at: new Date().toISOString(),
    }));

    const result = await (bootstrapper as any).stepCheckFunding(state, 'test-password');

    // In standard mode, should advance to safe_deployed (which routes to stepStolasStake)
    // without checking OLAS or Safe balance
    expect(result.step).toBe('safe_deployed');
  });

  it('describes funding requirement without OLAS in standard mode', () => {
    const bootstrapper = new EarningBootstrapper({
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    const message = (bootstrapper as any).describeStep('awaiting_funding', {
      eoa_address: '0x00000000000000000000000000000000000000a1',
      eoa_eth_required: '5000000000000000',
      eoa_eth_balance: '0',
      safe_address: '',
      safe_eth_required: '0',
      safe_eth_balance: '0',
      safe_olas_required: '0',
      safe_olas_balance: '0',
    });

    expect(message).toContain('EOA');
    expect(message).not.toContain('OLAS');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts -t "standard"`
Expected: FAIL — standard mode branching not implemented

- [ ] **Step 3: Modify stepPredictSafe for standard mode**

In `client/src/earning/bootstrap.ts`, in `stepPredictSafe()`, add at the top of the method:

```typescript
// In standard mode, the distributor creates the Safe — nothing to predict
if (this.stakingMode === 'standard') {
  console.error('[earning-bootstrap] Standard (stOLAS) mode — skipping Safe prediction');
  return this.store.patch({ step: 'awaiting_funding' });
}
```

- [ ] **Step 4: Modify stepCheckFunding for standard mode**

In `client/src/earning/bootstrap.ts`, in `stepCheckFunding()`, add a branch at the start:

```typescript
if (this.stakingMode === 'standard') {
  // Standard (stOLAS) mode: only need ETH on the agent EOA for gas
  const eoaAddress = state.agent_address!;
  const eoaBalance = await this.provider.getBalance(eoaAddress);

  if (eoaBalance >= this.config.minEoaGasEth) {
    console.error('[earning-bootstrap] Standard mode: ETH funding sufficient, proceeding');
    return this.store.patch({ step: 'safe_deployed' });
  }

  console.error(
    `[earning-bootstrap] Standard mode: waiting for ETH funding: eoaBalance=${eoaBalance} (need ${this.config.minEoaGasEth})`,
  );
  return state;
}
```

- [ ] **Step 5: Modify buildFundingRequirement for standard mode**

In `buildFundingRequirement()`, add a branch:

```typescript
if (this.stakingMode === 'standard') {
  const eoaAddress = state.agent_address!;
  const eoaBalance = await this.provider.getBalance(eoaAddress);

  return {
    eoa_address: eoaAddress,
    eoa_eth_required: this.config.minEoaGasEth.toString(),
    eoa_eth_balance: eoaBalance.toString(),
    safe_address: '',
    safe_eth_required: '0',
    safe_eth_balance: '0',
    safe_olas_required: '0',
    safe_olas_balance: '0',
  };
}
```

- [ ] **Step 6: Modify describeStep for standard mode**

In `describeStep()`, update the `awaiting_funding` branch to handle standard mode where OLAS is irrelevant. The existing logic works because `olasNeeded` will be `0n - 0n = 0n`, so the OLAS line won't appear. But the Safe ETH line should also be suppressed. Update the condition:

```typescript
if (safeEthNeeded > 0n && funding.safe_address) {
  lines.push(`  Safe (${funding.safe_address}): needs ${safeEthNeeded} wei ETH ...`);
}
```

- [ ] **Step 7: Modify refreshPredictedSafeAddress for standard mode**

In `refreshPredictedSafeAddress()`, add early return at the top:

```typescript
if (this.stakingMode === 'standard') {
  return state;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add client/src/earning/bootstrap.ts client/test/earning/bootstrap.test.ts
git commit -m "feat(earning): branch state machine for standard (stOLAS) mode"
```

---

### Task 6: Implement stepStolasStake()

**Files:**
- Modify: `client/src/earning/bootstrap.ts`
- Modify: `client/test/earning/bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `standard (stOLAS) mode` describe block in `client/test/earning/bootstrap.test.ts`:

```typescript
it('routes safe_deployed through service_staked to stepStolasStake in standard mode', async () => {
  const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-earning-'));
  dirs.push(earningDir);

  const store = new EarningStateStore(earningDir);

  const bootstrapper = new EarningBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl: 'http://127.0.0.1:8545',
    stakingMode: 'standard',
  });

  // Verify that in standard mode, steps safe_deployed through service_staked
  // all dispatch to stepStolasStake
  for (const step of ['safe_deployed', 'service_created', 'service_activated', 'agents_registered', 'service_deployed', 'service_staked'] as const) {
    const state = createDefaultEarningState('base');
    state.step = step;
    state.staking_mode = 'standard';
    state.agent_address = '0x00000000000000000000000000000000000000a1';
    await store.save(state);

    const stolasStakeSpy = vi.spyOn(bootstrapper as any, 'stepStolasStake').mockResolvedValue({
      ...state,
      step: 'mech_deployed',
      service_id: 42,
      safe_address: '0x00000000000000000000000000000000000000b1',
    });

    await (bootstrapper as any).runStep(state, 'test-password');
    expect(stolasStakeSpy).toHaveBeenCalled();
    stolasStakeSpy.mockRestore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts -t "routes safe_deployed"`
Expected: FAIL — `stepStolasStake` not defined

- [ ] **Step 3: Add routing in runStep()**

In `client/src/earning/bootstrap.ts`, modify `runStep()` to route standard mode steps:

```typescript
private async runStep(state: EarningState, password: string): Promise<EarningState> {
  // In standard (stOLAS) mode, steps between safe_deployed and service_staked
  // are all handled by a single distributor.stake() call
  if (this.stakingMode === 'standard') {
    switch (state.step) {
      case 'wallet':
        return this.stepCreateWallet(state, password);
      case 'safe_predicted':
        return this.stepPredictSafe(state, password);
      case 'awaiting_funding':
        return this.stepCheckFunding(state, password);
      case 'safe_deployed':
      case 'service_created':
      case 'service_activated':
      case 'agents_registered':
      case 'service_deployed':
      case 'service_staked':
        return this.stepStolasStake(state, password);
      case 'mech_deployed':
        return this.stepDeployMech(state, password);
      case 'complete':
        return state;
      default:
        throw new Error(`Unknown step: ${state.step}`);
    }
  }

  switch (state.step) {
    // ... existing self-bond cases unchanged ...
```

- [ ] **Step 4: Implement stepStolasStake()**

Add the method to `EarningBootstrapper`:

```typescript
// -----------------------------------------------------------------------
// Standard mode: stOLAS stake (replaces steps 4-9)
// -----------------------------------------------------------------------

private async stepStolasStake(state: EarningState, password: string): Promise<EarningState> {
  const serviceId = state.service_id;

  // If we already have a service, check if it's already staked (idempotency on re-run)
  if (serviceId !== null) {
    const stakingState = await this.getStakingState(serviceId);
    if (stakingState === 1) {
      console.error(`[earning-bootstrap] Service ${serviceId} already staked via stOLAS, skipping`);
      return this.store.patch({ step: 'mech_deployed' });
    }
  }

  // Preflight: verify distributor is configured and slots available
  await this.stolasPreflightCheck();

  const signerKey = await this.loadPrivateKey(password);
  const signer = new Wallet(signerKey, this.provider);
  const agentAddress = state.agent_address!;

  const configHashBytes = cidToBytes32(this.config.serviceHash);

  // Encode distributor.stake() calldata
  const distributorIface = new Interface(STOLAS_DISTRIBUTOR_ABI);
  const stakeData = distributorIface.encodeFunctionData('stake', [
    this.config.stakingContract,
    0,  // serviceId=0 → create new service
    this.config.agentId,
    configHashBytes,
    agentAddress,
  ]);

  console.error(`[earning-bootstrap] Calling stOLAS distributor.stake() from agent EOA ${agentAddress}`);
  const txResponse = await signer.sendTransaction({
    to: STOLAS_DISTRIBUTOR,
    data: stakeData,
    gasLimit: 2_500_000n,
  });

  const receipt = await txResponse.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`stOLAS stake() tx failed: ${txResponse.hash}`);
  }

  console.error(`[earning-bootstrap] stOLAS stake() confirmed (tx: ${txResponse.hash}, gas: ${receipt.gasUsed})`);

  // Parse CreateService and CreateMultisigWithAgents events
  const parsedServiceId = await this.parseServiceIdFromTx(txResponse.hash);
  if (parsedServiceId === null) {
    throw new Error(`stOLAS stake() succeeded (tx: ${txResponse.hash}) but CreateService event not found in ${receipt.logs.length} logs. Check tx on basescan.`);
  }

  // Parse multisig (Safe) address from CreateMultisigWithAgents event
  const createMultisigTopic = EVENT_TOPICS.CreateMultisigWithAgents;
  let safeAddress: string | null = null;
  for (const log of receipt.logs) {
    if (log.topics[0] === createMultisigTopic && log.topics.length >= 2) {
      // CreateMultisigWithAgents(uint256 indexed serviceId, address indexed multisig)
      safeAddress = getAddress('0x' + log.topics[2].slice(26));
      break;
    }
  }

  if (!safeAddress) {
    throw new Error(`stOLAS stake() succeeded (tx: ${txResponse.hash}) but CreateMultisigWithAgents event not found. Service ID: ${parsedServiceId}`);
  }

  console.error(`[earning-bootstrap] stOLAS service created: id=${parsedServiceId}, safe=${safeAddress}`);

  return this.store.patch({
    step: 'mech_deployed',
    service_id: parsedServiceId,
    safe_address: safeAddress,
    staking_address: this.config.stakingContract,
  });
}

private async stolasPreflightCheck(): Promise<void> {
  const distributor = new Contract(STOLAS_DISTRIBUTOR, STOLAS_DISTRIBUTOR_ABI, this.provider);
  const proxyConfig: bigint = await distributor.mapStakingProxyConfigs(this.config.stakingContract);
  if (proxyConfig === 0n) {
    throw new Error(
      `stOLAS distributor is not configured for staking contract ${this.config.stakingContract}. ` +
      `The contract may not be whitelisted yet. Use stakingMode: 'self-bond' to stake with your own OLAS.`,
    );
  }

  const staking = new Contract(this.config.stakingContract, STOLAS_STAKING_SLOTS_ABI, this.provider);
  const serviceIds: bigint[] = await staking.getServiceIds();
  const maxServices: bigint = await staking.maxNumServices();
  const slotsRemaining = Number(maxServices) - serviceIds.length;

  if (slotsRemaining <= 0) {
    throw new Error(
      `All ${maxServices} staking slots are occupied. No slots available. ` +
      `Try again later or use a different staking contract.`,
    );
  }

  console.error(`[earning-bootstrap] stOLAS preflight passed: ${slotsRemaining} staking slots remaining`);
}
```

Add the required imports at the top of `bootstrap.ts`:

```typescript
import {
  // ... existing imports ...
  STOLAS_DISTRIBUTOR,
  STOLAS_DISTRIBUTOR_ABI,
  STOLAS_STAKING_SLOTS_ABI,
} from './contracts.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite for regressions**

Run: `cd client && npx vitest run`
Expected: ALL tests pass

- [ ] **Step 7: Commit**

```bash
git add client/src/earning/bootstrap.ts client/test/earning/bootstrap.test.ts
git commit -m "feat(earning): implement stepStolasStake() with distributor.stake() call"
```

---

### Task 7: Type-check and full validation

**Files:** None (validation only)

- [ ] **Step 1: Run TypeScript compiler**

Run: `cd client && npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 2: Run full test suite**

Run: `cd client && npx vitest run`
Expected: ALL tests pass (33+ original + new stOLAS tests)

- [ ] **Step 3: Fix any issues found**

Address any type errors or test failures.

- [ ] **Step 4: Commit any fixes**

```bash
git add -u client/
git commit -m "fix(earning): resolve type/test issues from stOLAS integration"
```

(Skip this commit if no fixes were needed.)
