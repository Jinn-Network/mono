# Substrate foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codify the test-operator substrate lifecycle as four production TypeScript scripts (`substrate-adopt`, `substrate-copy`, `substrate-verify`, `substrate-topup`) plus a workspace reaper. Each ships with unit + integration tests and a yarn-script entry point. The gold substrate already exists on disk (adopted manually 2026-05-19 during the spec brainstorm); this plan replaces the manual adoption with idempotent reproducible scripts.

**Architecture:** Single shared types module (Zod schemas) feeds five focused scripts that each export a callable function plus a CLI main. Tests live alongside under `client/test/release/substrate/` and use Vitest with `tmp` dirs for filesystem isolation and an Anvil fork helper for on-chain reads (matches the existing `client/scripts/staking-validate.ts` test pattern).

**Tech Stack:** TypeScript, Zod for schema validation (matches `client/src/earning/types.ts`), viem for on-chain reads (matches `client/src/earning/contracts.ts`), node:fs/promises for filesystem, Vitest for tests, Anvil fork for integration tests.

---

## File structure

**Source files (all new under `client/scripts/release/`):**

| Path | Responsibility |
|---|---|
| `client/scripts/release/types.ts` | Zod schemas: `ManifestSchema`, `VerifyResult`, `TopupResult` |
| `client/scripts/release/substrate-paths.ts` | Path helpers: `goldPath()`, `workspacePath()`, `workspacesRoot()` |
| `client/scripts/release/substrate-adopt.ts` | Adopt: copy from existing operator dir → gold dir, write manifest |
| `client/scripts/release/substrate-copy.ts` | Per-run workspace copy from gold, port rewriting |
| `client/scripts/release/substrate-verify.ts` | Manifest validation + on-chain identity check |
| `client/scripts/release/substrate-topup.ts` | Balance check + low-balance gap surfacing (no auto-drip) |
| `client/scripts/release/substrate-reap.ts` | Workspace garbage collection (>7 days) |
| `client/scripts/release/README.md` | Usage documentation |

**Test files (all new under `client/test/release/substrate/`):**

| Path | Covers |
|---|---|
| `client/test/release/substrate/types.test.ts` | Manifest schema parse/validate |
| `client/test/release/substrate/substrate-paths.test.ts` | Path resolution |
| `client/test/release/substrate/adopt.test.ts` | Adopt + verify cycle on fixtures |
| `client/test/release/substrate/copy.test.ts` | Workspace creation + port rewriting |
| `client/test/release/substrate/verify.test.ts` | Manifest validation + on-chain (Anvil fork) |
| `client/test/release/substrate/topup.test.ts` | Balance check report (Anvil fork) |
| `client/test/release/substrate/reap.test.ts` | Workspace age-based pruning |
| `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/*` | Minimal valid operator state |
| `client/test/release/substrate/fixtures/op-b-fixture/.jinn-client/*` | Second fixture operator |
| `client/test/release/substrate/helpers/anvil-fork.ts` | Anvil fork helper for integration tests |
| `client/test/release/substrate/helpers/tmp-substrate.ts` | tmp-dir substrate helper for isolation |

**Modified files:**

| Path | Change |
|---|---|
| `client/package.json` | Add yarn scripts: `substrate:adopt`, `substrate:copy`, `substrate:verify`, `substrate:topup`, `substrate:reap` |

---

## Task 1: Manifest schema and shared types

**Files:**
- Create: `client/scripts/release/types.ts`
- Test: `client/test/release/substrate/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/substrate/types.test.ts
import { describe, it, expect } from 'vitest';
import { ManifestSchema, type Manifest } from '../../../scripts/release/types';

describe('ManifestSchema', () => {
  const validManifest = {
    substrateVersion: '1',
    createdAt: '2026-05-19T14:47:19Z',
    adoptedFrom: '~/.jinn-client/',
    name: 'op-a',
    shape: 'current' as const,
    role: 'launcher' as const,
    network: 'base-sepolia' as const,
    operator: {
      masterAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      fleetAgentId: '5474',
      fleetSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
      fleetStage: 'stage1_and_2',
      serviceId: 46,
      serviceStep: 'complete',
      agentEoa: '0x63192d38350b796856cF002caC25c377D9A0DB5A',
      safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
      mechAddress: '0x9c415369D0597e4867F419d256BD61D16a8C47b5',
      stakingAddress: '0x24e34E5037956a5Feca1AAAfaA30297084C228B8',
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    },
    config: {
      apiPort: 7332,
      rpcUrl: 'https://base-sepolia.gateway.tenderly.co/abc',
      joinedSolverNets: ['bafkrei123'],
    },
  };

  it('parses a valid manifest', () => {
    const parsed = ManifestSchema.parse(validManifest);
    expect(parsed.name).toBe('op-a');
    expect(parsed.operator.fleetAgentId).toBe('5474');
  });

  it('rejects missing required field', () => {
    const invalid = { ...validManifest, name: undefined };
    expect(() => ManifestSchema.parse(invalid)).toThrow();
  });

  it('rejects invalid network value', () => {
    const invalid = { ...validManifest, network: 'mainnet-pro' };
    expect(() => ManifestSchema.parse(invalid)).toThrow();
  });

  it('accepts pre-fleet shape with null fleet fields', () => {
    const preFleet: Manifest = {
      ...validManifest,
      name: 'op-c-legacy',
      shape: 'pre-fleet',
      role: 'legacy-backup',
      operator: {
        ...validManifest.operator,
        fleetAgentId: null,
        fleetSafeAddress: null,
        fleetStage: null,
      },
    };
    expect(() => ManifestSchema.parse(preFleet)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/release/substrate/types.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/release/types'`

- [ ] **Step 3: Write the schema and types**

```typescript
// client/scripts/release/types.ts
import { z } from 'zod';

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

const ShapeSchema = z.enum(['current', 'pre-fleet']);
const RoleSchema = z.enum(['launcher', 'participant', 'legacy-backup']);
const NetworkSchema = z.enum(['base-sepolia', 'base']);

const OperatorSchema = z.object({
  masterAddress: AddressSchema,
  fleetAgentId: z.string().nullable(),
  fleetSafeAddress: AddressSchema.nullable(),
  fleetStage: z.string().nullable(),
  serviceId: z.number().int().positive(),
  serviceStep: z.string(),
  agentEoa: AddressSchema,
  safeAddress: AddressSchema,
  mechAddress: AddressSchema,
  stakingAddress: AddressSchema,
  identityRegistry: AddressSchema,
});

const ConfigSchema = z.object({
  apiPort: z.number().int().positive(),
  rpcUrl: z.string().url(),
  joinedSolverNets: z.array(z.string()),
});

export const ManifestSchema = z.object({
  substrateVersion: z.literal('1'),
  createdAt: z.string().datetime(),
  adoptedFrom: z.string(),
  name: z.string(),
  shape: ShapeSchema,
  role: RoleSchema,
  network: NetworkSchema,
  operator: OperatorSchema,
  config: ConfigSchema,
});

export type Manifest = z.infer<typeof ManifestSchema>;

export interface VerifyResult {
  opName: string;
  ok: boolean;
  failures: string[];           // each entry describes one failed check
  warnings: string[];           // each entry describes a non-blocking concern
  onChain: {
    boundSafeAddress: string | null;
    ethBalanceWei: bigint;
    olasBalanceWei: bigint | null;
  } | null;                     // null if on-chain check was skipped
}

export interface TopupResult {
  opName: string;
  needs: { resource: 'ETH' | 'USDC'; have: bigint; want: bigint }[];
  ok: boolean;                  // true if all balances above their topup-trigger threshold
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/release/substrate/types.test.ts`
Expected: PASS, 4 tests passing

