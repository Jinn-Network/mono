# HD Wallet Fleet Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-key wallet with HD mnemonic wallet (master funder + derived agent instances) and evolve earning state from single-service to multi-service array.

**Architecture:** Generate BIP-39 mnemonic on first run, derive master (index 0) as funder, agents (index 1+) as service instances. State file tracks array of services. Bootstrap creates services up to `targetServices`. Master EOA calls `distributor.stake()` for each, passing derived agent as `agentInstance`.

**Tech Stack:** TypeScript, ethers.js v6 (HDNodeWallet, Mnemonic), Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-09-hd-wallet-fleet-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `client/src/earning/types.ts` | Rewrite | New `FleetState`, `ServiceState` schemas; remove old `EarningState` |
| `client/src/earning/store.ts` | Rewrite | Load/save fleet state + mnemonic keystore; legacy detection |
| `client/src/earning/wallet.ts` | Create | HD wallet derivation: mnemonic generation, encrypt/decrypt, derive master/agent |
| `client/src/earning/bootstrap.ts` | Rewrite | Fleet-aware bootstrap: master setup + per-service loop |
| `client/src/config.ts` | Modify | Add `targetServices` field |
| `client/src/main.ts` | Modify | Adapt to fleet state (use first complete service for daemon) |
| `client/test/earning/wallet.test.ts` | Create | HD wallet tests |
| `client/test/earning/types.test.ts` | Create | Fleet state schema tests |
| `client/test/earning/bootstrap.test.ts` | Rewrite | Fleet bootstrap tests |
| `client/test/config.test.ts` | Modify | Add targetServices test |
| `client/scripts/stolas-validate.ts` | Modify | Use fleet bootstrap |

---

### Task 1: Create HD wallet module

**Files:**
- Create: `client/src/earning/wallet.ts`
- Create: `client/test/earning/wallet.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/earning/wallet.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  generateMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  deriveMasterAddress,
  deriveAgentAddress,
  deriveAgentSigner,
  deriveMasterSigner,
} from '../../src/earning/wallet.js';

describe('HD wallet', () => {
  const TEST_PASSWORD = 'test-password';

  it('generates a 12-word mnemonic', () => {
    const mnemonic = generateMnemonic();
    const words = mnemonic.split(' ');
    expect(words).toHaveLength(12);
  });

  it('encrypts and decrypts a mnemonic round-trip', async () => {
    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, TEST_PASSWORD);
    const decrypted = await decryptMnemonic(encrypted, TEST_PASSWORD);
    expect(decrypted).toBe(mnemonic);
  });

  it('rejects wrong password on decrypt', async () => {
    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, TEST_PASSWORD);
    await expect(decryptMnemonic(encrypted, 'wrong-password')).rejects.toThrow();
  });

  it('derives deterministic master address at index 0', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const addr = deriveMasterAddress(mnemonic);
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Same mnemonic always gives same address
    expect(deriveMasterAddress(mnemonic)).toBe(addr);
  });

  it('derives deterministic agent addresses at index 1+', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const agent1 = deriveAgentAddress(mnemonic, 1);
    const agent2 = deriveAgentAddress(mnemonic, 2);
    expect(agent1).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(agent2).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(agent1).not.toBe(agent2);
    // Master, agent1, agent2 are all different
    const master = deriveMasterAddress(mnemonic);
    expect(master).not.toBe(agent1);
    expect(master).not.toBe(agent2);
  });

  it('derives a signer wallet for master', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const signer = deriveMasterSigner(mnemonic);
    expect(signer.address).toBe(deriveMasterAddress(mnemonic));
    expect(signer.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('derives a signer wallet for agent', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const signer = deriveAgentSigner(mnemonic, 1);
    expect(signer.address).toBe(deriveAgentAddress(mnemonic, 1));
    expect(signer.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && npx vitest run test/earning/wallet.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement wallet.ts**

Create `client/src/earning/wallet.ts`:

```typescript
/**
 * HD wallet derivation for fleet management.
 *
 * Mnemonic → derive master (index 0) and agent (index 1+) wallets.
 * Master is the funder, agents are service instances.
 *
 * Derivation base path: m/44'/60'/0'/0
 *   Index 0: master wallet (funder)
 *   Index 1+: agent wallets (one per service)
 */

import { HDNodeWallet, Mnemonic, Wallet, getAddress } from 'ethers';
import { Buffer } from 'node:buffer';

const DERIVATION_BASE_PATH = "m/44'/60'/0'/0";

function deriveAtIndex(mnemonic: string, index: number): HDNodeWallet {
  const m = Mnemonic.fromPhrase(mnemonic);
  const root = HDNodeWallet.fromMnemonic(m, DERIVATION_BASE_PATH);
  return root.deriveChild(index);
}

export function generateMnemonic(): string {
  const m = Mnemonic.fromEntropy(
    globalThis.crypto.getRandomValues(new Uint8Array(16)),
  );
  return m.phrase;
}

