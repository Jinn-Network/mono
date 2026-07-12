# Split earning/bootstrap.ts into per-step modules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the ~2,724-line `client/src/earning/bootstrap.ts` `FleetBootstrapper` state machine so that each bootstrap step lives in its own module under `client/src/earning/steps/`, and `bootstrap.ts` only *sequences* those steps — with zero behavior change and zero test churn.

**Architecture:** Each extracted step becomes a **pure free function** `(ctx: StepContext, state: FleetState, mnemonic: string, index?: number) => Promise<FleetState>`. `FleetBootstrapper` keeps a **private wrapper method** of the same name for every extracted step; the wrapper body is a one-line delegation `return stepFoo(this.stepContext(), state, mnemonic, index)`. The wrappers are the seam the test suite spies via `vi.spyOn(bootstrapper as any, 'stepFoo')`, so they must survive as instance methods. `stepContext()` is a **private accessor rebuilt fresh on every call** that hands the step body exactly the deps it references today via `this.`, binding the *spied* helpers (`getStakingState`, `getBondTokenBalance`, `parseAgentIdFromReceipt`, `stolasPreflightCheck`, `sweepAbandonedSafeForService`) from the **live instance** so a test's spy flows through.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), viem, Vitest. `yarn typecheck` (`tsc --noEmit`), `yarn test` (`vitest run`, CI runs per-file-isolated), `yarn staking` (`tsx test/e2e/staking.ts` — needs Anvil + internet).

## Global Constraints