- [ ] **Step 5: Commit**

```bash
git add client/scripts/release/types.ts client/test/release/substrate/types.test.ts
git commit -m "feat(substrate): add manifest schema and shared types"
```

---

## Task 2: Path resolution helpers

**Files:**
- Create: `client/scripts/release/substrate-paths.ts`
- Test: `client/test/release/substrate/substrate-paths.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/substrate/substrate-paths.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import {
  goldPath,
  workspacePath,
  workspacesRoot,
  defaultSubstrateRoot,
} from '../../../scripts/release/substrate-paths';

describe('substrate-paths', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it('defaultSubstrateRoot resolves to ~/jinn-dev under HOME', () => {
    process.env.HOME = '/Users/test';
    expect(defaultSubstrateRoot()).toBe('/Users/test/jinn-dev');
  });

  it('goldPath composes correctly', () => {
    process.env.HOME = '/Users/test';
    expect(goldPath('op-a')).toBe('/Users/test/jinn-dev/operators/op-a');
    expect(goldPath('op-b')).toBe('/Users/test/jinn-dev/operators/op-b');
  });

  it('workspacePath composes correctly', () => {
    process.env.HOME = '/Users/test';
    expect(workspacePath('run-123', 'op-a')).toBe('/Users/test/jinn-dev/workspaces/run-123/op-a');
  });

  it('workspacesRoot returns the workspaces dir', () => {
    process.env.HOME = '/Users/test';
    expect(workspacesRoot()).toBe('/Users/test/jinn-dev/workspaces');
  });

  it('accepts a custom substrateRoot override', () => {
    expect(goldPath('op-a', '/custom/root')).toBe('/custom/root/operators/op-a');
    expect(workspacePath('run-1', 'op-a', '/custom/root')).toBe('/custom/root/workspaces/run-1/op-a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/release/substrate/substrate-paths.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/release/substrate-paths'`

- [ ] **Step 3: Write the helpers**

```typescript
// client/scripts/release/substrate-paths.ts
import * as path from 'node:path';
import * as os from 'node:os';

export function defaultSubstrateRoot(): string {
  // Use HOME env var first so tests can override (Task 2's tests set process.env.HOME).
  // `||` not `??` so an empty-string HOME also falls back to os.homedir().
  return path.join(process.env.HOME || os.homedir(), 'jinn-dev');
}

export function goldPath(opName: string, substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(substrateRoot, 'operators', opName);
}

export function workspacesRoot(substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(substrateRoot, 'workspaces');
}

export function workspacePath(runId: string, opName: string, substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(workspacesRoot(substrateRoot), runId, opName);
}

export function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/release/substrate/substrate-paths.test.ts`
Expected: PASS, 5 tests passing

- [ ] **Step 5: Commit**

```bash
git add client/scripts/release/substrate-paths.ts client/test/release/substrate/substrate-paths.test.ts
git commit -m "feat(substrate): add path resolution helpers"
```

---

## Task 3: Fixture operators for tests

**Files:**
- Create: `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/config.json`
- Create: `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/keystore-password`
- Create: `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/earning/earning_state.json`
- Create: `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/earning/master_keystore.json`
- Create: `client/test/release/substrate/fixtures/op-b-fixture/.jinn-client/...` (same shape, different identity)
- Create: `client/test/release/substrate/fixtures/README.md`

- [ ] **Step 1: Create the op-a-fixture config.json**

```bash
mkdir -p client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/earning
```

```json
{
  "network": "testnet",
  "rpcUrl": "https://base-sepolia.example/fixture-key",
  "apiPort": 7332,
  "joinedSolverNets": {
    "bafkrei-fixture-cid": {
      "name": "fixture-swe-rebench",
      "manifestCid": "bafkrei-fixture-cid",
      "roles": ["solving"],
      "harness": "claude-code-learner",
      "plugins": [],
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

Save as `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/config.json`.

- [ ] **Step 2: Create op-a-fixture earning_state.json**

```json
{
  "master_address": "0x1111111111111111111111111111111111111111",
  "chain": "base-sepolia",
  "staking_mode": "standard",
  "services": [
    {
      "index": 1,
      "agent_address": "0x2222222222222222222222222222222222222222",
      "safe_address": "0x3333333333333333333333333333333333333333",
      "service_id": 9999,
      "mech_address": "0x4444444444444444444444444444444444444444",
      "staking_address": "0x5555555555555555555555555555555555555555",
      "step": "complete",
      "error": null,
      "agent_id": "99001",
      "agent_uri": "",
      "identity_registry_address": "0x6666666666666666666666666666666666666666",
      "agent_registered_tx": "0xfixture",
      "safe_bound_to_agent": true,
      "error_revert_reason": null,
      "error_short_message": null
    }
  ],
  "updated_at": "2026-05-01T00:00:00.000Z",
  "fleet_agent_id": "99001",
  "fleet_safe_address": "0x3333333333333333333333333333333333333333",
  "fleet_identity_registry": "0x6666666666666666666666666666666666666666",
  "fleet_stage": "stage1_and_2"
}
```

Save as `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/earning/earning_state.json`.

- [ ] **Step 3: Create op-a-fixture keystore + password**

```json
{ "version": 3, "id": "fixture-id", "address": "1111111111111111111111111111111111111111", "crypto": {"cipher": "aes-128-ctr", "ciphertext": "deadbeef", "cipherparams": {"iv": "00000000000000000000000000000000"}, "kdf": "scrypt", "kdfparams": {"dklen": 32, "n": 1024, "p": 1, "r": 8, "salt": "00"}, "mac": "00"} }
```

Save as `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/earning/master_keystore.json`.

```
fixture-password-not-real
```

Save as `client/test/release/substrate/fixtures/op-a-fixture/.jinn-client/keystore-password` (chmod 600 not needed for fixture but acceptable).

- [ ] **Step 4: Repeat for op-b-fixture with different addresses and apiPort 7333**

Create the same four files under `client/test/release/substrate/fixtures/op-b-fixture/.jinn-client/` with:
- `master_address`: `0x7777777777777777777777777777777777777777`
- `agent_id`: `99002`
- All other addresses bumped to `0xAAAA...`, `0xBBBB...`, etc.
- `apiPort`: 7333

- [ ] **Step 5: Add README explaining fixtures**

```markdown
# Substrate test fixtures

These are *not real* operator state. All addresses are placeholders (0x1111...,
0x2222...). They exist purely for unit tests of substrate-adopt, substrate-copy,
and substrate-verify. The on-chain identity referenced here does not exist on
any real chain; tests that exercise on-chain reads must use the Anvil fork
helper (`helpers/anvil-fork.ts`) to seed deterministic state.