export async function encryptMnemonic(mnemonic: string, password: string): Promise<string> {
  // Encrypt the master private key (index 0) in standard keystore format.
  // Store the mnemonic phrase alongside it — encrypted at rest by the keystore.
  // On decrypt, we recover the mnemonic from the stored field and verify
  // it derives the same master address.
  const wallet = deriveAtIndex(mnemonic, 0);
  const keystoreJson = await wallet.encrypt(password, {
    scrypt: { N: 131072, r: 8, p: 1 },
  });
  const keystore = JSON.parse(keystoreJson);

  // Wrap in our envelope with the mnemonic stored alongside the keystore.
  // The keystore itself is password-encrypted. The mnemonic is additionally
  // XOR'd with the master private key before storage, so it's not readable
  // even if someone can see the JSON but can't decrypt the keystore.
  const mnemonicBytes = Buffer.from(mnemonic, 'utf-8');
  const keyBytes = Buffer.from(wallet.privateKey.slice(2), 'hex');
  const obfuscated = Buffer.alloc(mnemonicBytes.length);
  for (let i = 0; i < mnemonicBytes.length; i++) {
    obfuscated[i] = mnemonicBytes[i] ^ keyBytes[i % keyBytes.length];
  }

  return JSON.stringify({
    version: 1,
    type: 'hd-mnemonic',
    master_address: getAddress(wallet.address),
    keystore,
    mnemonic_obfuscated: obfuscated.toString('hex'),
    mnemonic_length: mnemonicBytes.length,
  });
}

export async function decryptMnemonic(encrypted: string, password: string): Promise<string> {
  const data = JSON.parse(encrypted);
  if (data.type !== 'hd-mnemonic') {
    throw new Error(`Unknown keystore type: ${data.type}. Expected 'hd-mnemonic'.`);
  }

  // Decrypt the master private key from the keystore
  const wallet = await Wallet.fromEncryptedJson(JSON.stringify(data.keystore), password);

  // Recover mnemonic by XOR'ing with the master private key
  const keyBytes = Buffer.from(wallet.privateKey.slice(2), 'hex');
  const obfuscated = Buffer.from(data.mnemonic_obfuscated, 'hex');
  const mnemonicBytes = Buffer.alloc(data.mnemonic_length);
  for (let i = 0; i < data.mnemonic_length; i++) {
    mnemonicBytes[i] = obfuscated[i] ^ keyBytes[i % keyBytes.length];
  }
  const mnemonic = mnemonicBytes.toString('utf-8');

  // Verify round-trip: the mnemonic should derive the same master address
  const masterAddress = deriveMasterAddress(mnemonic);
  if (getAddress(masterAddress) !== getAddress(data.master_address)) {
    throw new Error(
      `Mnemonic decryption verification failed: derived ${masterAddress} but expected ${data.master_address}`,
    );
  }

  return mnemonic;
}

export function deriveMasterAddress(mnemonic: string): string {
  return getAddress(deriveAtIndex(mnemonic, 0).address);
}

export function deriveAgentAddress(mnemonic: string, index: number): string {
  if (index < 1) {
    throw new Error(`Agent index must be >= 1, got ${index}`);
  }
  return getAddress(deriveAtIndex(mnemonic, index).address);
}

export function deriveMasterSigner(mnemonic: string): HDNodeWallet {
  return deriveAtIndex(mnemonic, 0);
}

export function deriveAgentSigner(mnemonic: string, index: number): HDNodeWallet {
  if (index < 1) {
    throw new Error(`Agent index must be >= 1, got ${index}`);
  }
  return deriveAtIndex(mnemonic, index);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx vitest run test/earning/wallet.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run type check**

Run: `cd client && npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 6: Commit**

```bash
git add client/src/earning/wallet.ts client/test/earning/wallet.test.ts
git commit -m "feat(earning): add HD wallet module with mnemonic derivation"
```

---

### Task 2: New fleet state types

**Files:**
- Modify: `client/src/earning/types.ts`
- Create: `client/test/earning/types.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/earning/types.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  FleetStateSchema,
  ServiceStateSchema,
  createDefaultFleetState,
  createDefaultServiceState,
} from '../../src/earning/types.js';
import type { FleetState, ServiceState } from '../../src/earning/types.js';