- **Public surface is frozen — zero call-site edits.** These exports keep identical names, signatures, and module path (`client/src/earning/bootstrap.ts`): `FleetBootstrapper` (class), `EarningBootstrapper` (`@deprecated` alias), `FleetBootstrapperOptions` (interface), `RecoverEvictedServiceOptions` (interface), and the free functions `recoverEvictedService`, `handleReStakeReceipt`. Public/near-public methods keep identical signatures: `constructor`, `ensureStage1`, `ensureStage1And2`, `bootstrap`, `getStatus`, `loadState`, `retryAgentBindingFor`. External importers that MUST keep compiling unchanged: `client/src/main.ts`, `client/src/index.ts` (barrel), `client/src/cli/commands/bootstrap.ts`, `client/src/cli/commands/fleet-scale.ts`, `client/src/cli/commands/quickstart.ts`, `client/src/cli/commands/solver-plugins.ts`, `client/src/erc8004/plugin-registry.ts`, `client/src/api/gather-status.ts`, `client/src/api/setup-endpoints.ts`, `client/src/earning/funding-plan.ts`, `client/src/daemon/eviction-loop.ts`, `client/src/harnesses/impls/hermes-agent/*`, `client/scripts/staking-validate.ts`, `client/scripts/build-anvil-snapshot.ts`.
- **Do NOT relocate the module-level exported constants/pure helpers.** `computeRequiredMasterEth`, `stage1MinMasterEth`, `STAGE1_AGENT_ETH`, `STANDARD_MASTER_BOOTSTRAP_MULTIPLIER`, `SELF_BOND_ETH_PER_SERVICE` stay in `bootstrap.ts` — they are imported by `funding-plan.ts`, `gather-status.ts`, `setup-endpoints.ts`, `main.ts`, and four test files. Moving them breaks the u34i cross-module invariant and those imports.
- **The 16 spied names are the seam. Preserve them as instance members.** `vi.spyOn(bootstrapper as any, '<name>')` is used across `bootstrap.test.ts`, `staged-bootstrap-stage1.test.ts`, `staged-bootstrap-stage1and2.test.ts`, `bootstrap-faucet.test.ts` for: `stepFleetSafePredict`, `stepFleetSafeDeploy`, `stepFleetIdentityRegister`, `stepStolasStake`, `stepDeployMech`, `stepRegisterAgent`, `gatherChainSignals`, `getStakingState`, `getBondTokenBalance`, `reconcileFleetWithChain`, `recoverEvictedService`, `sweepAbandonedSafeForService`, `bootstrapService`, `loadExistingMnemonic`, `parseAgentIdFromReceipt`, `stolasPreflightCheck`, plus `ensureStage1`. Every one of these must remain a method on `FleetBootstrapper` after the refactor. (Note: `parseServiceIdFromReceipt` and `parseMultisigFromReceipt` are NOT spied but are moved to free functions in the same commit as `parseAgentIdFromReceipt` — keep thin class-method wrappers for all three so the parser trio lives together and `parseAgentIdFromReceipt`'s spy seam is preserved.)
- **Idempotency is byte-for-byte preserved.** Every step's early-return guards, `firstServiceUpdate` reload-after-write pattern, log strings, error messages, and gas constants move verbatim. This is pure code-motion. The `awaiting_funding` / Stage-1 funding-gate + faucet-drip loop inside `ensureStage1And2`, and `computeRequiredMasterEth`, stay untouched in `bootstrap.ts`.
- **`stepContext()` is rebuilt fresh per step invocation** (never cached at construction) and binds spied helpers off the live `this`, so a spy installed *after* construction (the normal test order) is picked up when the real step body calls the helper.
- ESM: all intra-`earning` imports use `.js` specifiers (e.g. `./steps/context.js`). Match existing style.

---

## Reference: `StepContext` shape (defined in Task 1, consumed by every later task)

`StepContext` carries exactly the deps the step bodies reference via `this.` today. Split into three groups:

**Plain readonly values / clients** (bound off `this` at build time — not spied):
- `store: FleetStateStore`
- `config: ChainConfig`
- `publicClient: ReturnType<typeof createJinnPublicClient>`
- `chain: JinnOnchainNetwork`
- `stakingMode: StakingMode`
- `targetServices: number`
- `debug: boolean`
- `env: NodeJS.ProcessEnv`
- `safeBindingMaxAttempts: number`
- `safeBindingRetryDelayMs: number`

**Non-spied helper closures** (bound off `this` so they see live config; not part of the spy seam but must route through the instance to share `this.config` etc.):
- `bindAgentWalletWithRetry: (args, label) => Promise<...>` (delegates to `this.bindAgentWalletWithRetry`)
- `getServiceState: (serviceId: number) => Promise<number>`
- `waitForSuccessfulTx: (txHash: string, label: string) => Promise<void>`
- `firstServiceUpdate: (index: number, patch: Partial<ServiceState>) => Promise<ServiceState>`
- `stakingAddressForService: (svc: ServiceState) => Address`
- `shouldPreserveExistingSetup: (svc: ServiceState) => boolean`
- `parseServiceIdFromReceipt: (receipt: TransactionReceipt) => Promise<number | null>`
- `parseMultisigFromReceipt: (receipt: TransactionReceipt) => string | null`

**Spied helper closures — MUST bind off the live instance so a test spy flows through:**
- `getStakingState: (serviceId: number, stakingAddress?: string | null) => Promise<number>`
- `getBondTokenBalance: (address: string) => Promise<bigint>`
- `parseAgentIdFromReceipt: (receipt: TransactionReceipt, identityRegistry: string) => string | null`
- `stolasPreflightCheck: () => Promise<void>`
- `sweepAbandonedSafeForService: (state: FleetState, mnemonic: string, serviceIndex: number, abandonedSafeAddress: string) => Promise<void>`

**Binding rule (critical):** in the `stepContext()` builder, every closure is written as an arrow that calls back onto `this` at *invocation time*, e.g. `getStakingState: (id, addr) => this.getStakingState(id, addr)`. Do NOT capture the method reference eagerly (`getStakingState: this.getStakingState.bind(this)`) — a late-installed spy replaces the property, and only late-dispatch through `this` picks it up. Because `stepContext()` is called fresh at the top of each wrapper, and the arrows dispatch through `this`, the seam is preserved even when the spy is installed after construction.

`StepContext` interface + the `stepContext()` builder both live in `client/src/earning/steps/context.ts`. The interface is exported; the builder is exported as a standalone `function buildStepContext(self: FleetBootstrapper): StepContext` that the class's private `stepContext()` accessor calls, OR (simpler, preferred) the `stepContext()` accessor stays a private method on the class and `context.ts` only exports the `StepContext` interface. **Chosen: keep `stepContext()` as a private method on `FleetBootstrapper` in `bootstrap.ts`; export only the `StepContext` interface from `context.ts`.** Rationale: the builder needs read access to ~13 private fields; a private method has that access natively without widening visibility or passing the whole instance around.

---

## Task 1: Introduce `steps/context.ts` and the `stepContext()` accessor (no behavior change)

Establishes the seam infrastructure before any step is extracted. After this task, `bootstrap.ts` still contains every step body unchanged; it merely *also* has a `stepContext()` method that nothing calls yet. This isolates the type-only change so a failure here is unambiguous.

**Files:**
- Create: `client/src/earning/steps/context.ts`
- Modify: `client/src/earning/bootstrap.ts` (add `stepContext()` private method + import the interface)

**Interfaces:**
- Produces: `export interface StepContext { … }` (the full shape from the Reference section above), and a `private stepContext(): StepContext` on `FleetBootstrapper` returning a freshly-built bag.

- [ ] **Step 1: Create `client/src/earning/steps/context.ts`**

```typescript
import type { Address, TransactionReceipt } from 'viem';
import type { ChainConfig } from '../contracts.js';
import type { FleetStateStore } from '../store.js';
import type { FleetState, ServiceState, StakingMode } from '../types.js';
import type { createJinnPublicClient, JinnOnchainNetwork } from '../viem-clients.js';
import type { bindAgentWalletToSafe } from '../agent-wallet-binding.js';

/**
 * Read-only dependency bag handed to every extracted bootstrap step.
 *
 * Built fresh per step invocation by `FleetBootstrapper.stepContext()`. The
 * spied helper closures (getStakingState, getBondTokenBalance,
 * parseAgentIdFromReceipt, stolasPreflightCheck, sweepAbandonedSafeForService)
 * dispatch back through the live instance at call time, so a `vi.spyOn`
 * installed after construction is honoured. See the plan's "Binding rule".
 */
export interface StepContext {
  readonly store: FleetStateStore;
  readonly config: ChainConfig;
  readonly publicClient: ReturnType<typeof createJinnPublicClient>;
  readonly chain: JinnOnchainNetwork;
  readonly stakingMode: StakingMode;
  readonly targetServices: number;
  readonly debug: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly safeBindingMaxAttempts: number;
  readonly safeBindingRetryDelayMs: number;

  // Non-spied helper closures (route through the instance for live config).
  readonly bindAgentWalletWithRetry: (
    args: Parameters<typeof bindAgentWalletToSafe>[0],
    label: string,
  ) => Promise<Awaited<ReturnType<typeof bindAgentWalletToSafe>>>;
  readonly getServiceState: (serviceId: number) => Promise<number>;
  readonly waitForSuccessfulTx: (txHash: string, label: string) => Promise<void>;
  readonly firstServiceUpdate: (
    index: number,
    patch: Partial<ServiceState>,
  ) => Promise<ServiceState>;
  readonly stakingAddressForService: (svc: ServiceState) => Address;
  readonly shouldPreserveExistingSetup: (svc: ServiceState) => boolean;
  readonly parseServiceIdFromReceipt: (
    receipt: TransactionReceipt,
  ) => Promise<number | null>;
  readonly parseMultisigFromReceipt: (receipt: TransactionReceipt) => string | null;

  // Spied helper closures — bound off the live instance (see Binding rule).
  readonly getStakingState: (
    serviceId: number,
    stakingAddress?: string | null,
  ) => Promise<number>;
  readonly getBondTokenBalance: (address: string) => Promise<bigint>;
  readonly parseAgentIdFromReceipt: (
    receipt: TransactionReceipt,
    identityRegistry: string,
  ) => string | null;
  readonly stolasPreflightCheck: () => Promise<void>;
  readonly sweepAbandonedSafeForService: (
    state: FleetState,
    mnemonic: string,
    serviceIndex: number,
    abandonedSafeAddress: string,
  ) => Promise<void>;
}
```

- [ ] **Step 2: Add the `stepContext()` accessor to `FleetBootstrapper`**

In `client/src/earning/bootstrap.ts`, add the import near the other `./` imports:

```typescript
import type { StepContext } from './steps/context.js';
```

Add this private method inside the class (place it just above `// ── Helpers ──` near line 2443, so it sits with the other plumbing):

```typescript
/**
 * Fresh dependency bag for an extracted step. Rebuilt on every call so a
 * spy installed after construction is honoured; the spied helper arrows
 * dispatch through `this` at call time (see plan Binding rule).
 */
private stepContext(): StepContext {
  return {
    store: this.store,
    config: this.config,
    publicClient: this.publicClient,
    chain: this.chain,
    stakingMode: this.stakingMode,
    targetServices: this.targetServices,
    debug: this.debug,
    env: this.env,
    safeBindingMaxAttempts: this.safeBindingMaxAttempts,
    safeBindingRetryDelayMs: this.safeBindingRetryDelayMs,
    bindAgentWalletWithRetry: (args, label) => this.bindAgentWalletWithRetry(args, label),
    getServiceState: (serviceId) => this.getServiceState(serviceId),
    waitForSuccessfulTx: (txHash, label) => this.waitForSuccessfulTx(txHash, label),
    firstServiceUpdate: (index, patch) => this.firstServiceUpdate(index, patch),
    stakingAddressForService: (svc) => this.stakingAddressForService(svc),
    shouldPreserveExistingSetup: (svc) => this.shouldPreserveExistingSetup(svc),
    parseServiceIdFromReceipt: (receipt) => this.parseServiceIdFromReceipt(receipt),
    parseMultisigFromReceipt: (receipt) => this.parseMultisigFromReceipt(receipt),
    getStakingState: (serviceId, stakingAddress) => this.getStakingState(serviceId, stakingAddress),
    getBondTokenBalance: (address) => this.getBondTokenBalance(address),
    parseAgentIdFromReceipt: (receipt, identityRegistry) =>
      this.parseAgentIdFromReceipt(receipt, identityRegistry),
    stolasPreflightCheck: () => this.stolasPreflightCheck(),
    sweepAbandonedSafeForService: (state, mnemonic, serviceIndex, abandonedSafeAddress) =>
      this.sweepAbandonedSafeForService(state, mnemonic, serviceIndex, abandonedSafeAddress),
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors. (`stepContext()` is currently unused — TS does not error on unused private methods, but if a `noUnusedLocals`-style lint fires, it will be consumed in Task 3; proceed.)

- [ ] **Step 4: Run the spy-seam canary + full earning suite**

Run: `cd client && yarn test staged-bootstrap-stage1 staged-bootstrap-stage1and2 bootstrap`
Expected: all pass (no behavior changed; this is the baseline the later extractions must hold).

- [ ] **Step 5: Commit**

```bash
git add client/src/earning/steps/context.ts client/src/earning/bootstrap.ts
git commit -m "refactor(earning): add StepContext seam for bootstrap step extraction

Introduces steps/context.ts (StepContext interface) and a fresh-per-call
stepContext() accessor on FleetBootstrapper. No behavior change; nothing
consumes the bag yet. Prepares the delegating-wrapper extraction (#1581).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract the receipt parsers to `steps/receipt-parsing.ts`

Smallest, purest extraction — validates the free-function + thin-wrapper pattern (including the spied `parseAgentIdFromReceipt` seam) before touching the on-chain steps.

**Files:**
- Create: `client/src/earning/steps/receipt-parsing.ts`
- Modify: `client/src/earning/bootstrap.ts` (replace 3 method bodies with delegating wrappers; add imports)

**Interfaces:**
- Consumes: `EVENT_TOPICS`, `SERVICE_REGISTRY_L2_ABI`, `IDENTITY_REGISTRY_ABI` from `../contracts.js`; `decodeEventLog`, `getAddress`, `type Hex`, `type TransactionReceipt` from `viem`.
- Produces:
  - `export async function parseServiceIdFromReceipt(receipt: TransactionReceipt, serviceRegistry: string): Promise<number | null>`
  - `export function parseMultisigFromReceipt(receipt: TransactionReceipt): string | null`
  - `export function parseAgentIdFromReceipt(receipt: TransactionReceipt, identityRegistry: string): string | null`
  Note: the free `parseServiceIdFromReceipt` takes `serviceRegistry` explicitly (the method reads `this.config.serviceRegistry`); the class wrapper passes `this.config.serviceRegistry`.

- [ ] **Step 1: Create `client/src/earning/steps/receipt-parsing.ts`**

Copy the three parser bodies verbatim from `bootstrap.ts` lines 2532–2603, turning `this.config.serviceRegistry` (in the service-id parser) into a `serviceRegistry` parameter:

```typescript
import { decodeEventLog, getAddress, type Hex, type TransactionReceipt } from 'viem';
import {
  EVENT_TOPICS,
  IDENTITY_REGISTRY_ABI,
  SERVICE_REGISTRY_L2_ABI,
} from '../contracts.js';

export async function parseServiceIdFromReceipt(
  receipt: TransactionReceipt,
  serviceRegistry: string,
): Promise<number | null> {
  const createServiceTopic = EVENT_TOPICS.CreateService;
  const serviceRegistryAddress = serviceRegistry.toLowerCase();

  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !== serviceRegistryAddress ||
      log.topics[0] !== createServiceTopic
    ) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: SERVICE_REGISTRY_L2_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: false,
      });
      if (decoded.eventName === 'CreateService' && 'serviceId' in decoded.args) {
        return Number(decoded.args.serviceId);
      }
    } catch {
      // Not a matching event
    }
  }
  return null;
}

export function parseMultisigFromReceipt(receipt: TransactionReceipt): string | null {
  const topic = EVENT_TOPICS.CreateMultisigWithAgents;
  for (const log of receipt.logs) {
    const t0 = log.topics[0];
    if (t0 === topic && log.topics.length >= 3) {
      return getAddress(('0x' + log.topics[2]!.slice(26)) as Hex);
    }
  }
  return null;
}

/**
 * Extract `agentId` from an `IdentityRegistry.Registered` log. Filters by
 * `(address, topic[0])` first so it never collides with another contract
 * sharing the event signature. Returns a decimal string so it round-trips
 * through JSON-persisted state.
 */
export function parseAgentIdFromReceipt(
  receipt: TransactionReceipt,
  identityRegistry: string,
): string | null {
  const topic = EVENT_TOPICS.Registered;
  const target = identityRegistry.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== target) continue;
    if (log.topics[0] !== topic) continue;
    try {
      const decoded = decodeEventLog({
        abi: IDENTITY_REGISTRY_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: false,
      });
      if (decoded.eventName === 'Registered' && 'agentId' in decoded.args) {
        return (decoded.args.agentId as bigint).toString();
      }
    } catch {
      // Not a matching event
    }
  }
  return null;
}
```

- [ ] **Step 2: Replace the 3 method bodies in `bootstrap.ts` with delegating wrappers**

Add the import (near the `./steps/context.js` import):

```typescript
import {
  parseAgentIdFromReceipt as parseAgentIdFromReceiptImpl,
  parseMultisigFromReceipt as parseMultisigFromReceiptImpl,
  parseServiceIdFromReceipt as parseServiceIdFromReceiptImpl,
} from './steps/receipt-parsing.js';
```

Replace the three method bodies (lines 2532–2603) with thin wrappers that keep the exact same signatures (so `parseAgentIdFromReceipt`'s spy seam is intact):

```typescript
private async parseServiceIdFromReceipt(receipt: TransactionReceipt): Promise<number | null> {
  return parseServiceIdFromReceiptImpl(receipt, this.config.serviceRegistry);
}

private parseMultisigFromReceipt(receipt: TransactionReceipt): string | null {
  return parseMultisigFromReceiptImpl(receipt);
}

private parseAgentIdFromReceipt(
  receipt: TransactionReceipt,
  identityRegistry: string,
): string | null {
  return parseAgentIdFromReceiptImpl(receipt, identityRegistry);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors. If `decodeEventLog` becomes an unused import in `bootstrap.ts`, remove it from the top-of-file `viem` import (check with `grep -n "decodeEventLog" client/src/earning/bootstrap.ts` — it is still used elsewhere? if not, drop it). Same for `EVENT_TOPICS` if now unused. Verify with grep before deleting.

- [ ] **Step 4: Run the tests that assert `parseAgentIdFromReceipt` behavior + spy**

Run: `cd client && yarn test staged-bootstrap-stage1 bootstrap`
Expected: all pass. (`staged-bootstrap-stage1.test.ts` spies `parseAgentIdFromReceipt` and runs the real `stepFleetIdentityRegister` — this exercises the wrapper→free-fn path and the spy seam.)

- [ ] **Step 5: Commit**

```bash
git add client/src/earning/steps/receipt-parsing.ts client/src/earning/bootstrap.ts
git commit -m "refactor(earning): extract receipt parsers to steps/receipt-parsing

parse{Service,Multisig,Agent}IdFromReceipt become pure free functions;
FleetBootstrapper keeps thin same-signature wrappers so the spied
parseAgentIdFromReceipt seam is preserved (#1581).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract the three Stage-1 identity steps

`stepFleetSafePredict`, `stepFleetSafeDeploy`, `stepFleetIdentityRegister`. All three are spied. `stepFleetIdentityRegister` calls `this.parseAgentIdFromReceipt` and `this.bindAgentWalletWithRetry` — both now routed through `ctx`. This is the first extraction that consumes `stepContext()`, so it also proves the fresh-per-call binding under the `staged-bootstrap-stage1` spy-count canary.

**Files:**
- Create: `client/src/earning/steps/fleet-safe-predict.ts`
- Create: `client/src/earning/steps/fleet-safe-deploy.ts`
- Create: `client/src/earning/steps/fleet-identity-register.ts`
- Modify: `client/src/earning/bootstrap.ts` (replace 3 method bodies with wrappers; add imports)

**Interfaces:**
- Consumes: `StepContext` (Task 1). From `../wallet.js`: `deriveAgentAddress`, `deriveAgentSigner`, `deriveMasterSigner`, `walletPrivateKeyAtIndex`. From `../safe-adapter.js`: `initPredictedSafe`. From `../viem-clients.js`: `createJinnWalletClient`. From `../tx-retry.js`: `viemSendTransactionWithRetry`, `waitForTransactionReceiptWithRetry`, `waitForContractCode`. From `../contracts.js`: `IDENTITY_REGISTRY_ABI`, `IDENTITY_REGISTRY_ADDRESSES`, `STAGE1_AGENT_ETH` (imported from `../bootstrap.js` — see note below). From `viem`: `encodeFunctionData`, `getAddress`, `type Address`, `type Hex`. From `viem/accounts`: `type Account`. Plus the module-local `addr` helper (re-declare in each step module, or export it from a shared `steps/addr.ts` — **chosen: add `export const addr = (v: string): Address => getAddress(v) as Address;` to `steps/context.ts` and import it**, to avoid five copies).
- Produces:
  - `export async function stepFleetSafePredict(ctx: StepContext, state: FleetState, mnemonic: string): Promise<FleetState>`
  - `export async function stepFleetSafeDeploy(ctx: StepContext, state: FleetState, mnemonic: string): Promise<FleetState>`
  - `export async function stepFleetIdentityRegister(ctx: StepContext, state: FleetState, mnemonic: string): Promise<FleetState>`

> **Note on `STAGE1_AGENT_ETH`:** it stays exported from `bootstrap.ts` (Global Constraint). `steps/fleet-safe-deploy.ts` imports it via `import { STAGE1_AGENT_ETH } from '../bootstrap.js';`. This is a permitted upward import (constants only, no cycle risk that breaks the build — `bootstrap.ts` importing the step and the step importing the constant is a value cycle, but the constant is a module-top `const` evaluated before the class, and the step is only *called* at runtime, so initialization order is safe). If `tsc`/vitest surfaces a real circular-init problem, fall back to defining a `steps/constants.ts` that both `bootstrap.ts` and the step re-export from — but try the direct import first.

- [ ] **Step 1: Add `addr` to `steps/context.ts`**

Append to `client/src/earning/steps/context.ts`:

```typescript
import { getAddress, type Address } from 'viem';

/** Checksum-address helper shared by step modules (mirrors bootstrap.ts). */
export const addr = (value: string): Address => getAddress(value) as Address;
```

(Merge the `viem` import with the existing type-only `viem` import line — make it a mixed value+type import.)

- [ ] **Step 2: Create `client/src/earning/steps/fleet-safe-predict.ts`**

Body copied verbatim from `bootstrap.ts` lines 1019–1038, `this.` → `ctx.`:

```typescript
import { getAddress } from 'viem';
import type { StepContext } from './context.js';
import type { FleetState } from '../types.js';
import { deriveAgentAddress, walletPrivateKeyAtIndex } from '../wallet.js';
import { initPredictedSafe } from '../safe-adapter.js';

/** Deterministic Safe predict from the HD-index-1 agent EOA. */
export async function stepFleetSafePredict(
  ctx: StepContext,
  state: FleetState,
  mnemonic: string,
): Promise<FleetState> {
  const agentAddress = deriveAgentAddress(mnemonic, 1);
  const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);

  console.error(
    `[fleet-bootstrap] Stage 1: predicting fleet Safe (owner=${agentAddress})`,
  );
  const { address } = await initPredictedSafe({
    rpcUrl: ctx.config.rpcUrl,
    signerKey: agentKey,
    owners: [agentAddress],
    threshold: 1,
  });

  void state;
  return ctx.store.patchFleet({ fleet_safe_address: getAddress(address) });
}
```

- [ ] **Step 3: Create `client/src/earning/steps/fleet-safe-deploy.ts`**

Body copied verbatim from `bootstrap.ts` lines 1041–1108, `this.` → `ctx.`, `this.publicClient` → `ctx.publicClient`, `this.chain` → `ctx.chain`:

```typescript
import { getAddress, type Address, type Hex } from 'viem';
import type { Account } from 'viem/accounts';
import type { StepContext } from './context.js';
import { addr } from './context.js';
import type { FleetState } from '../types.js';
import {
  deriveAgentAddress,
  deriveAgentSigner,
  deriveMasterSigner,
  walletPrivateKeyAtIndex,
} from '../wallet.js';
import { initPredictedSafe } from '../safe-adapter.js';
import { createJinnWalletClient } from '../viem-clients.js';
import {
  viemSendTransactionWithRetry,
  waitForContractCode,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';
import { STAGE1_AGENT_ETH } from '../bootstrap.js';

/** Deploy the predicted fleet Safe. Funds the agent EOA from master if needed. */
export async function stepFleetSafeDeploy(
  ctx: StepContext,
  state: FleetState,
  mnemonic: string,
): Promise<FleetState> {
  // ...verbatim body from bootstrap.ts lines 1045-1107, replacing this.config
  // → ctx.config, this.publicClient → ctx.publicClient, this.chain → ctx.chain,
  // this.store → ctx.store...
}
```

Fill the body with the exact statements from lines 1045–1107 (the `addr(...)` calls use the imported `addr`; `STAGE1_AGENT_ETH` is imported; final line `return ctx.store.load(ctx.chain);`).

- [ ] **Step 4: Create `client/src/earning/steps/fleet-identity-register.ts`**

Body copied verbatim from `bootstrap.ts` lines 1111–1196, `this.` → `ctx.`. Key replacements: `this.parseAgentIdFromReceipt(...)` → `ctx.parseAgentIdFromReceipt(...)`; `this.bindAgentWalletWithRetry(...)` → `ctx.bindAgentWalletWithRetry(...)`; `this.safeBindingMaxAttempts` → `ctx.safeBindingMaxAttempts`; `this.config` → `ctx.config`; `this.publicClient` → `ctx.publicClient`; `this.chain` → `ctx.chain`; `this.store` → `ctx.store`.

```typescript
import { encodeFunctionData, getAddress, type Hex } from 'viem';
import type { Account } from 'viem/accounts';
import type { StepContext } from './context.js';
import { addr } from './context.js';
import type { FleetState } from '../types.js';
import { deriveAgentSigner } from '../wallet.js';
import { createJinnWalletClient } from '../viem-clients.js';
import {
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';
import { IDENTITY_REGISTRY_ABI, IDENTITY_REGISTRY_ADDRESSES } from '../contracts.js';

/** Mint the fleet agentId + bind Safe via setAgentWallet (ERC-1271). */
export async function stepFleetIdentityRegister(
  ctx: StepContext,
  state: FleetState,
  mnemonic: string,
): Promise<FleetState> {
  // ...verbatim body from bootstrap.ts lines 1115-1195 with this.→ctx....
}
```

- [ ] **Step 5: Replace the three Stage-1 method bodies in `bootstrap.ts` with wrappers**

Add imports:

```typescript
import { stepFleetSafePredict as stepFleetSafePredictImpl } from './steps/fleet-safe-predict.js';
import { stepFleetSafeDeploy as stepFleetSafeDeployImpl } from './steps/fleet-safe-deploy.js';
import { stepFleetIdentityRegister as stepFleetIdentityRegisterImpl } from './steps/fleet-identity-register.js';
```

Replace bodies (lines 1019–1196) with:

```typescript
private async stepFleetSafePredict(state: FleetState, mnemonic: string): Promise<FleetState> {
  return stepFleetSafePredictImpl(this.stepContext(), state, mnemonic);
}

private async stepFleetSafeDeploy(state: FleetState, mnemonic: string): Promise<FleetState> {
  return stepFleetSafeDeployImpl(this.stepContext(), state, mnemonic);
}

private async stepFleetIdentityRegister(state: FleetState, mnemonic: string): Promise<FleetState> {
  return stepFleetIdentityRegisterImpl(this.stepContext(), state, mnemonic);
}
```

- [ ] **Step 6: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors. Remove any now-unused imports from the top of `bootstrap.ts` (check `IDENTITY_REGISTRY_ADDRESSES`, `initPredictedSafe`, `deriveAgentAddress` — several are still used by other in-file steps not yet extracted; grep before deleting).

- [ ] **Step 7: Run the Stage-1 spy-count CANARY (blocking gate)**

Run: `cd client && yarn test staged-bootstrap-stage1`
Expected: all pass. **This is the load-bearing verification for the whole refactor.** `staged-bootstrap-stage1.test.ts` asserts `stepFleetSafePredict`/`stepFleetSafeDeploy`/`stepFleetIdentityRegister` `toHaveBeenCalledTimes(1)` / `not.toHaveBeenCalled()` (idempotency spy-counts) AND spies `parseAgentIdFromReceipt` + `getBondTokenBalance` while running real step bodies. **If any spy-count assertion fails, the seam broke — STOP and fix `stepContext()` (verify it is called fresh per wrapper and the arrows dispatch through `this`) before proceeding. Do not continue to Task 4.**

- [ ] **Step 8: Run the broader bootstrap suites**

Run: `cd client && yarn test staged-bootstrap-stage1and2 bootstrap bootstrap-faucet`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add client/src/earning/steps/ client/src/earning/bootstrap.ts
git commit -m "refactor(earning): extract Stage-1 identity steps to steps/

stepFleet{SafePredict,SafeDeploy,IdentityRegister} become pure functions
over StepContext; class keeps delegating wrappers. Proves the fresh-per-call
stepContext() seam under the stage1 spy-count canary (#1581).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Extract the standard Stage-2 steps

`stepStolasStake`, `stepDeployMech`, `stepRegisterAgent`. All three spied. `stepStolasStake` calls `ctx.getStakingState`, `ctx.stolasPreflightCheck`, `ctx.sweepAbandonedSafeForService`, `ctx.parseServiceIdFromReceipt`, `ctx.parseMultisigFromReceipt` — all in the spied/helper set. `stepRegisterAgent` calls `ctx.parseAgentIdFromReceipt`, `ctx.bindAgentWalletWithRetry`, `ctx.firstServiceUpdate`.

**Files:**
- Create: `client/src/earning/steps/stolas-stake.ts`
- Create: `client/src/earning/steps/deploy-mech.ts`
- Create: `client/src/earning/steps/register-agent.ts`
- Modify: `client/src/earning/bootstrap.ts` (replace 3 method bodies with wrappers; add imports)

**Interfaces:**
- Consumes: `StepContext`, `addr` (Task 1/3). Per-step viem/contract imports mirror the originals.
- Produces:
  - `export async function stepStolasStake(ctx: StepContext, state: FleetState, mnemonic: string, index: number): Promise<FleetState>`
  - `export async function stepDeployMech(ctx: StepContext, state: FleetState, mnemonic: string, index: number): Promise<FleetState>`
  - `export async function stepRegisterAgent(ctx: StepContext, state: FleetState, mnemonic: string, index: number): Promise<FleetState>`

- [ ] **Step 1: Create `client/src/earning/steps/stolas-stake.ts`**

Body verbatim from `bootstrap.ts` lines 1521–1642, `this.` → `ctx.`. Imports: `encodeFunctionData`, `getAddress`, `type Address`, `type Hex` from `viem`; `type Account` from `viem/accounts`; `deriveMasterSigner` from `../wallet.js`; `createJinnWalletClient` from `../viem-clients.js`; `viemSendTransactionWithRetry`, `waitForTransactionReceiptWithRetry` from `../tx-retry.js`; `STOLAS_DISTRIBUTOR_ABI`, `SERVICE_REGISTRY_L2_ABI`, `cidToBytes32` from `../contracts.js`; `addr`, `StepContext` from `./context.js`; `FleetState` from `../types.js`. Replace `this.stolasPreflightCheck()` → `ctx.stolasPreflightCheck()`, `this.getStakingState(...)` → `ctx.getStakingState(...)`, `this.sweepAbandonedSafeForService(...)` → `ctx.sweepAbandonedSafeForService(...)`, `this.parseServiceIdFromReceipt(...)` → `ctx.parseServiceIdFromReceipt(...)`, `this.parseMultisigFromReceipt(...)` → `ctx.parseMultisigFromReceipt(...)`. Signature:

```typescript
export async function stepStolasStake(
  ctx: StepContext,
  state: FleetState,
  mnemonic: string,
  index: number,
): Promise<FleetState> {
  // ...verbatim body...
}
```

- [ ] **Step 2: Create `client/src/earning/steps/deploy-mech.ts`**

Body verbatim from `bootstrap.ts` lines 1681–1765, `this.` → `ctx.`. Imports include `encodeAbiParameters`, `encodeFunctionData`, `getAddress`, `type Address`, `type Hex`; `deriveMasterSigner`, `walletPrivateKeyAtIndex` from `../wallet.js`; `createJinnWalletClient`; `viemSendTransactionWithRetry`, `waitForTransactionReceiptWithRetry`; `executeSafeTxDirect` from `../safe-adapter.js`; `MECH_MARKETPLACE_CREATE_ABI` from `../contracts.js`; `addr`, `StepContext`.

- [ ] **Step 3: Create `client/src/earning/steps/register-agent.ts`**

Body verbatim from `bootstrap.ts` lines 1795–2007 (including the large mint/bind block + its long doc comment), `this.` → `ctx.`. Replace `this.store.load` → `ctx.store.load`, `this.config` → `ctx.config`, `this.publicClient` → `ctx.publicClient`, `this.chain` → `ctx.chain`, `this.firstServiceUpdate(...)` → `ctx.firstServiceUpdate(...)`, `this.parseAgentIdFromReceipt(...)` → `ctx.parseAgentIdFromReceipt(...)`, `this.bindAgentWalletWithRetry(...)` → `ctx.bindAgentWalletWithRetry(...)`. Imports: `encodeFunctionData`, `getAddress`, `type Hex` from `viem`; `type Account` from `viem/accounts`; `deriveAgentSigner` from `../wallet.js`; `createJinnWalletClient`; `viemSendTransactionWithRetry`, `waitForTransactionReceiptWithRetry`; `IDENTITY_REGISTRY_ABI`, `IDENTITY_REGISTRY_ADDRESSES` from `../contracts.js`; `bindAgentWalletToSafe` type is only needed if you annotate `bindResult` — reuse `Awaited<ReturnType<StepContext['bindAgentWalletWithRetry']>>` to avoid importing the binding module; `addr`, `StepContext`; `FleetState` from `../types.js`.

- [ ] **Step 4: Replace the three method bodies in `bootstrap.ts` with wrappers**

Add imports:

```typescript
import { stepStolasStake as stepStolasStakeImpl } from './steps/stolas-stake.js';
import { stepDeployMech as stepDeployMechImpl } from './steps/deploy-mech.js';
import { stepRegisterAgent as stepRegisterAgentImpl } from './steps/register-agent.js';
```

Replace bodies:

```typescript
private async stepStolasStake(state: FleetState, mnemonic: string, index: number): Promise<FleetState> {
  return stepStolasStakeImpl(this.stepContext(), state, mnemonic, index);
}

private async stepDeployMech(state: FleetState, mnemonic: string, index: number): Promise<FleetState> {
  return stepDeployMechImpl(this.stepContext(), state, mnemonic, index);
}

private async stepRegisterAgent(state: FleetState, mnemonic: string, index: number): Promise<FleetState> {
  return stepRegisterAgentImpl(this.stepContext(), state, mnemonic, index);
}
```

- [ ] **Step 5: Typecheck + prune unused imports**

Run: `cd client && yarn typecheck`
Expected: zero errors. Grep-then-prune any top-of-`bootstrap.ts` imports now unused (e.g. `MECH_MARKETPLACE_CREATE_ABI`, `cidToBytes32` may still be used by self-bond steps still in-file — do NOT remove until Task 5).

- [ ] **Step 6: Run the standard-mode + spy-seam tests**

Run: `cd client && yarn test bootstrap staged-bootstrap-stage1and2 bootstrap-mech-safe-direct`
Expected: all pass. `bootstrap.test.ts` directly calls `(bootstrapper as any).stepStolasStake(...)`, `.stepRegisterAgent(...)`, `.resumeServiceStandard(...)` while spying `stolasPreflightCheck`, `getStakingState`, `sweepAbandonedSafeForService`, `bindAgentWalletToSafe` — this exercises the real step bodies through the new free functions and confirms the spied-helper arrows dispatch through the live instance.

- [ ] **Step 7: Commit**

```bash
git add client/src/earning/steps/ client/src/earning/bootstrap.ts
git commit -m "refactor(earning): extract standard Stage-2 steps to steps/

stepStolasStake, stepDeployMech, stepRegisterAgent become pure functions
over StepContext; spied helpers (getStakingState, stolasPreflightCheck,
sweepAbandonedSafeForService, parseAgentIdFromReceipt) route through the
live instance so test spies still fire (#1581).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Extract the self-bond ladder to `steps/self-bond/`

Six steps, none spied directly, but each calls `ctx.getServiceState` / `ctx.getStakingState` / `ctx.getBondTokenBalance` / `ctx.parseServiceIdFromReceipt` / `ctx.waitForSuccessfulTx`. Grouped under a subdirectory per the design note.

**Files:**
- Create: `client/src/earning/steps/self-bond/setup.ts`
- Create: `client/src/earning/steps/self-bond/create-service.ts`
- Create: `client/src/earning/steps/self-bond/activate-service.ts`
- Create: `client/src/earning/steps/self-bond/register-agents.ts`
- Create: `client/src/earning/steps/self-bond/deploy-service.ts`
- Create: `client/src/earning/steps/self-bond/stake-service.ts`
- Modify: `client/src/earning/bootstrap.ts` (replace 6 method bodies with wrappers; add imports; hoist the `SELF_BOND_AGENT_ETH`/`SAFE_TOKEN_BOOTSTRAP_MULTIPLIER` locals as needed)

**Interfaces:**
- Consumes: `StepContext`, `addr`. `SAFE_TOKEN_BOOTSTRAP_MULTIPLIER` is a module-private `const` in `bootstrap.ts` (line 103) used only by `stepSelfBondSetup`; move it into `setup.ts` as a local `const` (it is not exported and not referenced elsewhere — confirm with `grep -n SAFE_TOKEN_BOOTSTRAP_MULTIPLIER client/src`). `SELF_BOND_AGENT_ETH` (line 2055) is already a function-local; keep it local to `setup.ts`.
- Produces (all `(ctx, state, mnemonic, index) => Promise<FleetState>`):
  - `export async function stepSelfBondSetup(...)`
  - `export async function stepSelfBondCreateService(...)`
  - `export async function stepSelfBondActivateService(...)`
  - `export async function stepSelfBondRegisterAgents(...)`
  - `export async function stepSelfBondDeployService(...)`
  - `export async function stepSelfBondStakeService(...)`

- [ ] **Step 1: Create the six self-bond step modules**

For each, copy the corresponding method body verbatim (`stepSelfBondSetup` 2027–2154; `stepSelfBondCreateService` 2157–2218; `stepSelfBondActivateService` 2221–2268; `stepSelfBondRegisterAgents` 2271–2318; `stepSelfBondDeployService` 2321–2371; `stepSelfBondStakeService` 2374–2440), rename the signature to `(ctx, state, mnemonic, index)`, and rewrite `this.` → `ctx.`. Imports (per file, tree-shaken to what each uses): from `viem` `encodeAbiParameters`/`encodeFunctionData`/`getAddress`/`type Address`/`type Hex`; from `viem/accounts` `type Account`; from `../../wallet.js` `deriveAgentSigner`/`deriveMasterSigner`/`walletPrivateKeyAtIndex`; from `../../safe-adapter.js` `initPredictedSafe`/`initDeployedSafe`/`executeSafeTxBatch`/`executeSafeTxDirect`; from `../../viem-clients.js` `createJinnWalletClient`; from `../../tx-retry.js` `viemSendTransactionWithRetry`/`waitForTransactionReceiptWithRetry`; from `../../contracts.js` the ABIs each uses (`SERVICE_MANAGER_ABI`, `ERC20_ABI`, `SERVICE_REGISTRY_APPROVE_ABI`, `STAKING_ABI`, `cidToBytes32`); from `../context.js` `addr`, `StepContext`; from `../../types.js` `FleetState`. Note the **relative depth is `../../`** (two levels up from `steps/self-bond/`).

Replace inner helper calls: `this.getServiceState(...)` → `ctx.getServiceState(...)`; `this.getStakingState(...)` → `ctx.getStakingState(...)`; `this.getBondTokenBalance(...)` → `ctx.getBondTokenBalance(...)`; `this.parseServiceIdFromReceipt(...)` → `ctx.parseServiceIdFromReceipt(...)`; `this.waitForSuccessfulTx(...)` → `ctx.waitForSuccessfulTx(...)`; `this.config`/`this.publicClient`/`this.chain`/`this.store` → `ctx.*`. In `setup.ts` add `const SAFE_TOKEN_BOOTSTRAP_MULTIPLIER = 2n;` locally (or import — but it is private, so localize).

- [ ] **Step 2: Replace the six method bodies in `bootstrap.ts` with wrappers**

Add imports:

```typescript
import { stepSelfBondSetup as stepSelfBondSetupImpl } from './steps/self-bond/setup.js';
import { stepSelfBondCreateService as stepSelfBondCreateServiceImpl } from './steps/self-bond/create-service.js';
import { stepSelfBondActivateService as stepSelfBondActivateServiceImpl } from './steps/self-bond/activate-service.js';
import { stepSelfBondRegisterAgents as stepSelfBondRegisterAgentsImpl } from './steps/self-bond/register-agents.js';
import { stepSelfBondDeployService as stepSelfBondDeployServiceImpl } from './steps/self-bond/deploy-service.js';
import { stepSelfBondStakeService as stepSelfBondStakeServiceImpl } from './steps/self-bond/stake-service.js';
```

Replace each body with a wrapper, e.g.:

```typescript
private async stepSelfBondSetup(state: FleetState, mnemonic: string, index: number): Promise<FleetState> {
  return stepSelfBondSetupImpl(this.stepContext(), state, mnemonic, index);
}
```

(…and the analogous five.)

- [ ] **Step 3: Remove the now-orphaned module-private `SAFE_TOKEN_BOOTSTRAP_MULTIPLIER` from `bootstrap.ts`**

Delete line 103 `const SAFE_TOKEN_BOOTSTRAP_MULTIPLIER = 2n;` only after confirming it has no remaining in-file references (`grep -n SAFE_TOKEN_BOOTSTRAP_MULTIPLIER client/src/earning/bootstrap.ts` → no hits after the wrapper swap).

- [ ] **Step 4: Typecheck + prune unused imports**

Run: `cd client && yarn typecheck`
Expected: zero errors. Now aggressively prune `bootstrap.ts`'s top-of-file imports: after Tasks 2–5, the only step-body imports still needed by remaining in-file code (sequencers + `ensureMasterWallet`/`loadExistingMnemonic`/`reconcileFleetWithChain`/`gatherChainSignals`/`bindAgentWalletWithRetry`/`recoverEvictedService`/helpers) survive. Candidates likely removable: `encodeAbiParameters`, `SERVICE_MANAGER_ABI`, `ERC20_ABI`, `SERVICE_REGISTRY_APPROVE_ABI`, `MECH_MARKETPLACE_CREATE_ABI`, `STOLAS_DISTRIBUTOR_ABI` (still used by `recoverEvictedService` + `stolasPreflightCheck`? check), `STOLAS_STAKING_SLOTS_ABI` (used by `stolasPreflightCheck` — keep), `cidToBytes32`, `initDeployedSafe`, `executeSafeTxBatch`. **Grep each symbol before removing; remove only zero-hit ones.**

- [ ] **Step 5: Run the full earning + release-tier bootstrap suites**

Run: `cd client && yarn test earning`
Expected: all earning tests pass (covers `bootstrap`, `staged-bootstrap-*`, `bootstrap-faucet`, `bootstrap-mech-safe-direct`, `restake-receipt`, `funding-plan`).

- [ ] **Step 6: Commit**

```bash
git add client/src/earning/steps/self-bond/ client/src/earning/bootstrap.ts
git commit -m "refactor(earning): extract self-bond ladder to steps/self-bond/

Six self-bond steps become pure functions over StepContext; class keeps
delegating wrappers. bootstrap.ts imports pruned to sequencing needs (#1581).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Final sweep — confirm `bootstrap.ts` reads as pure sequencing + full gate

No new extractions. Verify the acceptance criteria hold and the file now reads as a sequencer.

**Files:**
- Modify (only if the review surfaces dead imports/comments): `client/src/earning/bootstrap.ts`

- [ ] **Step 1: Confirm no step bodies remain in `bootstrap.ts`**

Run: `grep -nE "private async step[A-Z]" client/src/earning/bootstrap.ts`
Expected: every match is a one-line delegating wrapper (`return step…Impl(this.stepContext(), …);`). Manually eyeball that each listed method body is ≤3 lines. What SHOULD remain in `bootstrap.ts` (not steps, so intentionally kept): the class shell + constructor; `stepContext()`; sequencers `ensureStage1`, `ensureStage1And2`, `bootstrap`, `resumeService`, `resumeServiceStandard`, `resumeServiceSelfBond`, `bootstrapService`, `reconcileFleetWithChain`; the funding-gate + faucet-drip loop inside `ensureStage1And2`; `warnMasterEthRunway`, `estimateMasterDailyGasWei`, `ensureMasterWallet`, `loadExistingMnemonic`, `bindAgentWalletWithRetry`, `retryAgentBindingFor`, `getStatus`, `loadState`; the non-step helpers `gatherChainSignals`, `sweepAbandonedSafeForService`, `getBondTokenBalance`, `getServiceState`, `waitForSuccessfulTx`, `stolasPreflightCheck`, `stakingAddressForService`, `shouldPreserveExistingSetup`, `getStakingState`, and the three parser wrappers; `recoverEvictedService` (method wrapper delegating to the free fn); the module-level exported constants/pure helpers (`computeRequiredMasterEth`, `stage1MinMasterEth`, `STAGE1_AGENT_ETH`, `STANDARD_MASTER_BOOTSTRAP_MULTIPLIER`, `SELF_BOND_ETH_PER_SERVICE`); and the free functions `recoverEvictedService`, `handleReStakeReceipt` + `RecoverEvictedServiceOptions`.

  > **`recoverEvictedService`, `handleReStakeReceipt` decision:** these are ALREADY free functions at module scope (lines 2662, 2634) and ALREADY imported by `main.ts` + `eviction-loop.ts` + tests from `bootstrap.js`. Per the design note, **leave them in `bootstrap.ts`** (do not move to `steps/eviction-recovery.ts`) — moving them buys nothing and risks the import path. The class's private `recoverEvictedService` method (line 1644) is a spied thin wrapper over the free fn; keep it as-is.

- [ ] **Step 2: Confirm the public surface + external importers still resolve**

Run: `cd client && yarn typecheck`
Expected: zero errors (this compiles all of `client/src`, `client/scripts`, and the harness layer — proves `main.ts`, `index.ts`, cli commands, `funding-plan.ts`, `gather-status.ts`, `setup-endpoints.ts`, `eviction-loop.ts`, hermes adapters, and both scripts still import unchanged).

- [ ] **Step 3: Run the FULL test suite (per-file isolated, as CI does)**

Run: `cd client && yarn test`
Expected: full vitest suite passes. This is AC-2's first half. If a stray test not in the earning/api/cli set breaks (e.g. an integration test that constructs a `FleetBootstrapper`), triage: the design predicts near-zero test edits — any failure is almost certainly a broken seam (fix `stepContext()`), NOT a legitimate test-expectation change. Only edit a test if the change is a genuine, documented behavior-neutral adjustment (e.g. an import path a test hard-codes) — record which and why.

- [ ] **Step 4: Run the Anvil staking validation (AC-2 second half)**

Prerequisites: `anvil` in PATH + internet (forks Base, hits IPFS/RPC). Start the fork per CLAUDE.md if the script does not self-spawn:

Run: `cd client && yarn staking`
Expected: the earning bootstrap walks wallet → Safe → staking → mech on the Anvil fork and reports success. If Anvil/internet is unavailable in the execution environment, record that `yarn staking` could NOT be run locally and flag it for the reviewer/CI to run — do not claim it passed unseen (verification-before-completion).

- [ ] **Step 5: Final review pass + commit any cleanup**

Re-read `bootstrap.ts` top-to-bottom once. Confirm: no dead imports (grep-verified), section-header comments (`// ── Stage 1 …`, `// ── Phase 2 …`) still make sense or are trimmed, and the wrappers are grouped. If any cleanup edits were made:

```bash
git add client/src/earning/bootstrap.ts
git commit -m "refactor(earning): tidy bootstrap.ts to pure sequencing after step split

Prune dead imports and confirm bootstrap.ts only sequences the extracted
steps/ modules. Closes #1581.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If no cleanup was needed, skip the commit; Task 5's commit already leaves the tree at the acceptance bar.

---

## Acceptance-criteria → task map

- **AC-1: each bootstrap step is its own module; the state-machine file only sequences them.**
  - Receipt parsers → Task 2 (`steps/receipt-parsing.ts`).
  - Stage-1 identity steps → Task 3 (`steps/fleet-safe-predict.ts`, `steps/fleet-safe-deploy.ts`, `steps/fleet-identity-register.ts`).
  - Standard Stage-2 steps → Task 4 (`steps/stolas-stake.ts`, `steps/deploy-mech.ts`, `steps/register-agent.ts`).
  - Self-bond ladder → Task 5 (`steps/self-bond/{setup,create-service,activate-service,register-agents,deploy-service,stake-service}.ts`).
  - "state-machine file only sequences" verified in Task 6 Step 1 (every `private async step…` is a one-line wrapper; sequencers + gate remain).
- **AC-2: `yarn test` passes.** Incrementally gated after every task (Tasks 1–5), full suite in Task 6 Step 3.
- **AC-2: `yarn staking` (Anvil bootstrap validation) passes.** Task 6 Step 4.

## Verification gates (every task)

1. `cd client && yarn typecheck` — zero errors (`tsc --noEmit` + harness-layer typecheck; compiles the whole `client/src` + `client/scripts`, proving all external importers still resolve).
2. `cd client && yarn test <suite>` — the relevant suites per task; full `yarn test` in Task 6 (CI runs per-file-isolated, so no cross-file leakage masks a break).
3. `cd client && yarn staking` — Task 6 only; needs Anvil + internet. If unavailable in-environment, flag for CI rather than claim unseen.

## Ordering-critical detail (do not skip)

The whole refactor rides on `stepContext()` being **rebuilt fresh per wrapper call** with spied-helper closures that **dispatch through `this` at invocation time** (arrow functions, never eager `.bind`). The first extraction that consumes it (Task 3) is gated by the **`staged-bootstrap-stage1.test.ts` spy-count canary** (Task 3 Step 7): those tests assert `toHaveBeenCalledTimes` on the step wrappers AND run real step bodies that call spied helpers (`parseAgentIdFromReceipt`, `getBondTokenBalance`). A spy-count or spy-not-fired failure there means the seam is broken — treat it as a hard STOP and fix `stepContext()` before extracting anything further. `bootstrap.test.ts` Task 4 tests (`stolasPreflightCheck` sentinel at line ~1495, `getStakingState`/`sweepAbandonedSafeForService` spies) are the second confirmation that the live-instance binding holds for Stage-2.

## Test-file locations to watch (design predicts near-zero edits)

- `client/test/earning/staged-bootstrap-stage1.test.ts` — spy-count canary (Task 3 gate).
- `client/test/earning/staged-bootstrap-stage1and2.test.ts` — full-ladder spy sequencing.
- `client/test/earning/bootstrap.test.ts` — directly calls real step bodies via `(bootstrapper as any).stepFoo(...)` + spies inner helpers; the strongest live-binding check.
- `client/test/earning/bootstrap-faucet.test.ts` — spies `ensureStage1`, `reconcileFleetWithChain` (both stay class methods; unaffected).
- `client/test/earning/staged-bootstrap-migration.test.ts` — no `spyOn(bootstrapper, 'step…')`; behavioral, should pass untouched.
- `client/test/earning/bootstrap-mech-safe-direct.test.ts`, `client/test/earning/restake-receipt.test.ts`, `client/test/earning/funding-plan.test.ts` — exercise `stepDeployMech` path, `handleReStakeReceipt`, and `computeRequiredMasterEth` respectively; all preserved.

**Predicted test edits: none.** If one surfaces, the only legitimate kind is a hard-coded import *path* (none expected — all tests import from `earning/bootstrap` or construct the class, and both are unchanged). Any assertion failure is a seam regression to fix in source, not in the test. Record any edit made, with justification, in the task commit body.