Two fixtures:
- `op-a-fixture/` — launcher role, agentId 99001
- `op-b-fixture/` — participant role, agentId 99002
```

Save as `client/test/release/substrate/fixtures/README.md`.

- [ ] **Step 6: Commit**

```bash
git add client/test/release/substrate/fixtures/
git commit -m "test(substrate): add fixture operators for unit tests"
```

---

## Task 4: substrate-verify — manifest validation

**Files:**
- Create: `client/scripts/release/substrate-verify.ts`
- Test: `client/test/release/substrate/verify.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/substrate/verify.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { verifySubstrate } from '../../../scripts/release/substrate-verify';
import type { Manifest } from '../../../scripts/release/types';

describe('substrate-verify (manifest only)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-verify-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const validManifest: Manifest = {
    substrateVersion: '1',
    createdAt: '2026-05-19T14:47:19Z',
    adoptedFrom: '~/.jinn-client/',
    name: 'op-a',
    shape: 'current',
    role: 'launcher',
    network: 'base-sepolia',
    operator: {
      masterAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      fleetAgentId: '5474',
      fleetSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
      fleetStage: 'stage1_and_2',
      serviceId: 46,
      serviceStep: 'complete',
      agentEoa: '0x63192d38350b796856cF002caC25c377D9A0DB5A',
      safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
      mechAddress: '0x9c415369D0597e4867F419d256BD61D16a8C47b5',
      stakingAddress: '0x24e34E5037956a5Feca1AAAfaA30297084C228B8',
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    },
    config: {
      apiPort: 7332,
      rpcUrl: 'https://base-sepolia.example/x',
      joinedSolverNets: ['bafkrei1'],
    },
  };

  async function seedOp(name: string, manifest: Manifest | null): Promise<void> {
    const opDir = path.join(tmpRoot, 'operators', name);
    await fs.mkdir(opDir, { recursive: true });
    if (manifest !== null) {
      await fs.writeFile(path.join(opDir, 'manifest.json'), JSON.stringify(manifest));
    }
  }

  it('reports ok when manifest is valid and skipOnChain=true', async () => {
    await seedOp('op-a', validManifest);
    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: true });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports failure when manifest is missing', async () => {
    await seedOp('op-a', null);
    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: true });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('manifest.json'))).toBe(true);
  });

  it('reports failure when manifest fails schema validation', async () => {
    await fs.mkdir(path.join(tmpRoot, 'operators', 'op-a'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'operators', 'op-a', 'manifest.json'), '{"substrateVersion": "1"}');
    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: true });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.toLowerCase().includes('schema'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/release/substrate/verify.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/release/substrate-verify'`

- [ ] **Step 3: Write the substrate-verify manifest-only implementation**

```typescript
// client/scripts/release/substrate-verify.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ManifestSchema, type Manifest, type VerifyResult } from './types';
import { goldPath } from './substrate-paths';

export interface VerifyOptions {
  substrateRoot?: string;
  skipOnChain?: boolean;
}

export async function verifySubstrate(opName: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  const opDir = goldPath(opName, opts.substrateRoot);
  const manifestPath = path.join(opDir, 'manifest.json');

  // 1. Manifest exists
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    failures.push(`manifest.json not found at ${manifestPath}`);
    return { opName, ok: false, failures, warnings, onChain: null };
  }

  // 2. Manifest parses
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (err) {
    failures.push(`manifest.json is not valid JSON: ${(err as Error).message}`);
    return { opName, ok: false, failures, warnings, onChain: null };
  }

  // 3. Manifest validates against schema
  const parseResult = ManifestSchema.safeParse(manifestJson);
  if (!parseResult.success) {
    failures.push(`manifest.json failed schema validation: ${parseResult.error.message}`);
    return { opName, ok: false, failures, warnings, onChain: null };
  }
  const manifest: Manifest = parseResult.data;

  // 4. Name in manifest matches the op being verified
  if (manifest.name !== opName) {
    failures.push(`manifest.name=${manifest.name} does not match expected opName=${opName}`);
  }

  // 5. Sanity: gold dir contains .jinn-client structure
  const jinnClientDir = path.join(opDir, '.jinn-client');
  try {
    await fs.access(jinnClientDir);
  } catch {
    failures.push(`gold operator missing .jinn-client/ directory at ${jinnClientDir}`);
  }

  // 6. On-chain check (skip for now if requested)
  if (opts.skipOnChain) {
    return { opName, ok: failures.length === 0, failures, warnings, onChain: null };
  }

  // On-chain check implementation lands in Task 5
  warnings.push('on-chain check not yet implemented; skipping');
  return { opName, ok: failures.length === 0, failures, warnings, onChain: null };
}

async function cliMain(): Promise<void> {
  const opName = process.argv[2];
  if (!opName) {
    console.error('usage: substrate-verify <op-name> [--skip-on-chain]');
    process.exit(2);
  }
  const skipOnChain = process.argv.includes('--skip-on-chain');
  const result = await verifySubstrate(opName, { skipOnChain });
  // BigInts in result.onChain (ethBalanceWei, olasBalanceWei) crash JSON.stringify
  // with `TypeError: Do not know how to serialize a BigInt`. Convert to string for
  // CLI output. Programmatic callers get the raw BigInts via the verifySubstrate return.
  const printable = {
    ...result,
    onChain: result.onChain
      ? {
          ...result.onChain,
          ethBalanceWei: result.onChain.ethBalanceWei.toString(),
          olasBalanceWei: result.onChain.olasBalanceWei?.toString() ?? null,
        }
      : null,
  };
  console.log(JSON.stringify(printable, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/release/substrate/verify.test.ts`
Expected: PASS, 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add client/scripts/release/substrate-verify.ts client/test/release/substrate/verify.test.ts
git commit -m "feat(substrate): add manifest-validating substrate-verify"
```

---

## Task 5: substrate-verify — on-chain identity check

**Files:**
- Modify: `client/scripts/release/substrate-verify.ts`
- Modify: `client/test/release/substrate/verify.test.ts` (add on-chain tests)
- Create: `client/test/release/substrate/helpers/anvil-fork.ts`

- [ ] **Step 1: Write the Anvil fork helper**

```typescript
// client/test/release/substrate/helpers/anvil-fork.ts
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';

export interface AnvilForkHandle {
  rpcUrl: string;
  port: number;
  stop: () => Promise<void>;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForRpc(rpcUrl: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil at ${rpcUrl} did not become reachable within ${timeoutMs}ms`);
}

export async function spawnAnvilFork(opts: { forkUrl?: string; forkBlock?: number } = {}): Promise<AnvilForkHandle> {
  const port = await pickFreePort();
  const args = ['--port', port.toString(), '--silent'];
  if (opts.forkUrl) {
    args.push('--fork-url', opts.forkUrl);
    if (opts.forkBlock !== undefined) {
      args.push('--fork-block-number', opts.forkBlock.toString());
    }
  }
  const child: ChildProcess = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const rpcUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForRpc(rpcUrl);
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
  return {
    rpcUrl,
    port,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      if (!child.killed) child.kill('SIGKILL');
    },
  };
}
```

- [ ] **Step 2: Add a failing on-chain test**

Append to `client/test/release/substrate/verify.test.ts`:

```typescript
import { spawnAnvilFork, type AnvilForkHandle } from './helpers/anvil-fork';
import { createTestClient, createWalletClient, http, parseEther, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

describe('substrate-verify (on-chain check)', () => {
  let tmpRoot: string;
  let anvil: AnvilForkHandle;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-verify-onchain-'));
    anvil = await spawnAnvilFork();
  });

  afterEach(async () => {
    await anvil.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reports failure when master EOA has zero ETH balance', async () => {
    const opDir = path.join(tmpRoot, 'operators', 'op-a');
    await fs.mkdir(path.join(opDir, '.jinn-client'), { recursive: true });
    const manifest: Manifest = {
      substrateVersion: '1',
      createdAt: '2026-05-19T14:47:19Z',
      adoptedFrom: '~/.jinn-client/',
      name: 'op-a',
      shape: 'current',
      role: 'launcher',
      network: 'base-sepolia',
      operator: {
        masterAddress: '0x1234567890123456789012345678901234567890',
        fleetAgentId: '5474',
        fleetSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
        fleetStage: 'stage1_and_2',
        serviceId: 46,
        serviceStep: 'complete',
        agentEoa: '0x63192d38350b796856cF002caC25c377D9A0DB5A',
        safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
        mechAddress: '0x9c415369D0597e4867F419d256BD61D16a8C47b5',
        stakingAddress: '0x24e34E5037956a5Feca1AAAfaA30297084C228B8',
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      },
      config: { apiPort: 7332, rpcUrl: anvil.rpcUrl, joinedSolverNets: [] },
    };
    await fs.writeFile(path.join(opDir, 'manifest.json'), JSON.stringify(manifest));

    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: false });

    expect(result.onChain).not.toBeNull();
    expect(result.onChain!.ethBalanceWei).toBe(0n);
    expect(result.failures.some((f) => f.toLowerCase().includes('eth balance'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify the new test fails**

Run: `cd client && yarn vitest run test/release/substrate/verify.test.ts`
Expected: 3 prior tests PASS; new on-chain test FAILS because on-chain check isn't implemented yet.

- [ ] **Step 4: Implement the on-chain check**

Replace the on-chain stub in `client/scripts/release/substrate-verify.ts` with:

```typescript
// Add at top of substrate-verify.ts
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';

const MIN_MASTER_ETH_WEI = 2_000_000_000_000_000n;   // 0.002 ETH
const IDENTITY_REGISTRY_ABI = parseAbi([
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);
const OLAS_TOKEN_ADDRESS_BASE_SEPOLIA: Address = '0x54330d28ca3357F294334BDC454a032e7f353416';
const OLAS_TOKEN_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
]);

// Replace the warnings.push('on-chain check not yet implemented...') block with:
const client = createPublicClient({ chain: baseSepolia, transport: http(manifest.config.rpcUrl) });
const onChain = {
  boundSafeAddress: null as string | null,
  ethBalanceWei: 0n,
  olasBalanceWei: null as bigint | null,
};

// Master ETH balance
try {
  onChain.ethBalanceWei = await client.getBalance({ address: manifest.operator.masterAddress as Address });
  if (onChain.ethBalanceWei < MIN_MASTER_ETH_WEI) {
    failures.push(`master ETH balance ${onChain.ethBalanceWei} below minimum ${MIN_MASTER_ETH_WEI}`);
  }
} catch (err) {
  failures.push(`failed to read master ETH balance: ${(err as Error).message}`);
}

// AgentId binding (skip if pre-fleet shape)
if (manifest.shape === 'current' && manifest.operator.fleetAgentId !== null && manifest.operator.fleetSafeAddress !== null) {
  try {
    const bound = await client.readContract({
      address: manifest.operator.identityRegistry as Address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'getAgentWallet',
      args: [BigInt(manifest.operator.fleetAgentId)],
    });
    onChain.boundSafeAddress = bound;
    if (bound.toLowerCase() !== manifest.operator.fleetSafeAddress.toLowerCase()) {
      failures.push(`identityRegistry.getAgentWallet(${manifest.operator.fleetAgentId})=${bound} does not match manifest.fleetSafeAddress=${manifest.operator.fleetSafeAddress}`);
    }
  } catch (err) {
    failures.push(`failed to read identityRegistry.getAgentWallet: ${(err as Error).message}`);
  }
}

// OLAS balance on Safe (informational; staked balance is locked so we just check)
try {
  onChain.olasBalanceWei = await client.readContract({
    address: OLAS_TOKEN_ADDRESS_BASE_SEPOLIA,
    abi: OLAS_TOKEN_ABI,
    functionName: 'balanceOf',
    args: [manifest.operator.safeAddress as Address],
  });
} catch {
  // Non-blocking; legacy ops or future schema may not have OLAS readable
}

return { opName, ok: failures.length === 0, failures, warnings, onChain };
```

- [ ] **Step 5: Run all verify tests**

Run: `cd client && yarn vitest run test/release/substrate/verify.test.ts`
Expected: 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add client/scripts/release/substrate-verify.ts client/test/release/substrate/verify.test.ts client/test/release/substrate/helpers/anvil-fork.ts
git commit -m "feat(substrate): add on-chain identity verification to substrate-verify"
```

---

## Task 6: substrate-adopt — single operator copy + manifest write

**Files:**
- Create: `client/scripts/release/substrate-adopt.ts`
- Test: `client/test/release/substrate/adopt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/substrate/adopt.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { adoptOperator } from '../../../scripts/release/substrate-adopt';

describe('substrate-adopt', () => {
  let tmpRoot: string;
  const fixtureDir = path.resolve(__dirname, 'fixtures', 'op-a-fixture', '.jinn-client');

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-adopt-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('copies a source operator dir into gold with the expected layout', async () => {
    await adoptOperator({
      sourceDir: fixtureDir,
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7332,
      substrateRoot: tmpRoot,
    });

    const goldOp = path.join(tmpRoot, 'operators', 'op-a');
    await expect(fs.access(path.join(goldOp, 'manifest.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(goldOp, '.jinn-client', 'config.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(goldOp, '.jinn-client', 'earning', 'earning_state.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(goldOp, '.jinn-client', 'keystore-password'))).resolves.toBeUndefined();
  });

  it('writes a manifest matching the source operator state', async () => {
    await adoptOperator({
      sourceDir: fixtureDir,
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7332,
      substrateRoot: tmpRoot,
    });

    const manifestRaw = await fs.readFile(path.join(tmpRoot, 'operators', 'op-a', 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.name).toBe('op-a');
    expect(manifest.shape).toBe('current');
    expect(manifest.role).toBe('launcher');
    expect(manifest.network).toBe('base-sepolia');
    expect(manifest.operator.masterAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(manifest.operator.fleetAgentId).toBe('99001');
    expect(manifest.config.apiPort).toBe(7332);
  });

  it('rewrites apiPort in the copied config.json', async () => {
    await adoptOperator({
      sourceDir: fixtureDir,
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7340,
      substrateRoot: tmpRoot,
    });

    const cfgRaw = await fs.readFile(path.join(tmpRoot, 'operators', 'op-a', '.jinn-client', 'config.json'), 'utf-8');
    const cfg = JSON.parse(cfgRaw);
    expect(cfg.apiPort).toBe(7340);
  });

  it('excludes engine/, logs, and backups from the copy', async () => {
    // seed the source dir with some junk to make sure it's excluded
    const dirtySource = await fs.mkdtemp(path.join(os.tmpdir(), 'dirty-source-'));
    await fs.cp(fixtureDir, path.join(dirtySource, '.jinn-client'), { recursive: true });
    await fs.mkdir(path.join(dirtySource, '.jinn-client', 'engine', 'work'), { recursive: true });
    await fs.writeFile(path.join(dirtySource, '.jinn-client', 'engine', 'work', 'fake-task.json'), '{}');
    await fs.writeFile(path.join(dirtySource, '.jinn-client', 'daemon-20260101.log'), 'old');
    await fs.writeFile(path.join(dirtySource, '.jinn-client', 'jinn.db.bak-20260101'), 'backup');

    await adoptOperator({
      sourceDir: path.join(dirtySource, '.jinn-client'),
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7332,
      substrateRoot: tmpRoot,
    });

    const goldOp = path.join(tmpRoot, 'operators', 'op-a', '.jinn-client');
    await expect(fs.access(path.join(goldOp, 'engine'))).rejects.toThrow();
    await expect(fs.access(path.join(goldOp, 'daemon-20260101.log'))).rejects.toThrow();
    await expect(fs.access(path.join(goldOp, 'jinn.db.bak-20260101'))).rejects.toThrow();

    await fs.rm(dirtySource, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/release/substrate/adopt.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/release/substrate-adopt'`

- [ ] **Step 3: Implement substrate-adopt**

```typescript
// client/scripts/release/substrate-adopt.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { goldPath } from './substrate-paths';
import type { Manifest } from './types';
import { ManifestSchema } from './types';

const EXCLUDE_DIRS = new Set(['engine']);
const EXCLUDE_PATTERNS: RegExp[] = [
  /^jinn\.db\.bak/,
  /^config\.before/,
  /^config\.json\.pre/,
  /^daemon-/,
  /\.log$/,
  /^run-/,
];

export interface AdoptOptions {
  sourceDir: string;            // path to the existing .jinn-client/ dir
  opName: string;               // "op-a", "op-b", etc.
  role: Manifest['role'];
  shape: Manifest['shape'];
  apiPort: number;
  substrateRoot?: string;
}

async function copyTreeWithExcludes(srcDir: string, dstDir: string): Promise<void> {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (EXCLUDE_DIRS.has(ent.name)) continue;
    if (EXCLUDE_PATTERNS.some((re) => re.test(ent.name))) continue;
    const srcPath = path.join(srcDir, ent.name);
    const dstPath = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      await copyTreeWithExcludes(srcPath, dstPath);
    } else if (ent.isFile()) {
      await fs.copyFile(srcPath, dstPath);
      // preserve mode (keystore-password should remain chmod 600)
      const stat = await fs.stat(srcPath);
      await fs.chmod(dstPath, stat.mode);
    }
  }
}

async function readJsonOrNull<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

interface SourceEarningState {
  master_address: string;
  chain: string;
  fleet_agent_id?: string;
  fleet_safe_address?: string;
  fleet_identity_registry?: string;
  fleet_stage?: string;
  services?: Array<{
    agent_address: string;
    safe_address: string;
    service_id: number;
    mech_address?: string;
    staking_address?: string;
    identity_registry_address?: string;
    step?: string;
  }>;
}

interface SourceConfig {
  rpcUrl?: string;
  apiPort?: number;
  joinedSolverNets?: Record<string, unknown>;
}

export async function adoptOperator(opts: AdoptOptions): Promise<void> {
  const gold = goldPath(opts.opName, opts.substrateRoot);
  const goldJinn = path.join(gold, '.jinn-client');

  // 1. Clear any existing gold for this op
  await fs.rm(gold, { recursive: true, force: true });
  await fs.mkdir(goldJinn, { recursive: true });

  // 2. Copy the source dir with excludes
  await copyTreeWithExcludes(opts.sourceDir, goldJinn);

  // 3. Rewrite apiPort in the copied config.json
  const cfgPath = path.join(goldJinn, 'config.json');
  const cfg = await readJsonOrNull<SourceConfig>(cfgPath);
  if (cfg) {
    cfg.apiPort = opts.apiPort;
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  }

  // 4. Read earning_state.json to populate manifest
  const statePath = path.join(goldJinn, 'earning', 'earning_state.json');
  const state = await readJsonOrNull<SourceEarningState>(statePath);
  if (!state) {
    throw new Error(`source operator at ${opts.sourceDir} has no earning/earning_state.json`);
  }
  const svc = state.services?.[0];
  // Throw rather than ?? to a sentinel: silently substituting zeros/fakes when the
  // source is half-bootstrapped masks real config problems. The resulting manifest
  // would claim valid identity while pointing at 0x0000... addresses — worse than
  // failing fast.
  if (!svc) {
    throw new Error(
      `source operator at ${opts.sourceDir} has earning_state.json with no services entry — operator may not have reached the service-registration step yet`,
    );
  }
  if (!cfg || !cfg.rpcUrl) {
    throw new Error(
      `source operator at ${opts.sourceDir} has config.json without rpcUrl — cannot derive substrate manifest`,
    );
  }

  // 5. Build manifest
  const manifest: Manifest = {
    substrateVersion: '1',
    createdAt: new Date().toISOString(),
    adoptedFrom: opts.sourceDir,
    name: opts.opName,
    shape: opts.shape,
    role: opts.role,
    network: state.chain === 'base-sepolia' ? 'base-sepolia' : 'base',
    operator: {
      masterAddress: state.master_address,
      fleetAgentId: state.fleet_agent_id ?? null,
      fleetSafeAddress: state.fleet_safe_address ?? null,
      fleetStage: state.fleet_stage ?? null,
      serviceId: svc.service_id,
      serviceStep: svc.step ?? 'unknown',
      agentEoa: svc.agent_address,
      safeAddress: svc.safe_address,
      mechAddress: svc.mech_address ?? '0x0000000000000000000000000000000000000000',
      stakingAddress: svc.staking_address ?? '0x0000000000000000000000000000000000000000',
      identityRegistry: svc.identity_registry_address ?? state.fleet_identity_registry ?? '0x0000000000000000000000000000000000000000',
    },
    config: {
      apiPort: opts.apiPort,
      rpcUrl: cfg.rpcUrl,
      joinedSolverNets: cfg.joinedSolverNets ? Object.keys(cfg.joinedSolverNets) : [],
    },
  };

  // 6. Validate manifest before writing
  ManifestSchema.parse(manifest);

  // 7. Write manifest
  await fs.writeFile(path.join(gold, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function cliMain(): Promise<void> {
  // Parse --from <dir> --as <name> --role <role> --shape <shape> --apiPort <port>
  // (one set of args; for multiple ops, invoke multiple times)
  const args = process.argv.slice(2);
  const argMap: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (!val) { console.error(`missing value for --${key}`); process.exit(2); }
      argMap[key] = val;
      i++;
    }
  }
  const { from, as: opName, role, shape, apiPort } = argMap;
  if (!from || !opName || !role || !shape || !apiPort) {
    console.error('usage: substrate-adopt --from <.jinn-client-dir> --as <op-name> --role <launcher|participant|legacy-backup> --shape <current|pre-fleet> --apiPort <port>');
    process.exit(2);
  }
  await adoptOperator({
    sourceDir: from,
    opName,
    role: role as Manifest['role'],
    shape: shape as Manifest['shape'],
    apiPort: parseInt(apiPort, 10),
  });
  console.log(`adopted ${opName} from ${from}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd client && yarn vitest run test/release/substrate/adopt.test.ts`
Expected: PASS, 4 tests passing

- [ ] **Step 5: Run substrate-verify on the adopted result as a sanity check**

```typescript
// append to client/test/release/substrate/adopt.test.ts
import { verifySubstrate } from '../../../scripts/release/substrate-verify';

it('adopted op-a passes substrate-verify (skip on-chain)', async () => {
  await adoptOperator({
    sourceDir: fixtureDir,
    opName: 'op-a',
    role: 'launcher',
    shape: 'current',
    apiPort: 7332,
    substrateRoot: tmpRoot,
  });
  const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: true });
  expect(result.ok).toBe(true);
  expect(result.failures).toEqual([]);
});
```

Run: `cd client && yarn vitest run test/release/substrate/adopt.test.ts`
Expected: PASS, 5 tests passing

- [ ] **Step 6: Commit**

```bash
git add client/scripts/release/substrate-adopt.ts client/test/release/substrate/adopt.test.ts
git commit -m "feat(substrate): add substrate-adopt for copying existing operator state into gold"
```

---

## Task 7: substrate-copy — workspace creation

**Files:**
- Create: `client/scripts/release/substrate-copy.ts`
- Test: `client/test/release/substrate/copy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/substrate/copy.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { adoptOperator } from '../../../scripts/release/substrate-adopt';
import { copyWorkspace } from '../../../scripts/release/substrate-copy';