describe('Fleet state types', () => {
  it('creates a default fleet state', () => {
    const state = createDefaultFleetState('base');
    expect(state.master_address).toBeNull();
    expect(state.chain).toBe('base');
    expect(state.staking_mode).toBe('standard');
    expect(state.services).toEqual([]);
  });

  it('validates a fleet state with services', () => {
    const state = createDefaultFleetState('base');
    state.master_address = '0x1234567890abcdef1234567890abcdef12345678';
    state.services = [
      createDefaultServiceState(1, '0xabcdef1234567890abcdef1234567890abcdef12'),
    ];

    const result = FleetStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('creates a default service state at given index', () => {
    const svc = createDefaultServiceState(1, '0xabcdef1234567890abcdef1234567890abcdef12');
    expect(svc.index).toBe(1);
    expect(svc.agent_address).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    expect(svc.step).toBe('awaiting_stake');
    expect(svc.safe_address).toBeNull();
    expect(svc.service_id).toBeNull();
    expect(svc.mech_address).toBeNull();
  });

  it('rejects service with index 0', () => {
    const result = ServiceStateSchema.safeParse({
      index: 0,
      agent_address: '0x1234567890abcdef1234567890abcdef12345678',
      safe_address: null,
      service_id: null,
      mech_address: null,
      staking_address: null,
      step: 'awaiting_stake',
      error: null,
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && npx vitest run test/earning/types.test.ts`
Expected: FAIL — FleetStateSchema not exported

- [ ] **Step 3: Rewrite types.ts**

Replace `client/src/earning/types.ts` with:

```typescript
import { z } from 'zod';

// ── Staking mode ─────────────────────────────────────────────────────────────

export const StakingModeSchema = z.enum(['standard', 'self-bond']);
export type StakingMode = z.infer<typeof StakingModeSchema>;

// ── Service step progression ─────────────────────────────────────────────────
//
// Standard (stOLAS) mode:
//   awaiting_stake -> staked -> mech_deployed -> complete
//
// Self-bond mode (legacy):
//   awaiting_stake -> service_created -> service_activated -> agents_registered ->
//   service_deployed -> service_staked -> mech_deployed -> complete

export const ServiceStepSchema = z.enum([
  'awaiting_stake',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'staked',
  'mech_deployed',
  'complete',
]);

export type ServiceStep = z.infer<typeof ServiceStepSchema>;

// ── Per-service state ────────────────────────────────────────────────────────

export const ServiceStateSchema = z.object({
  index: z.number().int().min(1),
  agent_address: z.string(),
  safe_address: z.string().nullable(),
  service_id: z.number().nullable(),
  mech_address: z.string().nullable(),
  staking_address: z.string().nullable(),
  step: ServiceStepSchema,
  error: z.string().nullable(),
});

export type ServiceState = z.infer<typeof ServiceStateSchema>;

// ── Fleet state (top-level) ──────────────────────────────────────────────────

export const FleetStateSchema = z.object({
  master_address: z.string().nullable(),
  chain: z.enum(['base', 'base-sepolia']),
  staking_mode: StakingModeSchema.default('standard'),
  services: z.array(ServiceStateSchema),
  updated_at: z.string(),
});

export type FleetState = z.infer<typeof FleetStateSchema>;

// ── Factories ────────────────────────────────────────────────────────────────

export function createDefaultFleetState(chain: 'base' | 'base-sepolia' = 'base'): FleetState {
  return {
    master_address: null,
    chain,
    staking_mode: 'standard',
    services: [],
    updated_at: new Date().toISOString(),
  };
}

export function createDefaultServiceState(index: number, agentAddress: string): ServiceState {
  return {
    index,
    agent_address: agentAddress,
    safe_address: null,
    service_id: null,
    mech_address: null,
    staking_address: null,
    step: 'awaiting_stake',
    error: null,
  };
}

// ── Result types ─────────────────────────────────────────────────────────────

export interface FundingRequirement {
  master_address: string;
  eth_required: string;
  eth_balance: string;
}

export interface FleetBootstrapResult {
  ok: boolean;
  fleet_state: FleetState;
  message: string;
  funding?: FundingRequirement;
}

// ── Legacy type re-exports for backward compatibility during migration ────────

/** @deprecated Use ServiceStep */
export type EarningStep = ServiceStep;
/** @deprecated Use FleetState */
export type EarningState = FleetState;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && npx vitest run test/earning/types.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/earning/types.ts client/test/earning/types.test.ts
git commit -m "feat(earning): replace EarningState with FleetState + ServiceState schemas"
```

---

### Task 3: Update store for fleet state + mnemonic keystore

**Files:**
- Modify: `client/src/earning/store.ts`
- Modify: `client/test/earning/bootstrap.test.ts` (adjust imports)

- [ ] **Step 1: Rewrite store.ts**

Replace `client/src/earning/store.ts` with:

```typescript
/**
 * Fleet state persistence.
 *
 * State lives at ~/.jinn-client/earning/earning_state.json.
 * Mnemonic keystore lives at ~/.jinn-client/earning/master_keystore.json.
 * Legacy keystore (if present) at ~/.jinn-client/earning/agent_keystore.json.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  type FleetState,
  type ServiceState,
  FleetStateSchema,
  createDefaultFleetState,
} from './types.js';

export const DEFAULT_EARNING_DIR = path.join(os.homedir(), '.jinn-client', 'earning');

const STATE_FILE = 'earning_state.json';
const MNEMONIC_KEYSTORE_FILE = 'master_keystore.json';
const LEGACY_KEYSTORE_FILE = 'agent_keystore.json';

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

function parseFleetStateOrNull(raw: string): FleetState | null {
  try {
    const parsed = JSON.parse(raw);
    const result = FleetStateSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    console.error(
      '[earning-store] Invalid state schema; resetting. Issues:',
      result.error.issues.map((issue) => issue.path.join('.')),
    );
    return null;
  } catch (error) {
    console.error('[earning-store] Failed to parse state; resetting:', error);
    return null;
  }
}

export class FleetStateStore {
  private readonly statePath: string;
  private readonly mnemonicKeystorePath: string;
  private readonly legacyKeystorePath: string;
  private readonly earningDir: string;

  constructor(earningDir: string = DEFAULT_EARNING_DIR) {
    this.earningDir = earningDir;
    this.statePath = path.join(earningDir, STATE_FILE);
    this.mnemonicKeystorePath = path.join(earningDir, MNEMONIC_KEYSTORE_FILE);
    this.legacyKeystorePath = path.join(earningDir, LEGACY_KEYSTORE_FILE);
  }

  get dir(): string {
    return this.earningDir;
  }

  // ── Mnemonic keystore ──────────────────────────────────────────────────

  hasMnemonicKeystore(): boolean {
    return existsSync(this.mnemonicKeystorePath);
  }

  async loadMnemonicKeystore(): Promise<string> {
    return readFile(this.mnemonicKeystorePath, 'utf8');
  }

  async saveMnemonicKeystore(encryptedJson: string): Promise<void> {
    await writeJsonAtomic(this.mnemonicKeystorePath, JSON.parse(encryptedJson));
  }

  // ── Legacy detection ───────────────────────────────────────────────────

  hasLegacyKeystore(): boolean {
    return existsSync(this.legacyKeystorePath);
  }

  async migrateLegacyFiles(): Promise<void> {
    if (existsSync(this.legacyKeystorePath)) {
      await rename(this.legacyKeystorePath, `${this.legacyKeystorePath}.legacy`);
    }
    if (existsSync(this.statePath)) {
      await rename(this.statePath, `${this.statePath}.legacy`);
    }
    console.error(
      '[earning-store] Legacy keystore detected. Old files renamed with .legacy suffix. ' +
      'A new mnemonic wallet will be generated.',
    );
  }

  // ── Fleet state ────────────────────────────────────────────────────────

  async load(chain: 'base' | 'base-sepolia' = 'base'): Promise<FleetState> {
    if (!existsSync(this.statePath)) {
      const state = createDefaultFleetState(chain);
      await writeJsonAtomic(this.statePath, state);
      return state;
    }

    const raw = await readFile(this.statePath, 'utf8');
    const parsed = parseFleetStateOrNull(raw);

    if (parsed) {
      return parsed;
    }

    const backupPath = `${this.statePath}.invalid-${Date.now()}`;
    await rename(this.statePath, backupPath);

    const state = createDefaultFleetState(chain);
    await writeJsonAtomic(this.statePath, state);
    console.error(`[earning-store] Backed up invalid state to ${backupPath}`);
    return state;
  }

  async save(state: FleetState): Promise<FleetState> {
    const next: FleetState = {
      ...state,
      updated_at: new Date().toISOString(),
    };
    const validated = FleetStateSchema.parse(next);
    await writeJsonAtomic(this.statePath, validated);
    return validated;
  }

  async patchFleet(patch: Partial<Omit<FleetState, 'services'>>): Promise<FleetState> {
    const current = await this.load();
    return this.save({ ...current, ...patch });
  }

  async updateService(index: number, patch: Partial<ServiceState>): Promise<FleetState> {
    const current = await this.load();
    const svcIdx = current.services.findIndex(s => s.index === index);
    if (svcIdx === -1) {
      throw new Error(`Service at index ${index} not found in state`);
    }
    current.services[svcIdx] = { ...current.services[svcIdx], ...patch };
    return this.save(current);
  }

  async addService(service: ServiceState): Promise<FleetState> {
    const current = await this.load();
    current.services.push(service);
    return this.save(current);
  }
}

/** @deprecated Use FleetStateStore */
export const EarningStateStore = FleetStateStore;
```

- [ ] **Step 2: Run type check**

Run: `cd client && npx tsc --noEmit`

This will produce errors in `bootstrap.ts`, `main.ts`, and existing tests because they reference the old types. That's expected — we'll fix those in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add client/src/earning/store.ts
git commit -m "feat(earning): rewrite store for fleet state + mnemonic keystore"
```

---

### Task 4: Rewrite bootstrap for fleet architecture

**Files:**
- Modify: `client/src/earning/bootstrap.ts`

This is the largest task. The bootstrapper becomes fleet-aware: it manages a master wallet and bootstraps multiple services.

- [ ] **Step 1: Rewrite bootstrap.ts**

Replace `client/src/earning/bootstrap.ts` with the fleet-aware implementation. The key structural changes:

1. Constructor takes `FleetBootstrapperOptions` (adds `targetServices`)
2. `bootstrap()` orchestrates: master setup → per-service loop
3. Master setup: generate mnemonic, check ETH funding
4. Per-service: derive agent, call `distributor.stake()`, deploy mech
5. Self-bond mode preserved but uses derived agent keys instead of master key

The full file is large (~600 lines). Here is the structure:

```typescript
/**
 * Fleet bootstrap state machine.
 *
 * Phase 1 (master): generate mnemonic → fund master EOA
 * Phase 2 (per-service): derive agent → stake → deploy mech
 */

import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
} from 'ethers';
import {
  type ChainConfig,
  ERC20_ABI,
  EVENT_TOPICS,
  SERVICE_MANAGER_ABI,
  SERVICE_REGISTRY_APPROVE_ABI,
  SERVICE_REGISTRY_L2_ABI,
  STAKING_ABI,
  MECH_MARKETPLACE_CREATE_ABI,
  STOLAS_DISTRIBUTOR,
  STOLAS_DISTRIBUTOR_ABI,
  STOLAS_STAKING_SLOTS_ABI,
  cidToBytes32,
  getChainConfig,
} from './contracts.js';
import {
  type SafeInstance,
  executeSafeTxBatch,
  executeSafeTxDirect,
  initDeployedSafe,
  initPredictedSafe,
} from './safe-adapter.js';
import { FleetStateStore } from './store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  deriveMasterAddress,
  deriveMasterSigner,
  deriveAgentAddress,
  deriveAgentSigner,
} from './wallet.js';
import type {
  FleetState,
  FleetBootstrapResult,
  FundingRequirement,
  ServiceState,
  ServiceStep,
  StakingMode,
} from './types.js';
import { createDefaultServiceState } from './types.js';

export interface FleetBootstrapperOptions {
  earningDir?: string;
  chain?: 'base' | 'base-sepolia';
  rpcUrl?: string;
  stakingMode?: 'standard' | 'self-bond';
  targetServices?: number;
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
}

export class FleetBootstrapper {
  private readonly store: FleetStateStore;
  private readonly config: ChainConfig;
  private readonly provider: JsonRpcProvider;
  private readonly chain: 'base' | 'base-sepolia';
  private readonly stakingMode: StakingMode;
  private readonly targetServices: number;

  constructor(options: FleetBootstrapperOptions = {}) {
    this.store = new FleetStateStore(options.earningDir);
    this.chain = options.chain ?? 'base';
    this.stakingMode = options.stakingMode ?? 'standard';
    this.targetServices = options.targetServices ?? 1;
    this.config = getChainConfig(this.chain, {
      testnetL2DeploymentPath: options.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: options.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: options.testnetMechDeploymentPath,
    });

    if (options.rpcUrl) {
      this.config.rpcUrl = options.rpcUrl;
    }

    this.provider = new JsonRpcProvider(this.config.rpcUrl);
  }

  async getStatus(): Promise<FleetState> {
    return this.store.load(this.chain);
  }

  async bootstrap(password: string): Promise<FleetBootstrapResult> {
    // Handle legacy keystore migration
    if (!this.store.hasMnemonicKeystore() && this.store.hasLegacyKeystore()) {
      await this.store.migrateLegacyFiles();
    }

    let state = await this.store.load(this.chain);

    try {
      // Phase 1: Master wallet setup
      state = await this.ensureMasterWallet(state, password);

      // Phase 1b: Check master funding
      const masterAddress = state.master_address!;
      const masterBalance = await this.provider.getBalance(masterAddress);
      if (masterBalance < this.config.minEoaGasEth) {
        return {
          ok: false,
          fleet_state: state,
          message: `Fund master wallet with ETH, then re-run.`,
          funding: {
            master_address: masterAddress,
            eth_required: this.config.minEoaGasEth.toString(),
            eth_balance: masterBalance.toString(),
          },
        };
      }

      // Phase 2: Bootstrap services up to target
      const mnemonic = await decryptMnemonic(
        await this.store.loadMnemonicKeystore(),
        password,
      );

      const completedCount = state.services.filter(s => s.step === 'complete').length;
      const needed = this.targetServices - completedCount;

      if (needed > 0) {
        console.error(`[fleet-bootstrap] ${completedCount}/${this.targetServices} services complete, bootstrapping ${needed} more`);
      }

      for (let i = 0; i < needed; i++) {
        const nextIndex = state.services.length + 1;
        state = await this.bootstrapService(state, mnemonic, nextIndex);
      }

      // Also resume any incomplete services
      for (const svc of state.services) {
        if (svc.step !== 'complete') {
          state = await this.resumeService(state, mnemonic, svc.index);
        }
      }

      return {
        ok: true,
        fleet_state: state,
        message: `Fleet bootstrap complete. ${state.services.filter(s => s.step === 'complete').length}/${this.targetServices} services running.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[fleet-bootstrap] Bootstrap failed:`, error);
      return {
        ok: false,
        fleet_state: state,
        message: `Fleet bootstrap failed: ${message}`,
      };
    }
  }

  // ── Phase 1: Master wallet ───────────────────────────────────────────

  private async ensureMasterWallet(
    state: FleetState,
    password: string,
  ): Promise<FleetState> {
    if (this.store.hasMnemonicKeystore() && state.master_address) {
      return state;
    }

    console.error('[fleet-bootstrap] Generating new HD wallet...');
    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, password);
    await this.store.saveMnemonicKeystore(encrypted);

    const masterAddress = deriveMasterAddress(mnemonic);
    console.error(`[fleet-bootstrap] Master address: ${masterAddress}`);

    return this.store.patchFleet({
      master_address: masterAddress,
      chain: this.chain,
      staking_mode: this.stakingMode,
    });
  }

  // ── Phase 2: Per-service bootstrap ───────────────────────────────────

  private async bootstrapService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const agentAddress = deriveAgentAddress(mnemonic, index);
    const svc = createDefaultServiceState(index, agentAddress);

    console.error(`[fleet-bootstrap] Service ${index}: agent ${agentAddress}`);
    state = await this.store.addService(svc);

    return this.resumeService(state, mnemonic, index);
  }

  private async resumeService(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index);
    if (!svc) throw new Error(`Service ${index} not found in state`);
    if (svc.step === 'complete') return state;

    if (svc.step === 'awaiting_stake') {
      state = await this.stepStolasStake(state, mnemonic, index);
    }

    // Reload service state after stake
    const updatedSvc = (await this.store.load(this.chain)).services.find(s => s.index === index);
    if (!updatedSvc) throw new Error(`Service ${index} disappeared from state`);

    if (updatedSvc.step === 'staked' || updatedSvc.step === 'mech_deployed') {
      state = await this.stepDeployMech(state, mnemonic, index);
    }

    return this.store.load(this.chain);
  }

  private async stepStolasStake(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;

    // Idempotency: if service already has a service_id, check if staked
    if (svc.service_id !== null) {
      const stakingState = await this.getStakingState(svc.service_id);
      if (stakingState === 1) {
        console.error(`[fleet-bootstrap] Service ${index} already staked, skipping`);
        return this.store.updateService(index, { step: 'staked' });
      }
    }

    // Preflight
    await this.stolasPreflightCheck();

    // Master EOA signs the stake() call
    const masterSigner = deriveMasterSigner(mnemonic);
    const masterWithProvider = masterSigner.connect(this.provider);
    const agentAddress = svc.agent_address;

    const configHashBytes = cidToBytes32(this.config.serviceHash);
    const distributorIface = new Interface(STOLAS_DISTRIBUTOR_ABI);
    const stakeData = distributorIface.encodeFunctionData('stake', [
      this.config.stakingContract,
      0,
      this.config.agentId,
      configHashBytes,
      agentAddress,
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: calling distributor.stake() from master`);
    const txResponse = await masterWithProvider.sendTransaction({
      to: STOLAS_DISTRIBUTOR,
      data: stakeData,
      gasLimit: 2_500_000n,
    });

    const receipt = await txResponse.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`stOLAS stake() tx failed for service ${index}: ${txResponse.hash}`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: stake() confirmed (tx: ${txResponse.hash})`);

    // Parse events
    const serviceId = await this.parseServiceIdFromReceipt(receipt);
    if (serviceId === null) {
      throw new Error(`stake() succeeded but CreateService event not found (tx: ${txResponse.hash})`);
    }

    const safeAddress = this.parseMultisigFromReceipt(receipt);
    if (!safeAddress) {
      throw new Error(`stake() succeeded but CreateMultisigWithAgents event not found (tx: ${txResponse.hash})`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: id=${serviceId}, safe=${safeAddress}`);

    return this.store.updateService(index, {
      service_id: serviceId,
      safe_address: safeAddress,
      staking_address: this.config.stakingContract,
      step: 'staked',
    });
  }

  private async stepDeployMech(
    state: FleetState,
    mnemonic: string,
    index: number,
  ): Promise<FleetState> {
    const svc = state.services.find(s => s.index === index)!;

    if (svc.mech_address) {
      console.error(`[fleet-bootstrap] Service ${index}: mech already deployed at ${svc.mech_address}`);
      return this.store.updateService(index, { step: 'complete' });
    }

    const serviceId = svc.service_id!;
    const safeAddress = svc.safe_address!;

    // Fund agent with gas from master
    const masterSigner = deriveMasterSigner(mnemonic);
    const masterWithProvider = masterSigner.connect(this.provider);
    const agentBalance = await this.provider.getBalance(svc.agent_address);

    if (agentBalance < this.config.minSafeEth) {
      const fundAmount = this.config.minSafeEth - agentBalance;
      console.error(`[fleet-bootstrap] Service ${index}: funding agent with ${fundAmount} wei`);
      const fundTx = await masterWithProvider.sendTransaction({
        to: svc.agent_address,
        value: fundAmount,
      });
      await fundTx.wait();
    }

    // Deploy mech via the service Safe (agent is Safe owner)
    const agentSigner = deriveAgentSigner(mnemonic, index);
    const agentKey = agentSigner.privateKey;

    const safe = await initDeployedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      safeAddress,
    });

    const mechMarketplaceIface = new Interface(MECH_MARKETPLACE_CREATE_ABI);
    const { AbiCoder } = await import('ethers');
    const payload = AbiCoder.defaultAbiCoder().encode(['uint256'], [this.config.mechRequestPrice]);

    const createData = mechMarketplaceIface.encodeFunctionData('create', [
      serviceId,
      this.config.mechFactory,
      payload,
    ]);

    console.error(`[fleet-bootstrap] Service ${index}: deploying mech`);
    const result = await executeSafeTxBatch(safe, [
      { to: this.config.mechMarketplace, value: '0', data: createData },
    ]);

    const mechReceipt = await this.provider.waitForTransaction(result.hash, 1, 30000);
    if (!mechReceipt || mechReceipt.status === 0) {
      throw new Error(`Mech deployment tx failed for service ${index}: ${result.hash}`);
    }

    // Parse CreateMech event
    const createMechTopic = '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6';
    let mechAddress: string | null = null;
    for (const log of mechReceipt.logs) {
      if (log.topics[0] === createMechTopic && log.topics.length >= 2) {
        mechAddress = getAddress('0x' + log.topics[1].slice(26));
        break;
      }
    }

    if (!mechAddress) {
      throw new Error(`CreateMech event not found for service ${index} (tx: ${result.hash})`);
    }

    console.error(`[fleet-bootstrap] Service ${index}: mech deployed at ${mechAddress}`);

    return this.store.updateService(index, {
      mech_address: mechAddress,
      step: 'complete',
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async stolasPreflightCheck(): Promise<void> {
    const distributor = new Contract(STOLAS_DISTRIBUTOR, STOLAS_DISTRIBUTOR_ABI, this.provider);
    const proxyConfig: bigint = await distributor.mapStakingProxyConfigs(this.config.stakingContract);
    if (proxyConfig === 0n) {
      throw new Error(
        `stOLAS distributor not configured for ${this.config.stakingContract}. ` +
        `Use stakingMode: 'self-bond' or contact the stOLAS team.`,
      );
    }

    const staking = new Contract(this.config.stakingContract, STOLAS_STAKING_SLOTS_ABI, this.provider);
    const serviceIds: bigint[] = await staking.getServiceIds();
    const maxServices: bigint = await staking.maxNumServices();
    const slotsRemaining = Number(maxServices) - serviceIds.length;

    if (slotsRemaining <= 0) {
      throw new Error(`All ${maxServices} staking slots occupied. Try again later.`);
    }

    console.error(`[fleet-bootstrap] Preflight passed: ${slotsRemaining} slots remaining`);
  }

  private async getStakingState(serviceId: number): Promise<number> {
    const staking = new Contract(this.config.stakingContract, STAKING_ABI, this.provider);
    return Number(await staking.getStakingState(serviceId));
  }

  private async parseServiceIdFromReceipt(receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] }): Promise<number | null> {
    const registryIface = new Interface(SERVICE_REGISTRY_L2_ABI);
    const createServiceTopic = EVENT_TOPICS.CreateService;
    const serviceRegistryAddress = this.config.serviceRegistry.toLowerCase();

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() !== serviceRegistryAddress ||
        log.topics[0] !== createServiceTopic
      ) {
        continue;
      }
      try {
        const parsed = registryIface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.args.serviceId !== undefined) {
          return Number(parsed.args.serviceId);
        }
      } catch {
        // Not a matching event
      }
    }
    return null;
  }

  private parseMultisigFromReceipt(receipt: { logs: readonly { topics: readonly string[] }[] }): string | null {
    const topic = EVENT_TOPICS.CreateMultisigWithAgents;
    for (const log of receipt.logs) {
      if (log.topics[0] === topic && log.topics.length >= 3) {
        return getAddress('0x' + log.topics[2].slice(26));
      }
    }
    return null;
  }
}

/** @deprecated Use FleetBootstrapper */
export const EarningBootstrapper = FleetBootstrapper;
```

- [ ] **Step 2: Run type check**

Run: `cd client && npx tsc --noEmit`
Expected: Errors only in `main.ts` and test files (we'll fix those next)

- [ ] **Step 3: Commit**

```bash
git add client/src/earning/bootstrap.ts
git commit -m "feat(earning): rewrite bootstrap as fleet-aware FleetBootstrapper"
```

---

### Task 5: Add targetServices to config

**Files:**
- Modify: `client/src/config.ts`
- Modify: `client/test/config.test.ts`

- [ ] **Step 1: Add targetServices to JinnConfigSchema**

In `client/src/config.ts`, add to `JinnConfigSchema` after `stakingMode`:

```typescript
/** Number of services to bootstrap and run. */
targetServices: z.number().int().positive().default(1),
```

In the env override section of `loadConfig()`, add:

```typescript
if (env['JINN_TARGET_SERVICES'])    merged.targetServices = parseInt(env['JINN_TARGET_SERVICES'], 10);
```

- [ ] **Step 2: Add test**

Add to `client/test/config.test.ts`:

```typescript
it('defaults targetServices to 1', () => {
  const config = loadConfig();
  expect(config.targetServices).toBe(1);
});
```

- [ ] **Step 3: Run config tests**

Run: `cd client && npx vitest run test/config.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add client/src/config.ts client/test/config.test.ts
git commit -m "feat(config): add targetServices config field"
```

---

### Task 6: Update main.ts for fleet bootstrap

**Files:**
- Modify: `client/src/main.ts`

- [ ] **Step 1: Update main.ts**

Update `client/src/main.ts` to use `FleetBootstrapper` and read the first complete service:

```typescript
import { FleetBootstrapper } from './earning/bootstrap.js';
import { FleetStateStore } from './earning/store.js';
import {
  decryptMnemonic,
  deriveAgentSigner,
} from './earning/wallet.js';
```

Replace the `bootstrap()` function:

```typescript
async function bootstrap(): Promise<{
  agentPrivateKey: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress?: `0x${string}`;
}> {
  console.log('[main] Running fleet bootstrap...');

  const bootstrapper = new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: NETWORK_CHAIN,
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
  });

  const result = await bootstrapper.bootstrap(PASSWORD);

  if (result.funding) {
    console.log(`\nFund master wallet: ${result.funding.master_address}`);
    console.log(`  ETH required: ${result.funding.eth_required} wei`);
    console.log(`  ETH balance:  ${result.funding.eth_balance} wei`);
    console.log('\nFund the address above, then re-run.');
    process.exit(0);
  }

  if (!result.ok) {
    console.error(`[main] Bootstrap failed: ${result.message}`);
    process.exit(1);
  }

  // Use the first complete service for the daemon
  const state = result.fleet_state;
  const firstComplete = state.services.find(s => s.step === 'complete');
  if (!firstComplete || !firstComplete.safe_address) {
    console.error('[main] Bootstrap completed but no service is ready.');
    process.exit(1);
  }

  // Derive agent private key from mnemonic
  const store = new FleetStateStore(config.earningDir);
  const mnemonic = await decryptMnemonic(
    await store.loadMnemonicKeystore(),
    PASSWORD,
  );
  const agentSigner = deriveAgentSigner(mnemonic, firstComplete.index);

  console.log(`[main] Fleet bootstrap complete.`);
  console.log(`  Master:  ${state.master_address}`);
  console.log(`  Services: ${state.services.filter(s => s.step === 'complete').length}/${config.targetServices}`);
  console.log(`  Active:  service ${firstComplete.service_id} (agent ${firstComplete.agent_address})`);
  if (firstComplete.mech_address) {
    console.log(`  Mech:    ${firstComplete.mech_address}`);
  }

  return {
    agentPrivateKey: agentSigner.privateKey as `0x${string}`,
    safeAddress: firstComplete.safe_address as `0x${string}`,
    mechAddress: firstComplete.mech_address ? (firstComplete.mech_address as `0x${string}`) : undefined,
  };
}
```

Remove the old `EarningBootstrapper` and `EarningStateStore` imports.

- [ ] **Step 2: Run type check**

Run: `cd client && npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 3: Commit**