describe('substrate-copy', () => {
  let tmpRoot: string;
  const opAFixture = path.resolve(__dirname, 'fixtures', 'op-a-fixture', '.jinn-client');
  const opBFixture = path.resolve(__dirname, 'fixtures', 'op-b-fixture', '.jinn-client');

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-copy-'));
    await adoptOperator({ sourceDir: opAFixture, opName: 'op-a', role: 'launcher', shape: 'current', apiPort: 7332, substrateRoot: tmpRoot });
    await adoptOperator({ sourceDir: opBFixture, opName: 'op-b', role: 'participant', shape: 'current', apiPort: 7333, substrateRoot: tmpRoot });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('creates per-run workspace from gold', async () => {
    const handle = await copyWorkspace({ ops: ['op-a', 'op-b'], substrateRoot: tmpRoot });
    expect(handle.runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/);

    for (const opName of ['op-a', 'op-b']) {
      const wsOp = path.join(handle.workspaceRoot, opName);
      await expect(fs.access(path.join(wsOp, 'manifest.json'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(wsOp, '.jinn-client', 'config.json'))).resolves.toBeUndefined();
    }
  });

  it('teardown removes the workspace dir', async () => {
    const handle = await copyWorkspace({ ops: ['op-a'], substrateRoot: tmpRoot });
    expect(handle.workspaceRoot).toContain('workspaces');
    await fs.access(handle.workspaceRoot);
    await handle.teardown();
    await expect(fs.access(handle.workspaceRoot)).rejects.toThrow();
  });

  it('teardown is idempotent', async () => {
    const handle = await copyWorkspace({ ops: ['op-a'], substrateRoot: tmpRoot });
    await handle.teardown();
    await expect(handle.teardown()).resolves.toBeUndefined();
  });

  it('returns per-op paths for ergonomic use', async () => {
    const handle = await copyWorkspace({ ops: ['op-a', 'op-b'], substrateRoot: tmpRoot });
    expect(handle.opPaths['op-a']).toContain('op-a');
    expect(handle.opPaths['op-b']).toContain('op-b');
    expect(handle.opPaths['op-a']).not.toContain('op-b');
  });

  it('throws if requested op is not in gold', async () => {
    await expect(copyWorkspace({ ops: ['op-z'], substrateRoot: tmpRoot })).rejects.toThrow(/op-z/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/release/substrate/copy.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/release/substrate-copy'`

- [ ] **Step 3: Implement substrate-copy**

```typescript
// client/scripts/release/substrate-copy.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { goldPath, workspacePath, generateRunId } from './substrate-paths';

export interface CopyWorkspaceOptions {
  ops: string[];                    // names of gold ops to include
  substrateRoot?: string;
  runId?: string;                   // override the generated run-id
}

export interface WorkspaceHandle {
  runId: string;
  workspaceRoot: string;            // ~/jinn-dev/workspaces/<run-id>/
  opPaths: Record<string, string>;  // opName → ~/jinn-dev/workspaces/<run-id>/<opName>/
  teardown: () => Promise<void>;
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      await copyDir(s, d);
    } else if (ent.isFile()) {
      await fs.copyFile(s, d);
      const stat = await fs.stat(s);
      await fs.chmod(d, stat.mode);
    }
  }
}

export async function copyWorkspace(opts: CopyWorkspaceOptions): Promise<WorkspaceHandle> {
  const runId = opts.runId ?? generateRunId();
  const opPaths: Record<string, string> = {};

  // Validate every requested op exists in gold first
  for (const opName of opts.ops) {
    const src = goldPath(opName, opts.substrateRoot);
    try {
      await fs.access(src);
    } catch {
      throw new Error(`gold operator ${opName} not found at ${src}`);
    }
  }

  // Copy each op
  for (const opName of opts.ops) {
    const src = goldPath(opName, opts.substrateRoot);
    const dst = workspacePath(runId, opName, opts.substrateRoot);
    await copyDir(src, dst);
    opPaths[opName] = dst;
  }

  const workspaceRoot = path.dirname(opPaths[opts.ops[0]]);

  // Tag the workspace with provenance
  await fs.writeFile(
    path.join(workspaceRoot, '.created-by'),
    JSON.stringify({ runId, createdAt: new Date().toISOString(), ops: opts.ops }, null, 2) + '\n',
  );

  return {
    runId,
    workspaceRoot,
    opPaths,
    teardown: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: substrate-copy <op-name> [<op-name> ...]');
    process.exit(2);
  }
  const handle = await copyWorkspace({ ops: args });
  console.log(JSON.stringify({ runId: handle.runId, workspaceRoot: handle.workspaceRoot, opPaths: handle.opPaths }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd client && yarn vitest run test/release/substrate/copy.test.ts`
Expected: PASS, 5 tests passing

- [ ] **Step 5: Commit**

```bash
git add client/scripts/release/substrate-copy.ts client/test/release/substrate/copy.test.ts
git commit -m "feat(substrate): add substrate-copy for per-run workspace creation"
```

---

## Task 8: substrate-topup — balance check and gap surfacing

**Files:**
- Create: `client/scripts/release/substrate-topup.ts`
- Test: `client/test/release/substrate/topup.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/substrate/topup.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { adoptOperator } from '../../../scripts/release/substrate-adopt';
import { checkSubstrateTopup } from '../../../scripts/release/substrate-topup';
import { spawnAnvilFork, type AnvilForkHandle } from './helpers/anvil-fork';

describe('substrate-topup', () => {
  let tmpRoot: string;
  let anvil: AnvilForkHandle;
  const opAFixture = path.resolve(__dirname, 'fixtures', 'op-a-fixture', '.jinn-client');

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-topup-'));
    anvil = await spawnAnvilFork();
    await adoptOperator({ sourceDir: opAFixture, opName: 'op-a', role: 'launcher', shape: 'current', apiPort: 7332, substrateRoot: tmpRoot });
    // Override the manifest's rpcUrl to the local Anvil for the test
    const manifestPath = path.join(tmpRoot, 'operators', 'op-a', 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.config.rpcUrl = anvil.rpcUrl;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    await anvil.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reports ok=false when master ETH balance is zero', async () => {
    const result = await checkSubstrateTopup('op-a', { substrateRoot: tmpRoot });
    expect(result.ok).toBe(false);
    expect(result.needs.some((n) => n.resource === 'ETH' && n.have === 0n)).toBe(true);
  });

  it('reports the ETH delta to topup', async () => {
    const result = await checkSubstrateTopup('op-a', { substrateRoot: tmpRoot });
    const ethNeed = result.needs.find((n) => n.resource === 'ETH');
    expect(ethNeed).toBeDefined();
    expect(ethNeed!.want).toBeGreaterThan(ethNeed!.have);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/release/substrate/topup.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/release/substrate-topup'`

- [ ] **Step 3: Implement substrate-topup**

```typescript
// client/scripts/release/substrate-topup.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { ManifestSchema, type TopupResult, type Manifest } from './types';
import { goldPath } from './substrate-paths';

const TARGET_ETH_WEI = 5_000_000_000_000_000n;       // 0.005 ETH
const TARGET_USDC_UNITS = 1_000_000n;                // 1.00 USDC (6 decimals)
const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface TopupOptions {
  substrateRoot?: string;
}

export async function checkSubstrateTopup(opName: string, opts: TopupOptions = {}): Promise<TopupResult> {
  const opDir = goldPath(opName, opts.substrateRoot);
  const manifestRaw = await fs.readFile(path.join(opDir, 'manifest.json'), 'utf-8');
  const manifest: Manifest = ManifestSchema.parse(JSON.parse(manifestRaw));

  const client = createPublicClient({ chain: baseSepolia, transport: http(manifest.config.rpcUrl) });
  const needs: TopupResult['needs'] = [];

  // ETH on master EOA (for posting txs from substrate ops)
  const ethBalance = await client.getBalance({ address: manifest.operator.masterAddress as Address });
  if (ethBalance < TARGET_ETH_WEI) {
    needs.push({ resource: 'ETH', have: ethBalance, want: TARGET_ETH_WEI });
  }

  // USDC on Safe (for x402 payments — only if op participates in donation scenarios)
  try {
    const usdcBalance = await client.readContract({
      address: USDC_BASE_SEPOLIA,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [manifest.operator.safeAddress as Address],
    });
    if (usdcBalance < TARGET_USDC_UNITS) {
      needs.push({ resource: 'USDC', have: usdcBalance, want: TARGET_USDC_UNITS });
    }
  } catch {
    // USDC token might not be deployed on the local fork; treat as zero
    needs.push({ resource: 'USDC', have: 0n, want: TARGET_USDC_UNITS });
  }

  return { opName, needs, ok: needs.length === 0 };
}

async function cliMain(): Promise<void> {
  const opName = process.argv[2];
  if (!opName) {
    console.error('usage: substrate-topup <op-name>');
    process.exit(2);
  }
  const result = await checkSubstrateTopup(opName);
  console.log(JSON.stringify(
    {
      opName: result.opName,
      ok: result.ok,
      needs: result.needs.map((n) => ({ ...n, have: n.have.toString(), want: n.want.toString() })),
    },
    null,
    2,
  ));
  if (!result.ok) {
    console.error('\nSubstrate op has low balances. Fund manually or via release-bot wallet:');
    for (const n of result.needs) {
      console.error(`  - ${n.resource}: have ${n.have.toString()}, want ${n.want.toString()}`);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd client && yarn vitest run test/release/substrate/topup.test.ts`
Expected: PASS, 2 tests passing

- [ ] **Step 5: Commit**

```bash
git add client/scripts/release/substrate-topup.ts client/test/release/substrate/topup.test.ts
git commit -m "feat(substrate): add substrate-topup balance check (surface gaps, no auto-drip)"
```

---

## Task 9: substrate-reap — workspace age-based pruning

**Files:**
- Create: `client/scripts/release/substrate-reap.ts`
- Test: `client/test/release/substrate/reap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/substrate/reap.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { reapWorkspaces } from '../../../scripts/release/substrate-reap';

describe('substrate-reap', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-reap-'));
    await fs.mkdir(path.join(tmpRoot, 'workspaces'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function seedWorkspace(name: string, ageDays: number): Promise<void> {
    const wsDir = path.join(tmpRoot, 'workspaces', name);
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(path.join(wsDir, '.created-by'), JSON.stringify({ runId: name }));
    const ageMs = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const time = new Date(ageMs);
    await fs.utimes(wsDir, time, time);
  }

  it('removes workspaces older than 7 days', async () => {
    await seedWorkspace('old-workspace', 10);
    await seedWorkspace('fresh-workspace', 1);

    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });

    expect(result.reaped).toEqual(['old-workspace']);
    await expect(fs.access(path.join(tmpRoot, 'workspaces', 'old-workspace'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpRoot, 'workspaces', 'fresh-workspace'))).resolves.toBeUndefined();
  });

  it('returns empty list when nothing is old enough', async () => {
    await seedWorkspace('fresh-1', 2);
    await seedWorkspace('fresh-2', 5);

    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });

    expect(result.reaped).toEqual([]);
    expect(result.kept).toHaveLength(2);
  });

  it('handles empty workspaces dir gracefully', async () => {
    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });
    expect(result.reaped).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('skips non-directory entries', async () => {
    await fs.writeFile(path.join(tmpRoot, 'workspaces', 'a-file.txt'), 'not a dir');
    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });
    expect(result.reaped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/release/substrate/reap.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/release/substrate-reap'`

- [ ] **Step 3: Implement substrate-reap**

```typescript
// client/scripts/release/substrate-reap.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { workspacesRoot } from './substrate-paths';

export interface ReapOptions {
  substrateRoot?: string;
  maxAgeDays?: number;             // default 7
}

export interface ReapResult {
  reaped: string[];                // workspace dir names removed
  kept: string[];                  // workspace dir names retained
}

export async function reapWorkspaces(opts: ReapOptions = {}): Promise<ReapResult> {
  const maxAgeDays = opts.maxAgeDays ?? 7;
  const root = workspacesRoot(opts.substrateRoot);
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const reaped: string[] = [];
  const kept: string[] = [];

  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { reaped, kept };
    }
    throw err;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const fullPath = path.join(root, ent.name);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs < cutoffMs) {
      await fs.rm(fullPath, { recursive: true, force: true });
      reaped.push(ent.name);
    } else {
      kept.push(ent.name);
    }
  }

  return { reaped, kept };
}

async function cliMain(): Promise<void> {
  const result = await reapWorkspaces();
  console.log(JSON.stringify(result, null, 2));
  if (result.reaped.length > 0) {
    console.error(`reaped ${result.reaped.length} workspace(s) older than 7 days`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd client && yarn vitest run test/release/substrate/reap.test.ts`
Expected: PASS, 4 tests passing

- [ ] **Step 5: Commit**

```bash
git add client/scripts/release/substrate-reap.ts client/test/release/substrate/reap.test.ts
git commit -m "feat(substrate): add substrate-reap for workspace age-based pruning"
```

---

## Task 10: Wire yarn scripts in package.json

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Read the current package.json scripts section**

Run: `cd client && cat package.json | head -50`
Expected output shows existing `scripts:` block.

- [ ] **Step 2: Add the substrate-related yarn scripts**

Open `client/package.json` and add these entries inside the `"scripts"` object (preserve existing entries; add alphabetically near other release/staking scripts):

```json
{
  "scripts": {
    "substrate:adopt": "tsx scripts/release/substrate-adopt.ts",
    "substrate:copy": "tsx scripts/release/substrate-copy.ts",
    "substrate:verify": "tsx scripts/release/substrate-verify.ts",
    "substrate:topup": "tsx scripts/release/substrate-topup.ts",
    "substrate:reap": "tsx scripts/release/substrate-reap.ts"
  }
}
```

(If `tsx` isn't already a devDependency, check by running `cd client && yarn list --pattern tsx | head -3`. If absent, this task should not add it — surface as a follow-up. If present, the entries above work directly.)

- [ ] **Step 3: Verify yarn scripts run (smoke test the help paths)**

Run: `cd client && yarn substrate:adopt 2>&1 | head -5`
Expected output: `usage: substrate-adopt --from <.jinn-client-dir> --as <op-name> ...` (and exit code 2)

Run: `cd client && yarn substrate:verify 2>&1 | head -5`
Expected output: `usage: substrate-verify <op-name> [--skip-on-chain]`

Run: `cd client && yarn substrate:copy 2>&1 | head -5`
Expected output: `usage: substrate-copy <op-name> [<op-name> ...]`

Run: `cd client && yarn substrate:topup 2>&1 | head -5`
Expected output: `usage: substrate-topup <op-name>`

Run: `cd client && yarn substrate:reap 2>&1 | tail -5`
Expected output: `{ "reaped": [], "kept": [...] }` (exit 0 if substrate exists; ENOENT-handled if not)

- [ ] **Step 4: Commit**

```bash
git add client/package.json
git commit -m "chore(substrate): wire yarn scripts for substrate lifecycle ops"
```

---

## Task 11: README for substrate scripts

**Files:**
- Create: `client/scripts/release/README.md`

- [ ] **Step 1: Write the README**

```markdown
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
```

Save as `client/scripts/release/README.md`.

- [ ] **Step 2: Verify the file**

Run: `cd client && cat scripts/release/README.md | head -20`
Expected: README content shown.

- [ ] **Step 3: Commit**

```bash
git add client/scripts/release/README.md
git commit -m "docs(substrate): add README for substrate lifecycle scripts"
```

---

## Task 12: Re-adopt the current on-disk substrate using the new scripts

**Files:**
- None modified; this is an integration sanity check.

This task validates that the scripts can reproduce the manual adoption we performed during the spec brainstorm. The existing on-disk substrate at `~/jinn-dev/operators/op-{a,b,c-legacy}/` was created manually with python; this task confirms `substrate-adopt.ts` produces equivalent state.

- [ ] **Step 1: Verify the current substrate exists and passes verify**

Run:
```bash
cd client
yarn substrate:verify op-a --skip-on-chain
yarn substrate:verify op-b --skip-on-chain
yarn substrate:verify op-c-legacy --skip-on-chain
```

Expected: all three return `"ok": true` (manifests written during brainstorm should pass schema).

- [ ] **Step 2: Snapshot the current manifests for comparison**

Run:
```bash
mkdir -p /tmp/substrate-snapshot-baseline
cp ~/jinn-dev/operators/op-a/manifest.json /tmp/substrate-snapshot-baseline/op-a.json
cp ~/jinn-dev/operators/op-b/manifest.json /tmp/substrate-snapshot-baseline/op-b.json
cp ~/jinn-dev/operators/op-c-legacy/manifest.json /tmp/substrate-snapshot-baseline/op-c-legacy.json
```

- [ ] **Step 3: Re-adopt op-a via the new script into a tmp substrate root**

Run:
```bash
cd client
TMP_ROOT=$(mktemp -d)
yarn substrate:adopt \
  --from ~/.jinn-client/ \
  --as op-a \
  --role launcher \
  --shape current \
  --apiPort 7332
# (the above writes to $HOME/jinn-dev/operators/op-a — replacing the manual one;
#  if you want to keep both, override substrateRoot via env or use the API directly)
```

For a non-destructive check, use the programmatic API in a one-off script:
```bash
cd client
node -e "
  require('tsx/cjs');
  require('./scripts/release/substrate-adopt').adoptOperator({
    sourceDir: process.env.HOME + '/.jinn-client',
    opName: 'op-a',
    role: 'launcher',
    shape: 'current',
    apiPort: 7332,
    substrateRoot: '$TMP_ROOT',
  }).then(() => console.log('done'));
"
```

- [ ] **Step 4: Compare manifests (excluding createdAt timestamp which legitimately differs)**

Run:
```bash
jq 'del(.createdAt)' /tmp/substrate-snapshot-baseline/op-a.json > /tmp/baseline-no-ts.json
jq 'del(.createdAt)' $TMP_ROOT/operators/op-a/manifest.json > /tmp/new-no-ts.json
diff /tmp/baseline-no-ts.json /tmp/new-no-ts.json
```

Expected: no diff (or only ordering differences within objects, which are semantically equivalent).

If there's a real diff, investigate which field drifted and fix `substrate-adopt.ts` to match the manual adoption.

- [ ] **Step 5: Tear down the tmp substrate**

```bash
rm -rf $TMP_ROOT /tmp/substrate-snapshot-baseline /tmp/baseline-no-ts.json /tmp/new-no-ts.json
```

- [ ] **Step 6: Commit a small fix if needed, otherwise mark task complete**

If a fix was needed, commit it:
```bash
git add client/scripts/release/substrate-adopt.ts
git commit -m "fix(substrate): align substrate-adopt with manual-adoption output"
```

Otherwise no commit is needed — this task is a validation gate.

---

## Self-review

### Spec coverage

| Spec requirement | Covered by | Status |
|---|---|---|
| §2 path layout | Task 2 (paths) | ✓ |
| §2 manifest schema | Task 1 (types) | ✓ |
| §2 substrate-adopt | Task 6 | ✓ |
| §2 substrate-copy | Task 7 | ✓ |
| §2 substrate-verify | Tasks 4, 5 | ✓ |
| §2 substrate-topup | Task 8 | ✓ |
| §2 workspace reaper | Task 9 | ✓ |
| §7 funding maintenance | Task 8 (surfaces gaps) | ✓ (no auto-drip in v1, as specified) |
| §7 substrate-snapshot (bootstrap fresh) | deferred per spec | ✓ (intentionally out of scope) |

### Placeholder scan

No TBDs, TODOs, "add appropriate error handling", or "similar to Task N" — each task contains complete code and exact commands.

### Type consistency

Confirmed:
- `Manifest` type matches across types.ts, substrate-adopt, substrate-verify, substrate-topup, substrate-copy.
- `verifySubstrate(opName, opts)` signature consistent across Task 4 and Task 5.
- `WorkspaceHandle` interface defined in Task 7 used as the contract for downstream consumers (release-prep, future plans).
- `goldPath(opName, substrateRoot?)` signature consistent.

### Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-substrate-foundation-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