```bash
git add client/src/main.ts
git commit -m "feat(main): use FleetBootstrapper with HD wallet"
```

---

### Task 7: Rewrite bootstrap tests

**Files:**
- Modify: `client/test/earning/bootstrap.test.ts`

- [ ] **Step 1: Rewrite tests for fleet bootstrap**

Replace `client/test/earning/bootstrap.test.ts` with tests for the new fleet architecture. Key tests:

```typescript
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { generateMnemonic, encryptMnemonic } from '../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../src/earning/types.js';

describe('Fleet bootstrap', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('generates mnemonic and pauses at funding on first run', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    // Mock provider to return 0 balance
    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(result.funding!.master_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.funding!.eth_balance).toBe('0');

    // Verify mnemonic keystore was created
    const store = new FleetStateStore(earningDir);
    expect(store.hasMnemonicKeystore()).toBe(true);

    // Verify state has master address
    const state = await store.load();
    expect(state.master_address).toBe(result.funding!.master_address);
    expect(state.services).toEqual([]);
  });

  it('detects legacy keystore and migrates', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const store = new FleetStateStore(earningDir);

    // Create a fake legacy keystore
    const { writeFile, mkdir } = await import('fs/promises');
    await mkdir(earningDir, { recursive: true });
    await writeFile(path.join(earningDir, 'agent_keystore.json'), '{"fake":"legacy"}');

    expect(store.hasLegacyKeystore()).toBe(true);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
    });

    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(0n);

    await bootstrapper.bootstrap('test-password');

    // Legacy file should be renamed
    expect(store.hasLegacyKeystore()).toBe(false);
    // New mnemonic keystore should exist
    expect(store.hasMnemonicKeystore()).toBe(true);
  });

  it('resumes from existing state without regenerating mnemonic', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    // Pre-create mnemonic keystore
    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    // Pre-create state with master address
    const { deriveMasterAddress } = await import('../../src/earning/wallet.js');
    const masterAddr = deriveMasterAddress(mnemonic);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
    });

    // Master is funded but provider mock prevents actual stake
    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);
    vi.spyOn(bootstrapper as any, 'stolasPreflightCheck').mockResolvedValue(undefined);
    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(async (state: any, _m: any, index: number) => {
      return store.addService({
        index,
        agent_address: '0x0000000000000000000000000000000000000001',
        safe_address: '0x0000000000000000000000000000000000000002',
        service_id: 99,
        mech_address: null,
        staking_address: '0x0000000000000000000000000000000000000003',
        step: 'staked',
        error: null,
      });
    });
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(async (_s: any, _m: any, index: number) => {
      return store.updateService(index, { mech_address: '0x0000000000000000000000000000000000000004', step: 'complete' });
    });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.services).toHaveLength(1);
    expect(result.fleet_state.services[0].step).toBe('complete');
    expect(result.fleet_state.master_address).toBe(masterAddr);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd client && npx vitest run test/earning/bootstrap.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add client/test/earning/bootstrap.test.ts
git commit -m "test(earning): rewrite bootstrap tests for fleet architecture"
```

---

### Task 8: Update stolas-validate.ts and full validation

**Files:**
- Modify: `client/scripts/stolas-validate.ts`

- [ ] **Step 1: Update validation script**

Update `client/scripts/stolas-validate.ts` to use `FleetBootstrapper` instead of `EarningBootstrapper`. Key changes:

- Replace `EarningBootstrapper` import with `FleetBootstrapper`
- Phase 3: expect `result.funding.master_address` instead of `result.funding.eoa_address`
- Phase 4: fund `master_address` instead of EOA
- Phase 5: use `FleetBootstrapper` with `stakingMode: 'standard'`
- Phase 6: read `result.fleet_state.services[0]` for service ID, Safe, mech

- [ ] **Step 2: Run type check**

Run: `cd client && npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 3: Run full test suite**

Run: `cd client && npx vitest run`
Expected: ALL tests pass

- [ ] **Step 4: Run stOLAS validation on Anvil fork**

Run: `cd client && npm run stolas`
Expected: All phases pass

- [ ] **Step 5: Commit**

```bash
git add client/scripts/stolas-validate.ts
git commit -m "test: update stolas-validate for fleet bootstrap"
```

---

### Task 9: Final cleanup and type check

**Files:** Various (fix any remaining issues)

- [ ] **Step 1: Run TypeScript compiler**

Run: `cd client && npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 2: Run full test suite**

Run: `cd client && npx vitest run`
Expected: ALL tests pass

- [ ] **Step 3: Run stOLAS Anvil validation**

Run: `cd client && npm run stolas`
Expected: All phases pass — wallet generation, funding, staking, mech deploy, on-chain verification

- [ ] **Step 4: Commit any fixes**

```bash
git add -u client/
git commit -m "fix: resolve remaining type/test issues from fleet architecture"
```

(Skip if no fixes needed.)
