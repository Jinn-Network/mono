# 1pbc — `.

# 1pbc — `jinn solver-plugins publish` + `revoke` (plug-in registry on IdentityRegistry) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Save this file to `/Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/docs/superpowers/plans/2026-05-14-1pbc-solver-plugins-publish-plan.md` before starting.

**Goal:** Ship two new `jinn solver-plugins` sub-verbs — `publish <source>` and `revoke <pluginCid>` — that write `plugin:<cid>` metadata records on the existing ERC-8004 IdentityRegistry via the fleet's Stage 1 identity Safe (`fleet_safe_address`). Publish: resolve plug-in, pack tarball, compute sha256, upload tarball to IPFS, ABI-encode the `PLUGIN_PAYLOAD_TUPLE` per spec §5.2, send `setMetadata(builderAgentId, "plugin:<cid>", payload)` via `executeSafeTransaction`. Revoke: write a v2 revoked-marker payload to the same key. Both verbs lazily run `bootstrapper.ensureStage1(password)` before any chain write so a builder can publish without ever standing up Stage 2 (operator) state.

**Architecture:** Two ABI tuples (`PLUGIN_PAYLOAD_TUPLE`, `REVOCATION_PAYLOAD_TUPLE`) live in `client/src/erc8004/abis.ts`. A new module `client/src/erc8004/plugin-registry.ts` owns `encodePluginPayload`, `encodeRevocationPayload`, `validatePluginPayload`, `validateRevocationPayload`, `buildPluginMetadataKey`, and the high-level `PluginRegistryPublisher` class which routes `setMetadata` calls through `executeSafeTransaction(publicClient, walletClient, { safeAddress, to: identityRegistry, value: 0n, data })` — exactly the same path `ReputationRegistryClient.sendWrite` uses. The CLI verbs (`publish` / `revoke`) are added to `client/src/cli/commands/solver-plugins.ts` alongside the existing `show / validate / pack` dispatch, factored as a `createSolverPluginsCommand(deps)` factory so tests can inject mock IPFS, mock bootstrapper, and mock chain clients. The verb is a **builder action**, not an operator action — clarified in the verb doc-string at the top of the new subverbs.

**Tech Stack:** TypeScript, Zod, Vitest, viem, `@safe-global/protocol-kit` (already wired via `executeSafeTransaction`). No new contracts. No new runtime dependencies beyond what `pack` already uses (`tar` shells out, IPFS via `fetch`).

---

## File structure

**Modify:**
- `client/src/erc8004/abis.ts` — add `PLUGIN_PAYLOAD_TUPLE` and `REVOCATION_PAYLOAD_TUPLE` tuple definitions next to the existing `PAYLOAD_TUPLE` / `PAYLOAD_TUPLE_V2`.
- `client/src/cli/commands/solver-plugins.ts` — refactor existing module export into `createSolverPluginsCommand(deps = PRODUCTION_DEPS)` factory (mirror `createBootstrapCommand` style), add `publish` and `revoke` subverbs, extend `helpText`. Keep existing `show / validate / pack` behaviour byte-identical (their tests should keep passing).

**Create:**
- `client/src/erc8004/plugin-registry.ts` — pure encoder/validator + `PluginRegistryPublisher` class.
- `client/src/cli/commands/solver-plugins-publish.ts` — handler module for the `publish` sub-verb (so the dispatcher in `solver-plugins.ts` stays small).
- `client/src/cli/commands/solver-plugins-revoke.ts` — handler module for the `revoke` sub-verb.
- `client/src/adapters/mech/ipfs-pinfile.ts` — `pinFileToIpfs(registryUrl, filePath): Promise<string>` helper that uploads a tarball to the Autonolas `/api/v0/add` endpoint and returns the CID. The existing `uploadToIpfs` in `client/src/adapters/mech/ipfs.ts` serialises JSON via JCS, which is wrong for binary tarballs; we add a sibling helper for the binary path.
- `client/test/erc8004/plugin-registry.test.ts` — encoder + validator unit tests.
- `client/test/cli/commands/solver-plugins-publish.test.ts` — publish-verb unit tests with mocked bootstrapper + mocked IPFS + mocked publisher.
- `client/test/cli/commands/solver-plugins-revoke.test.ts` — revoke-verb unit tests.
- `client/test/cli/commands/solver-plugins-publish.anvil.test.ts` — Anvil-fork integration test that walks the publish flow end-to-end against a stub Stage-1 fleet state, mocked IPFS upload, and a live `setMetadata` write to the deployed Base Sepolia IdentityRegistry.

---

## Task 1: Failing test — `PLUGIN_PAYLOAD_TUPLE` shape and re-export

**Files:**
- Create: `client/test/erc8004/plugin-registry.test.ts`

- [ ] **Step 1: Add failing tuple-shape tests**

Create `client/test/erc8004/plugin-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { encodeAbiParameters } from 'viem';
import {
  PLUGIN_PAYLOAD_TUPLE,
  REVOCATION_PAYLOAD_TUPLE,
} from '../../src/erc8004/abis.js';

describe('PLUGIN_PAYLOAD_TUPLE (1pbc)', () => {
  it('matches the spec §5.2 layout: version,name,version,sha256,supports[],publishedAt', () => {
    const fields = PLUGIN_PAYLOAD_TUPLE.map((f) => `${f.name}:${f.type}`);
    expect(fields).toEqual([
      'version:uint8',
      'pluginName:string',
      'pluginVersion:string',
      'pluginSha256:bytes32',
      'supports:string[]',
      'publishedAt:uint64',
    ]);
  });

  it('encodes a minimal payload without throwing', () => {
    const encoded = encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
      1,
      '@builder/swe-skill',
      '0.1.0',
      '0x' + 'ab'.repeat(32) as `0x${string}`,
      ['swe-rebench-v2.v1'],
      1_715_700_000n,
    ]);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/);
    expect(encoded.length).toBeGreaterThan(2);
  });
});

describe('REVOCATION_PAYLOAD_TUPLE (1pbc)', () => {
  it('matches the spec §5.2 revoked-marker layout: version,revoked,reason', () => {
    const fields = REVOCATION_PAYLOAD_TUPLE.map((f) => `${f.name}:${f.type}`);
    expect(fields).toEqual([
      'version:uint8',
      'revoked:bool',
      'reason:string',
    ]);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/erc8004/plugin-registry.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `PLUGIN_PAYLOAD_TUPLE` and `REVOCATION_PAYLOAD_TUPLE` are not exported from `client/src/erc8004/abis.ts`.

- [ ] **Step 3: Commit failing test**

```bash
git add client/test/erc8004/plugin-registry.test.ts
git commit -m "test(1pbc): failing tuple-shape tests for PLUGIN_PAYLOAD_TUPLE + REVOCATION_PAYLOAD_TUPLE"
```

---

## Task 2: Implement `PLUGIN_PAYLOAD_TUPLE` + `REVOCATION_PAYLOAD_TUPLE`

**Files:**
- Modify: `client/src/erc8004/abis.ts`

- [ ] **Step 1: Add the two tuples after `PAYLOAD_TUPLE_V2`**

Insert into `client/src/erc8004/abis.ts` after line 52 (after the `PAYLOAD_TUPLE_V2` block, before the `IDENTITY_REGISTRY_SET_METADATA_ABI` block):

```typescript
/**
 * Plug-in registry payload tuple (1pbc).
 *
 * Per `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §5.2,
 * a published plug-in record is anchored on the existing
 * `IdentityRegistry.setMetadata` surface under the key
 * `plugin:<pluginCid>`, with the payload ABI-encoded against this tuple:
 *
 *   abi.encode(
 *       uint8    version,        // = 1
 *       string   pluginName,     // npm package name
 *       string   pluginVersion,  // semver
 *       bytes32  pluginSha256,   // digestDirectory output for the packed tarball
 *       string[] supports,       // SolverType ids (e.g. ["swe-rebench-v2.v1"])
 *       uint64   publishedAt     // unix seconds
 *   )
 *
 * The textual `pluginCid` in the metadataKey is the IPFS CID of the packed
 * tarball; it is the canonical primary key for the record. Builders publish
 * a new CID per version (`plugin:<newCid>`).
 */
export const PLUGIN_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'pluginName', type: 'string' },
  { name: 'pluginVersion', type: 'string' },
  { name: 'pluginSha256', type: 'bytes32' },
  { name: 'supports', type: 'string[]' },
  { name: 'publishedAt', type: 'uint64' },
] as const;

/**
 * Plug-in revocation payload tuple (1pbc).
 *
 * Builders overwrite `plugin:<pluginCid>` with a `version=2` revoked-marker
 * payload. The indexer treats the most-recent metadata value as authoritative
 * (per spec §5.2 "Revocation"). The key stays the same so the primary-key
 * stability across overwrites is preserved.
 *
 *   abi.encode(
 *       uint8  version,  // = 2
 *       bool   revoked,  // = true
 *       string reason
 *   )
 */
export const REVOCATION_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'revoked', type: 'bool' },
  { name: 'reason', type: 'string' },
] as const;
```

- [ ] **Step 2: Run test — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/erc8004/plugin-registry.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/erc8004/abis.ts
git commit -m "feat(1pbc): add PLUGIN_PAYLOAD_TUPLE + REVOCATION_PAYLOAD_TUPLE per spec §5.2"
```

---

## Task 3: Failing tests — `encodePluginPayload` + `validatePluginPayload`

**Files:**
- Modify: `client/test/erc8004/plugin-registry.test.ts`

- [ ] **Step 1: Append encoder + validator tests**

Append to `client/test/erc8004/plugin-registry.test.ts`:

```typescript
import {
  buildPluginMetadataKey,
  encodePluginPayload,
  encodeRevocationPayload,
  validatePluginPayload,
  validateRevocationPayload,
  type PluginPayload,
  type RevocationPayload,
  PluginPayloadValidationError,
} from '../../src/erc8004/plugin-registry.js';

const VALID_PLUGIN_PAYLOAD: PluginPayload = {
  version: 1,
  pluginName: '@builder/swe-skill',
  pluginVersion: '0.1.0',
  pluginSha256: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  supports: ['swe-rebench-v2.v1'],
  publishedAt: 1_715_700_000,
};

describe('encodePluginPayload (1pbc)', () => {
  it('encodes a valid payload to non-empty hex', () => {
    const encoded = encodePluginPayload(VALID_PLUGIN_PAYLOAD);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/);
  });

  it('round-trips: encode then decode yields the same payload', async () => {
    const { decodeAbiParameters } = await import('viem');
    const encoded = encodePluginPayload(VALID_PLUGIN_PAYLOAD);
    const decoded = decodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe('@builder/swe-skill');
    expect(decoded[2]).toBe('0.1.0');
    expect(decoded[3]).toBe(('0x' + 'ab'.repeat(32)).toLowerCase());
    expect(decoded[4]).toEqual(['swe-rebench-v2.v1']);
    expect(decoded[5]).toBe(1_715_700_000n);
  });
});

describe('validatePluginPayload (1pbc)', () => {
  it('accepts the canonical valid payload', () => {
    expect(() => validatePluginPayload(VALID_PLUGIN_PAYLOAD)).not.toThrow();
  });

  it('rejects version != 1', () => {
    expect(() =>
      validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, version: 2 as unknown as 1 }),
    ).toThrow(PluginPayloadValidationError);
  });

  it('rejects empty pluginName', () => {
    expect(() => validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, pluginName: '' })).toThrow(
      /pluginName/i,
    );
  });

  it('rejects empty pluginVersion', () => {
    expect(() => validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, pluginVersion: '' })).toThrow(
      /pluginVersion/i,
    );
  });

  it('rejects malformed pluginSha256 (not 32-byte hex)', () => {
    expect(() =>
      validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, pluginSha256: '0xdead' as `0x${string}` }),
    ).toThrow(/pluginSha256/i);
  });

  it('rejects empty supports array', () => {
    expect(() => validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, supports: [] })).toThrow(
      /supports/i,
    );
  });

  it('rejects publishedAt outside uint64 range', () => {
    expect(() =>
      validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, publishedAt: -1 }),
    ).toThrow(/publishedAt/i);
  });
});

describe('encodeRevocationPayload + validateRevocationPayload (1pbc)', () => {
  const REV: RevocationPayload = { version: 2, revoked: true, reason: 'security advisory' };

  it('accepts the canonical revoked marker', () => {
    expect(() => validateRevocationPayload(REV)).not.toThrow();
  });

  it('rejects version != 2', () => {
    expect(() =>
      validateRevocationPayload({ ...REV, version: 1 as unknown as 2 }),
    ).toThrow(PluginPayloadValidationError);
  });

  it('rejects revoked=false (revocation payloads must mark revoked)', () => {
    expect(() => validateRevocationPayload({ ...REV, revoked: false })).toThrow(/revoked/i);
  });

  it('rejects empty reason', () => {
    expect(() => validateRevocationPayload({ ...REV, reason: '' })).toThrow(/reason/i);
  });

  it('encodes and round-trips', async () => {
    const { decodeAbiParameters } = await import('viem');
    const encoded = encodeRevocationPayload(REV);
    const decoded = decodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(2);
    expect(decoded[1]).toBe(true);
    expect(decoded[2]).toBe('security advisory');
  });
});

describe('buildPluginMetadataKey (1pbc)', () => {
  it('builds "plugin:<cid>" — never strips, never normalises', () => {
    expect(buildPluginMetadataKey('bafy123')).toBe('plugin:bafy123');
  });

  it('rejects empty CID', () => {
    expect(() => buildPluginMetadataKey('')).toThrow(/cid/i);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/erc8004/plugin-registry.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: FAIL — `plugin-registry.ts` does not exist.

- [ ] **Step 3: Commit failing tests**

```bash
git add client/test/erc8004/plugin-registry.test.ts
git commit -m "test(1pbc): failing tests for encodePluginPayload/encodeRevocationPayload validators"
```

---

## Task 4: Implement `plugin-registry.ts` encoders, validators, key builder

**Files:**
- Create: `client/src/erc8004/plugin-registry.ts`

- [ ] **Step 1: Create the module**

Create `client/src/erc8004/plugin-registry.ts`:

```typescript
/**
 * ERC-8004 plug-in registry surface (jinn-mono-1pbc).
 *
 * Plug-in records are anchored on the existing `IdentityRegistry.setMetadata`
 * write surface — there is NO new contract. The builder's agentId is the
 * subject; the metadataKey is `plugin:<pluginCid>`; the value is ABI-encoded
 * per the `PLUGIN_PAYLOAD_TUPLE` (or, for revocations, the
 * `REVOCATION_PAYLOAD_TUPLE`) declared in `./abis.js`.
 *
 * This is a BUILDER action, not an operator action: it accrues against the
 * fleet's Stage 1 identity Safe (`fleet_safe_address`), and never touches
 * Stage 2 (OLAS service / staking) state. The CLI verb that wraps this
 * publisher (`jinn solver-plugins publish`) lazily runs
 * `FleetBootstrapper.ensureStage1(password)` before any chain write so a
 * builder can complete the full publish flow without ever standing up a
 * Stage 2 service.
 *
 * See `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md`
 * §5.2 ("Plug-in registry = a new `kind=plugin` on `IdentityRegistry.setMetadata`")
 * and §6.3 ("Plug-in publication: `jinn solver-plugins publish`").
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { executeSafeTransaction } from '../adapters/mech/safe.js';
import { waitForTransactionReceiptWithRetry } from '../tx-retry.js';
import {
  IDENTITY_REGISTRY_SET_METADATA_ABI,
  PLUGIN_PAYLOAD_TUPLE,
  REVOCATION_PAYLOAD_TUPLE,
} from './abis.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Plug-in publication payload (spec §5.2). */
export interface PluginPayload {
  /** Schema version (= 1 for this kind). */
  version: 1;
  /** npm package name, e.g. "@builder/swe-skill". Non-empty. */
  pluginName: string;
  /** Semver, e.g. "0.1.0". Non-empty. */
  pluginVersion: string;
  /** 32-byte hex digest of the packed tarball (`digestDirectory` output). */
  pluginSha256: Hex;
  /** SolverType ids — must include at least one (e.g. "swe-rebench-v2.v1"). */
  supports: string[];
  /** Unix seconds. Must fit in uint64. */
  publishedAt: number;
}

/** Plug-in revocation payload (spec §5.2 "Revocation"). */
export interface RevocationPayload {
  /** Schema version (= 2 for the revocation marker). */
  version: 2;
  /** Always `true` — a revocation cannot un-revoke; publish a new CID instead. */
  revoked: true;
  /** Non-empty human-readable reason (e.g. "security advisory CVE-2026-…"). */
  reason: string;
}

export class PluginPayloadValidationError extends Error {
  constructor(reason: string) {
    super(`plugin payload validation failed: ${reason}`);
    this.name = 'PluginPayloadValidationError';
  }
}

// ── Validators ───────────────────────────────────────────────────────────────

const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

export function validatePluginPayload(payload: PluginPayload): PluginPayload {
  if (payload.version !== 1) {
    throw new PluginPayloadValidationError(`version must be 1, got ${payload.version}`);
  }
  if (typeof payload.pluginName !== 'string' || payload.pluginName.length === 0) {
    throw new PluginPayloadValidationError('pluginName must be a non-empty string');
  }
  if (typeof payload.pluginVersion !== 'string' || payload.pluginVersion.length === 0) {
    throw new PluginPayloadValidationError('pluginVersion must be a non-empty string');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.pluginSha256)) {
    throw new PluginPayloadValidationError(
      `pluginSha256 must be 32-byte hex (0x + 64 hex chars)`,
    );
  }
  if (!Array.isArray(payload.supports) || payload.supports.length === 0) {
    throw new PluginPayloadValidationError('supports must be a non-empty string[]');
  }
  for (const s of payload.supports) {
    if (typeof s !== 'string' || s.length === 0) {
      throw new PluginPayloadValidationError('supports entries must be non-empty strings');
    }
  }
  if (!Number.isInteger(payload.publishedAt) || payload.publishedAt < 0) {
    throw new PluginPayloadValidationError(
      `publishedAt must be a non-negative integer; got ${payload.publishedAt}`,
    );
  }
  if (BigInt(payload.publishedAt) > MAX_UINT64) {
    throw new PluginPayloadValidationError(
      `publishedAt exceeds uint64 range; got ${payload.publishedAt}`,
    );
  }
  return payload;
}

export function validateRevocationPayload(payload: RevocationPayload): RevocationPayload {
  if (payload.version !== 2) {
    throw new PluginPayloadValidationError(`revocation version must be 2, got ${payload.version}`);
  }
  if (payload.revoked !== true) {
    throw new PluginPayloadValidationError('revocation payloads must set revoked=true');
  }
  if (typeof payload.reason !== 'string' || payload.reason.length === 0) {
    throw new PluginPayloadValidationError('revocation reason must be a non-empty string');
  }
  return payload;
}

// ── Encoders ─────────────────────────────────────────────────────────────────

export function encodePluginPayload(payload: PluginPayload): Hex {
  validatePluginPayload(payload);
  return encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
    payload.version,
    payload.pluginName,
    payload.pluginVersion,
    payload.pluginSha256,
    payload.supports,
    BigInt(payload.publishedAt),
  ]);
}

export function encodeRevocationPayload(payload: RevocationPayload): Hex {
  validateRevocationPayload(payload);
  return encodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, [
    payload.version,
    payload.revoked,
    payload.reason,
  ]);
}

// ── Metadata key ─────────────────────────────────────────────────────────────

/** Build `plugin:<cid>` per spec §5.2. Never strips, never normalises. */
export function buildPluginMetadataKey(pluginCid: string): string {
  if (typeof pluginCid !== 'string' || pluginCid.length === 0) {
    throw new PluginPayloadValidationError('pluginCid must be a non-empty string');
  }
  return `plugin:${pluginCid}`;
}

// ── Publisher ────────────────────────────────────────────────────────────────

export interface PluginRegistryPublisherConfig {
  identityRegistryAddress: Address;
  /** Builder's ERC-8004 agentId (= `fleet_agent_id` from FleetState). */
  builderAgentId: bigint;
  /** Stage 1 fleet identity Safe (= `fleet_safe_address`). Required. */
  safeAddress: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export interface PublishPluginArgs {
  pluginCid: string;
  payload: PluginPayload;
}

export interface RevokePluginArgs {
  pluginCid: string;
  payload: RevocationPayload;
}

/**
 * High-level publisher for plug-in records.
 *
 * Routes writes through the operator's Stage 1 identity Safe via
 * `executeSafeTransaction`, mirroring `ReputationRegistryClient.sendWrite`'s
 * Safe-routed path. We require `safeAddress` (no direct-EOA escape hatch) —
 * the on-chain `msg.sender` must be the operator's canonical Stage 1 Safe
 * for the metadata write to bind to the right agentId owner.
 */
export class PluginRegistryPublisher {
  private readonly identityRegistryAddress: Address;
  private readonly builderAgentId: bigint;
  private readonly safeAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

  constructor(config: PluginRegistryPublisherConfig) {
    this.identityRegistryAddress = config.identityRegistryAddress;
    this.builderAgentId = config.builderAgentId;
    this.safeAddress = config.safeAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
  }

  get agentId(): bigint {
    return this.builderAgentId;
  }

  get safe(): Address {
    return this.safeAddress;
  }

  /** Publish a `plugin:<cid>` record. Returns the tx hash. */
  async publish(args: PublishPluginArgs): Promise<Hex> {
    const metadataKey = buildPluginMetadataKey(args.pluginCid);
    const metadataValue = encodePluginPayload(args.payload);
    return this._setMetadata(metadataKey, metadataValue);
  }

  /** Overwrite a `plugin:<cid>` record with a revoked-marker payload. */
  async revoke(args: RevokePluginArgs): Promise<Hex> {
    const metadataKey = buildPluginMetadataKey(args.pluginCid);
    const metadataValue = encodeRevocationPayload(args.payload);
    return this._setMetadata(metadataKey, metadataValue);
  }

  private async _setMetadata(metadataKey: string, metadataValue: Hex): Promise<Hex> {
    const calldata = encodeFunctionData({
      abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
      functionName: 'setMetadata',
      args: [this.builderAgentId, metadataKey, metadataValue],
    });

    const txHash = await executeSafeTransaction(this.publicClient, this.walletClient, {
      safeAddress: this.safeAddress,
      to: this.identityRegistryAddress,
      value: 0n,
      data: calldata,
    });

    await waitForTransactionReceiptWithRetry(this.publicClient, txHash);
    return txHash;
  }
}
```

- [ ] **Step 2: Run encoder/validator tests — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/erc8004/plugin-registry.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: all PASS.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/erc8004/plugin-registry.ts client/test/erc8004/plugin-registry.test.ts
git commit -m "feat(1pbc): plugin-registry encoders, validators, PluginRegistryPublisher"
```

---

## Task 5: Failing test — `pinFileToIpfs` uploads a binary tarball

**Files:**
- Create: `client/test/adapters/mech/ipfs-pinfile.test.ts`

- [ ] **Step 1: Create the test**

Create `client/test/adapters/mech/ipfs-pinfile.test.ts`:

```typescript
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pinFileToIpfs } from '../../../src/adapters/mech/ipfs-pinfile.js';

describe('pinFileToIpfs (1pbc)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('POSTs the file to <registry>/api/v0/add?pin=true&cid-version=1 and returns the CID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pinfile-'));
    dirs.push(dir);
    const tarballPath = join(dir, 'pkg-0.1.0.tgz');
    writeFileSync(tarballPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]));

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        '{"Name":"pkg-0.1.0.tgz","Hash":"bafyTarballCidExample","Size":"6"}\n',
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const cid = await pinFileToIpfs('https://registry.autonolas.tech', tarballPath);
    expect(cid).toBe('bafyTarballCidExample');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('/api/v0/add');
    expect(String(calledUrl)).toContain('pin=true');
    expect(String(calledUrl)).toContain('cid-version=1');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('throws when the registry returns non-200', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pinfile-'));
    dirs.push(dir);
    const tarballPath = join(dir, 'pkg.tgz');
    writeFileSync(tarballPath, Buffer.from([0x00]));

    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 502 })));

    await expect(pinFileToIpfs('https://registry.autonolas.tech', tarballPath)).rejects.toThrow(
      /502/,
    );
  });

  it('throws when the response lacks a Hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pinfile-'));
    dirs.push(dir);
    const tarballPath = join(dir, 'pkg.tgz');
    writeFileSync(tarballPath, Buffer.from([0x00]));

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"Name":"pkg.tgz","Size":"1"}\n', { status: 200 }),
    ));

    await expect(pinFileToIpfs('https://registry.autonolas.tech', tarballPath)).rejects.toThrow(
      /did not return a CID/i,
    );
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/adapters/mech/ipfs-pinfile.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `ipfs-pinfile.ts` does not exist.

- [ ] **Step 3: Commit failing test**

```bash
git add client/test/adapters/mech/ipfs-pinfile.test.ts
git commit -m "test(1pbc): failing test for pinFileToIpfs binary tarball upload"
```

---

## Task 6: Implement `pinFileToIpfs`

**Files:**
- Create: `client/src/adapters/mech/ipfs-pinfile.ts`

- [ ] **Step 1: Create the module**

Create `client/src/adapters/mech/ipfs-pinfile.ts`:

```typescript
/**
 * Binary-file pin helper for the Autonolas IPFS registry (jinn-mono-1pbc).
 *
 * The existing `uploadToIpfs` in `./ipfs.ts` serialises JSON via JCS, which
 * is wrong for binary tarballs (it forces a JSON parse and re-encode round
 * trip). This module is the sibling helper for the `jinn solver-plugins
 * publish` path: take a local tarball, POST it to the registry's
 * `/api/v0/add` endpoint with `pin=true&cid-version=1`, return the CID.
 *
 * Reuses `normalizeIpfsRegistryAddUrl` and `parseRegistryUploadCid` patterns
 * from `./ipfs.ts` for endpoint resolution and response parsing.
 */

import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { normalizeIpfsRegistryAddUrl } from './ipfs.js';

const IPFS_UPLOAD_TIMEOUT_MS = 120_000;

function parseRegistryUploadCid(responseText: string): string {
  let lastHash: string | undefined;
  for (const line of responseText.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { Hash?: unknown };
      if (typeof entry.Hash === 'string' && entry.Hash.length > 0) {
        lastHash = entry.Hash;
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  if (!lastHash) throw new Error('IPFS registry upload did not return a CID');
  return lastHash;
}

/**
 * Upload a local file to the IPFS registry and return its CID.
 *
 * Used by `jinn solver-plugins publish` to pin the packed plug-in tarball
 * before writing the `plugin:<cid>` metadata record on the IdentityRegistry.
 *
 * @param registryUrl operator-configured `ipfsRegistryUrl` (e.g. `https://registry.autonolas.tech`).
 * @param filePath absolute path to the local file (typically `.tgz`).
 */
export async function pinFileToIpfs(registryUrl: string, filePath: string): Promise<string> {
  const url = new URL(normalizeIpfsRegistryAddUrl(registryUrl));
  url.searchParams.set('pin', 'true');
  url.searchParams.set('cid-version', '1');
  url.searchParams.set('wrap-with-directory', 'false');

  const stat = statSync(filePath);
  const stream = createReadStream(filePath);
  const blob = await new Response(Readable.toWeb(stream) as ReadableStream).blob();

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([await blob.arrayBuffer()], { type: 'application/octet-stream' }),
    basename(filePath),
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IPFS_UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (response.status !== 200) {
      throw new Error(
        `IPFS registry upload failed with status ${response.status} (${stat.size} bytes): ${responseText.slice(0, 200)}`,
      );
    }
    return parseRegistryUploadCid(responseText);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2: Run test — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/adapters/mech/ipfs-pinfile.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/adapters/mech/ipfs-pinfile.ts
git commit -m "feat(1pbc): pinFileToIpfs — binary tarball upload to Autonolas registry"
```

---

## Task 7: Failing test — `publish` subverb dispatch + lazy `ensureStage1`

**Files:**
- Create: `client/test/cli/commands/solver-plugins-publish.test.ts`

- [ ] **Step 1: Create the test scaffold**

Create `client/test/cli/commands/solver-plugins-publish.test.ts`:

```typescript
/**
 * Tests for `jinn solver-plugins publish <source>` (jinn-mono-1pbc).
 *
 * Verifies:
 *   - Lazy ensureStage1 is invoked before any chain write
 *   - resolveSolverPlugin → pack → pinFileToIpfs → encodePluginPayload → publisher.publish
 *     pipeline produces a single tx hash in the output envelope
 *   - --builder-agent-id flag overrides fleet_agent_id
 *   - Failure when keystore missing is surfaced with code `keystore_missing`
 *   - No-op ensureStage1 when fleet_stage already 'stage1' or 'stage1_and_2'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../../src/cli/command.js';
import { createSolverPluginsCommand } from '../../../src/cli/commands/solver-plugins.js';

const tempDirs: string[] = [];

function withTempPlugin(name = 'test-plugin', version = '0.1.0'): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-plugin-'));
  tempDirs.push(dir);
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'jinn.plugin.json'),
    JSON.stringify({
      name,
      version,
      jinn: { supports: ['swe-rebench-v2.v1'] },
    }, null, 2),
  );
  return root;
}

function withTempConfig(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-publish-config-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    rpcUrl: 'http://127.0.0.1:8545',
    network: 'testnet',
    earningDir: dir,
    ipfsRegistryUrl: 'https://registry.autonolas.tech',
    ...extra,
  }), 'utf-8');
  return configPath;
}

function makeCtx(argv: string[]): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (s) => { writes.push(s); return true; } },
    exit: (code) => { exits.push(code); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

function parsedLine(writes: string[]): Record<string, unknown> {
  const joined = writes.join('');
  const line = joined.trim().split('\n').filter((s) => s.startsWith('{')).pop();
  return JSON.parse(line!);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('jinn solver-plugins publish', () => {
  it('runs the full pipeline and emits a tx hash envelope', async () => {
    const pluginRoot = withTempPlugin('@builder/swe-skill', '0.1.0');
    const configPath = withTempConfig();

    const ensureStage1 = vi.fn(async (_pw: string) => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 complete.',
    }));
    const pinFile = vi.fn(async (_url: string, _path: string) => 'bafyTarballCid');
    const publish = vi.fn(async () => '0xtxhashpublish' as `0x${string}`);
    const publisherFactory = vi.fn(() => ({ publish, revoke: vi.fn() }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: pinFile,
      publisherFactory,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    expect(ensureStage1).toHaveBeenCalledWith('test');
    expect(pinFile).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    const callArg = publish.mock.calls[0]![0];
    expect(callArg.pluginCid).toBe('bafyTarballCid');
    expect(callArg.payload.pluginName).toBe('@builder/swe-skill');
    expect(callArg.payload.pluginVersion).toBe('0.1.0');
    expect(callArg.payload.supports).toEqual(['swe-rebench-v2.v1']);
    expect(callArg.payload.publishedAt).toBe(1_715_700_000);

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins publish');
    expect(out.txHash).toBe('0xtxhashpublish');
    expect(out.pluginCid).toBe('bafyTarballCid');
    expect(out.builderAgentId).toBe('777');
    expect(out.pluginSha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(exits).toEqual([]);
  });

  it('skips ensureStage1 chain calls when fleet_stage is already stage1_and_2', async () => {
    const pluginRoot = withTempPlugin();
    const configPath = withTempConfig();

    const ensureStage1 = vi.fn(async () => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1_and_2',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 already complete (no-op).',
    }));
    const publish = vi.fn(async () => '0xtx' as `0x${string}`);

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(async () => 'bafyCid'),
      publisherFactory: () => ({ publish, revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    expect(ensureStage1).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('emits keystore_missing envelope when resolveCliPassword fails', async () => {
    const pluginRoot = withTempPlugin();
    const configPath = withTempConfig();

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: vi.fn() } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: false, error: 'no password' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('keystore_missing');
    expect(exits).toEqual([1]);
  });

  it('honours --builder-agent-id override', async () => {
    const pluginRoot = withTempPlugin();
    const configPath = withTempConfig();

    const ensureStage1 = vi.fn(async () => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 complete.',
    }));

    const seenConfigs: any[] = [];
    const publisherFactory = vi.fn((config: any) => {
      seenConfigs.push(config);
      return { publish: vi.fn(async () => '0xtx' as `0x${string}`), revoke: vi.fn() };
    });

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(async () => 'bafyCid'),
      publisherFactory,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx } = makeCtx([
      'publish', `path:${pluginRoot}`, '--config', configPath,
      '--builder-agent-id', '999',
    ]);
    await command.run(ctx);

    expect(seenConfigs[0].builderAgentId).toBe(999n);
  });

  it('emits ensure_stage1_failed when bootstrapper returns ok=false', async () => {
    const pluginRoot = withTempPlugin();
    const configPath = withTempConfig();

    const ensureStage1 = vi.fn(async () => ({
      ok: false,
      fleet_state: {
        fleet_agent_id: null,
        fleet_safe_address: null,
        fleet_identity_registry: null,
        fleet_stage: 'none',
        chain: 'base-sepolia',
      },
      message: 'Your master wallet needs more ETH …',
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('ensure_stage1_failed');
    expect((out as any).error?.message).toMatch(/master wallet/);
    expect(exits).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/cli/commands/solver-plugins-publish.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: FAIL — `createSolverPluginsCommand` factory does not exist and `publish` subverb is not implemented.

- [ ] **Step 3: Commit failing tests**

```bash
git add client/test/cli/commands/solver-plugins-publish.test.ts
git commit -m "test(1pbc): failing publish-verb dispatch + lazy-ensureStage1 tests"
```

---

## Task 8: Implement `publish` subverb + refactor to `createSolverPluginsCommand` factory

**Files:**
- Create: `client/src/cli/commands/solver-plugins-publish.ts`
- Modify: `client/src/cli/commands/solver-plugins.ts`

- [ ] **Step 1: Create the publish handler**

Create `client/src/cli/commands/solver-plugins-publish.ts`:

```typescript
/**
 * `jinn solver-plugins publish <source>` — builder action.
 *
 * BUILDER ACTION, NOT AN OPERATOR ACTION. Routes through the Stage 1
 * identity Safe (`fleet_safe_address`), lazily completing Stage 1 if
 * needed. Never touches Stage 2 (OLAS service / staking). A user with
 * `fleet_stage === 'none'` and zero ETH on their master EOA will be
 * surfaced an `ensure_stage1_failed` envelope with the funding hint;
 * funding the EOA and re-running is the expected resolution.
 *
 * Pipeline:
 *   1. resolveCliPassword (env > keystore-password file > prompt-fd)
 *   2. resolveSolverPlugin(source) → loaded plug-in metadata + sha256
 *   3. pack tarball into a temp dir, capturing pluginSha256
 *   4. bootstrapper.ensureStage1(password) — lazy; no-op if already stage1+
 *   5. pinFileToIpfs(registry, tarballPath) → pluginCid
 *   6. PluginRegistryPublisher.publish({ pluginCid, payload }) → txHash
 *
 * Outputs a single-line JSON envelope:
 *   { verb: 'solver-plugins publish', txHash, pluginCid, pluginSha256,
 *     builderAgentId, identityRegistry, safeAddress }
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getAddress, type Address } from 'viem';
import type { CommandContext } from '../command.js';
import {
  digestDirectory,
  loadSolverPluginManifest,
  resolveSolverPlugin,
} from '../../plugins/index.js';
import { PluginRegistryPublisher } from '../../erc8004/plugin-registry.js';
import type { PluginPayload } from '../../erc8004/plugin-registry.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import { createJinnPublicClient, createJinnWalletClient } from '../../earning/viem-clients.js';
import { walletPrivateKeyAtIndex, decryptMnemonic } from '../../earning/wallet.js';
import { FleetStateStore } from '../../earning/store.js';
import { privateKeyToAccount } from 'viem/accounts';

function writeJson(ctx: CommandContext, value: unknown): void {
  ctx.writer.write(JSON.stringify(value) + '\n');
}

export interface PublishOptions {
  source: string;
  configPath: string | undefined;
  builderAgentIdOverride: bigint | undefined;
  reasonUnused?: never;
}

export async function publishHandler(
  ctx: CommandContext,
  opts: PublishOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const passwordResult = deps.resolveCliPassword(ctx.argv, ctx.env);
  if (!passwordResult.ok) {
    writeJson(ctx, {
      error: {
        code: 'keystore_missing',
        message:
          'Could not resolve password. Set JINN_PASSWORD, write ~/.jinn-client/keystore-password, or pass --password-fd.',
      },
    });
    ctx.exit(1);
    return;
  }
  const password = passwordResult.password;

  let config: ReturnType<typeof deps.loadConfig>;
  try {
    config = deps.loadConfig({
      configPath: deps.getConfigPathFromArgs(ctx.argv) ?? opts.configPath,
    });
  } catch (err) {
    writeJson(ctx, {
      error: {
        code: 'config_load_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
    return;
  }

  // 1. Resolve plug-in.
  let loaded;
  try {
    loaded = await resolveSolverPlugin(opts.source);
  } catch (err) {
    writeJson(ctx, {
      error: {
        code: 'invalid_solver_plugin',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
    return;
  }

  // 2. Pack tarball into temp dir; recompute sha256 of the live source tree.
  const packDir = mkdtempSync(join(tmpdir(), 'jinn-publish-pack-'));
  let tarballPath: string;
  let pluginSha256Hex: string;
  try {
    const { path: manifestPath, manifest } = loadSolverPluginManifest(loaded.root);
    void manifestPath; // already loaded
    pluginSha256Hex = digestDirectory(loaded.root);
    tarballPath = join(packDir, `${manifest.name.replace(/[@/]/g, '_')}-${manifest.version}.tgz`);
    const tar = spawnSync(
      'tar',
      ['-czf', tarballPath, '-C', dirname(loaded.root), basename(loaded.root)],
      { encoding: 'utf8' },
    );
    if (tar.status !== 0) {
      throw new Error(tar.stderr || `tar exited ${tar.status}`);
    }
  } catch (err) {
    rmSync(packDir, { recursive: true, force: true });
    writeJson(ctx, {
      error: {
        code: 'pack_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
    return;
  }

  try {
    // 3. Lazy Stage 1 ensure.
    const bootstrapper = deps.bootstrapperFactory(config);
    const stage1 = await bootstrapper.ensureStage1(password);
    if (!stage1.ok) {
      writeJson(ctx, {
        error: { code: 'ensure_stage1_failed', message: stage1.message },
      });
      ctx.exit(1);
      return;
    }
    const fleet = stage1.fleet_state;
    if (!fleet.fleet_agent_id || !fleet.fleet_safe_address || !fleet.fleet_identity_registry) {
      writeJson(ctx, {
        error: {
          code: 'fleet_identity_missing',
          message:
            'Stage 1 completed but fleet identity is empty. Re-run `jinn solver-plugins publish` after the next stage1 cycle.',
        },
      });
      ctx.exit(1);
      return;
    }

    const builderAgentId =
      opts.builderAgentIdOverride ?? BigInt(fleet.fleet_agent_id);
    const safeAddress = getAddress(fleet.fleet_safe_address) as Address;
    const identityRegistry = getAddress(fleet.fleet_identity_registry) as Address;

    // 4. Pin tarball.
    const pluginCid = await deps.pinFileToIpfs(
      config.ipfsRegistryUrl ?? 'https://registry.autonolas.tech',
      tarballPath,
    );

    // 5. Publish setMetadata via Safe.
    const publicClient = createJinnPublicClient(
      config.rpcUrl,
      config.network === 'testnet' ? 'base-sepolia' : 'base',
    );
    const store = new FleetStateStore(config.earningDir);
    const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
    const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);
    const account = privateKeyToAccount(agentKey);
    const walletClient = createJinnWalletClient(
      config.rpcUrl,
      config.network === 'testnet' ? 'base-sepolia' : 'base',
      account,
    );

    const publisher = deps.publisherFactory({
      identityRegistryAddress: identityRegistry,
      builderAgentId,
      safeAddress,
      publicClient,
      walletClient,
    });

    const payload: PluginPayload = {
      version: 1,
      pluginName: loaded.manifest.name,
      pluginVersion: loaded.manifest.version,
      pluginSha256: ('0x' + pluginSha256Hex) as `0x${string}`,
      supports: loaded.manifest.jinn.supports,
      publishedAt: Math.floor(deps.now() / 1000),
    };

    const txHash = await publisher.publish({ pluginCid, payload });

    writeJson(ctx, {
      verb: 'solver-plugins publish',
      txHash,
      pluginCid,
      pluginSha256: payload.pluginSha256,
      builderAgentId: builderAgentId.toString(),
      identityRegistry,
      safeAddress,
      pluginName: loaded.manifest.name,
      pluginVersion: loaded.manifest.version,
      supports: loaded.manifest.jinn.supports,
      publishedAt: payload.publishedAt,
    });
  } catch (err) {
    writeJson(ctx, {
      error: {
        code: 'publish_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Refactor `solver-plugins.ts` into `createSolverPluginsCommand` factory**

Replace the contents of `client/src/cli/commands/solver-plugins.ts` (keep all existing `show / validate / pack` byte-identical behaviour; thread the new `publish` and `revoke` subverbs through deps):

```typescript
/**
 * `jinn solver-plugins {show, validate, pack, publish, revoke}`.
 *
 * `show`, `validate`, `pack` are author/curator tooling (zero chain writes).
 * `publish` and `revoke` are BUILDER actions that write `plugin:<cid>`
 * records on the ERC-8004 IdentityRegistry via the fleet's Stage 1 identity
 * Safe. The publish/revoke verbs lazily complete Stage 1 (`FleetBootstrapper.ensureStage1`)
 * before any chain write — no separate `jinn builder init` step.
 *
 * Per `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md`
 * §6.3.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Address, PublicClient, WalletClient } from 'viem';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import {
  digestDirectory,
  loadSolverPluginManifest,
  resolveSolverPlugin,
} from '../../plugins/index.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import {
  PluginRegistryPublisher,
  type PluginRegistryPublisherConfig,
} from '../../erc8004/plugin-registry.js';
import { pinFileToIpfs as defaultPinFileToIpfs } from '../../adapters/mech/ipfs-pinfile.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import { publishHandler } from './solver-plugins-publish.js';
import { revokeHandler } from './solver-plugins-revoke.js';

function writeJson(ctx: CommandContext, value: unknown): void {
  ctx.writer.write(JSON.stringify(value) + '\n');
}

function localRoot(target: string): string {
  const stripped = target.startsWith('file:') || target.startsWith('path:')
    ? target.slice(target.indexOf(':') + 1)
    : target;
  return isAbsolute(stripped) ? stripped : resolve(process.cwd(), stripped);
}

export interface PublisherFactoryArgs extends PluginRegistryPublisherConfig {}

export interface SolverPluginsDeps extends BaseCommandDeps {
  bootstrapperFactory: (cfg: ReturnType<typeof defaultLoadConfig>) => FleetBootstrapper;
  pinFileToIpfs: typeof defaultPinFileToIpfs;
  publisherFactory: (
    args: PublisherFactoryArgs,
  ) => {
    publish: PluginRegistryPublisher['publish'];
    revoke: PluginRegistryPublisher['revoke'];
  };
  resolveCliPassword: typeof defaultResolveCliPassword;
  now: () => number;
}

export const PRODUCTION_DEPS: SolverPluginsDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  bootstrapperFactory: (config) =>
    new FleetBootstrapper({
      earningDir: config.earningDir,
      chain: config.network === 'testnet' ? 'base-sepolia' : 'base',
      rpcUrl: config.rpcUrl,
      stakingMode: config.stakingMode,
    }),
  pinFileToIpfs: defaultPinFileToIpfs,
  publisherFactory: (args) => new PluginRegistryPublisher(args),
  resolveCliPassword: defaultResolveCliPassword,
  now: () => Date.now(),
};

const HELP = `Usage:
  jinn solver-plugins show <source-or-path>
  jinn solver-plugins validate <source-or-path>
  jinn solver-plugins pack <path> [--out <file.tgz>]
  jinn solver-plugins publish <source-or-path> [--builder-agent-id <id>]
  jinn solver-plugins revoke <pluginCid> --reason <text> [--builder-agent-id <id>]

SolverPlugin show/validate/pack are author/curator tooling — zero chain writes.

publish + revoke are BUILDER actions:
  • Write \`plugin:<cid>\` metadata records on the ERC-8004 IdentityRegistry.
  • Route through the fleet's Stage 1 identity Safe (\`fleet_safe_address\`).
  • Lazily complete Stage 1 (ETH funding + Safe deploy + agent NFT mint) if needed.
  • Never touch Stage 2 (OLAS service / staking) state.

Attach a plug-in to a SolverNet at runtime with:
  jinn solver-nets add-plugin <solver-net> <source>
`;

export function createSolverPluginsCommand(
  deps: SolverPluginsDeps = PRODUCTION_DEPS,
): CommandModule {
  return {
    name: 'solver-plugins',
    summary: 'Inspect, validate, pack, publish, and revoke SolverPlugin packages',
    helpText: HELP,
    async run(ctx) {
      const [subverb, ...rest] = ctx.argv;
      if (!subverb || subverb === '--help' || subverb === '-h') {
        ctx.writer.write(HELP + '\n');
        return;
      }
      if (subverb === 'show') return show(ctx, rest);
      if (subverb === 'validate') return validate(ctx, rest);
      if (subverb === 'pack') return pack(ctx, rest);
      if (subverb === 'publish') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            'builder-agent-id': { type: 'string' },
            config: { type: 'string' },
          },
        });
        const source = parsed.positionals[0];
        if (!source) {
          writeJson(ctx, {
            error: {
              code: 'invalid_invocation',
              message: 'solver-plugins publish requires <source-or-path>',
            },
          });
          ctx.exit(1);
          return;
        }
        return publishHandler(
          ctx,
          {
            source,
            configPath: parsed.values.config as string | undefined,
            builderAgentIdOverride: parsed.values['builder-agent-id']
              ? BigInt(parsed.values['builder-agent-id'] as string)
              : undefined,
          },
          deps,
        );
      }
      if (subverb === 'revoke') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            'builder-agent-id': { type: 'string' },
            config: { type: 'string' },
            reason: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        if (!pluginCid) {
          writeJson(ctx, {
            error: {
              code: 'invalid_invocation',
              message: 'solver-plugins revoke requires <pluginCid>',
            },
          });
          ctx.exit(1);
          return;
        }
        const reason = parsed.values.reason as string | undefined;
        if (!reason) {
          writeJson(ctx, {
            error: {
              code: 'invalid_invocation',
              message: 'solver-plugins revoke requires --reason <text>',
            },
          });
          ctx.exit(1);
          return;
        }
        return revokeHandler(
          ctx,
          {
            pluginCid,
            reason,
            configPath: parsed.values.config as string | undefined,
            builderAgentIdOverride: parsed.values['builder-agent-id']
              ? BigInt(parsed.values['builder-agent-id'] as string)
              : undefined,
          },
          deps,
        );
      }
      writeJson(ctx, {
        error: {
          code: 'invalid_invocation',
          message: `Unknown solver-plugins subverb: ${subverb}`,
          expected: 'show|validate|pack|publish|revoke',
        },
      });
      ctx.exit(1);
    },
  };
}

// ── show / validate / pack — unchanged ───────────────────────────────────────

async function show(ctx: CommandContext, rest: string[]): Promise<void> {
  const target = rest.find((arg) => !arg.startsWith('--'));
  if (!target) {
    writeJson(ctx, { error: { code: 'invalid_invocation', message: 'solver-plugins show requires <source-or-path>' } });
    ctx.exit(1);
    return;
  }
  try {
    const plugin = await resolveSolverPlugin(target);
    writeJson(ctx, {
      verb: 'solver-plugins show',
      plugin: {
        name: plugin.name,
        version: plugin.version,
        solverType: plugin.solverType,
        supports: plugin.supports,
        source: plugin.source,
        sourceKind: plugin.sourceKind,
        root: plugin.root,
        manifestPath: plugin.manifestPath,
        sha256: plugin.sha256,
        jinn: plugin.manifest.jinn,
      },
    });
  } catch (err) {
    writeJson(ctx, {
      error: { code: 'invalid_solver_plugin', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
  }
}

async function validate(ctx: CommandContext, rest: string[]): Promise<void> {
  const target = rest.find((arg) => !arg.startsWith('--'));
  if (!target) {
    writeJson(ctx, { error: { code: 'invalid_invocation', message: 'solver-plugins validate requires <source-or-path>' } });
    ctx.exit(1);
    return;
  }
  try {
    const plugin = await resolveSolverPlugin(target);
    writeJson(ctx, {
      verb: 'solver-plugins validate',
      ok: true,
      plugin: {
        name: plugin.name,
        version: plugin.version,
        solverType: plugin.solverType,
        supports: plugin.supports,
        sha256: plugin.sha256,
        manifestPath: plugin.manifestPath,
      },
    });
  } catch (err) {
    writeJson(ctx, {
      verb: 'solver-plugins validate',
      ok: false,
      error: { code: 'invalid_solver_plugin', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
  }
}

async function pack(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: 'string' } } });
  } catch (err) {
    writeJson(ctx, { error: { code: 'invalid_invocation', message: err instanceof Error ? err.message : String(err) } });
    ctx.exit(1);
    return;
  }
  const target = parsed.positionals[0];
  if (!target) {
    writeJson(ctx, { error: { code: 'invalid_invocation', message: 'solver-plugins pack requires <path>' } });
    ctx.exit(1);
    return;
  }
  const root = localRoot(target);
  if (!existsSync(root)) {
    writeJson(ctx, { error: { code: 'not_found', message: `SolverPlugin path not found: ${root}` } });
    ctx.exit(1);
    return;
  }
  try {
    const { path: manifestPath, manifest } = loadSolverPluginManifest(root);
    const sha256 = digestDirectory(root);
    const out = parsed.values.out
      ? resolve(process.cwd(), String(parsed.values.out))
      : resolve(process.cwd(), `${manifest.name}-${manifest.version}.tgz`);
    mkdirSync(dirname(out), { recursive: true });
    const tar = spawnSync('tar', ['-czf', out, '-C', dirname(root), basename(root)], { encoding: 'utf8' });
    if (tar.status !== 0) {
      throw new Error(tar.stderr || `tar exited ${tar.status}`);
    }
    writeJson(ctx, {
      verb: 'solver-plugins pack',
      packagePath: out,
      plugin: { name: manifest.name, version: manifest.version, supports: manifest.jinn.supports, manifestPath, sha256 },
    });
  } catch (err) {
    writeJson(ctx, { error: { code: 'invalid_solver_plugin', message: err instanceof Error ? err.message : String(err) } });
    ctx.exit(1);
  }
}

export default createSolverPluginsCommand();
```

- [ ] **Step 3: Create the revoke handler stub (full impl in Task 10)**

Create `client/src/cli/commands/solver-plugins-revoke.ts` with a TODO body so the import in `solver-plugins.ts` resolves:

```typescript
import type { CommandContext } from '../command.js';
import type { SolverPluginsDeps } from './solver-plugins.js';

export interface RevokeOptions {
  pluginCid: string;
  reason: string;
  configPath: string | undefined;
  builderAgentIdOverride: bigint | undefined;
}

export async function revokeHandler(
  ctx: CommandContext,
  _opts: RevokeOptions,
  _deps: SolverPluginsDeps,
): Promise<void> {
  ctx.writer.write(JSON.stringify({ error: { code: 'not_implemented', message: 'revoke handler — implemented in Task 10' } }) + '\n');
  ctx.exit(1);
}
```

- [ ] **Step 4: Run the publish test — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/cli/commands/solver-plugins-publish.test.ts --reporter=verbose 2>&1 | tail -40
```

Expected: all PASS.

- [ ] **Step 5: Ensure existing solver-plugins behaviour unchanged**

Run the existing typecheck:

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/solver-plugins.ts \
        client/src/cli/commands/solver-plugins-publish.ts \
        client/src/cli/commands/solver-plugins-revoke.ts
git commit -m "feat(1pbc): jinn solver-plugins publish — lazy-stage1 + IPFS pin + setMetadata write"
```

---

## Task 9: Failing test — `revoke` subverb

**Files:**
- Create: `client/test/cli/commands/solver-plugins-revoke.test.ts`

- [ ] **Step 1: Create the test**

Create `client/test/cli/commands/solver-plugins-revoke.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../../src/cli/command.js';
import { createSolverPluginsCommand } from '../../../src/cli/commands/solver-plugins.js';

const tempDirs: string[] = [];

function withTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-revoke-config-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    rpcUrl: 'http://127.0.0.1:8545',
    network: 'testnet',
    earningDir: dir,
  }), 'utf-8');
  return configPath;
}

function makeCtx(argv: string[]): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    ctx: {
      argv,
      stdoutIsTty: false,
      writer: { write: (s) => { writes.push(s); return true; } },
      exit: (code) => { exits.push(code); },
      env: { JINN_PASSWORD: 'test' },
    },
    writes, exits,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('jinn solver-plugins revoke', () => {
  it('writes a v2 revoked-marker via publisher.revoke', async () => {
    const configPath = withTempConfig();
    const revoke = vi.fn(async () => '0xtxrevoke' as `0x${string}`);

    const ensureStage1 = vi.fn(async () => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 complete.',
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx([
      'revoke', 'bafyOldCid',
      '--reason', 'security advisory CVE-2026-XXXX',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(revoke).toHaveBeenCalledOnce();
    const callArg = revoke.mock.calls[0]![0];
    expect(callArg.pluginCid).toBe('bafyOldCid');
    expect(callArg.payload.version).toBe(2);
    expect(callArg.payload.revoked).toBe(true);
    expect(callArg.payload.reason).toBe('security advisory CVE-2026-XXXX');

    const out = JSON.parse(writes.join('').trim().split('\n').pop()!);
    expect(out.verb).toBe('solver-plugins revoke');
    expect(out.txHash).toBe('0xtxrevoke');
    expect(out.pluginCid).toBe('bafyOldCid');
    expect(out.reason).toBe('security advisory CVE-2026-XXXX');
    expect(exits).toEqual([]);
  });

  it('requires --reason', async () => {
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: vi.fn() } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });
    const { ctx, writes, exits } = makeCtx(['revoke', 'bafyOldCid', '--config', configPath]);
    await command.run(ctx);
    const out = JSON.parse(writes.join('').trim().split('\n').pop()!);
    expect(out.error.code).toBe('invalid_invocation');
    expect(out.error.message).toMatch(/reason/i);
    expect(exits).toEqual([1]);
  });

  it('honours --builder-agent-id override', async () => {
    const configPath = withTempConfig();
    const revoke = vi.fn(async () => '0xtx' as `0x${string}`);
    const seenConfigs: any[] = [];
    const publisherFactory = vi.fn((cfg: any) => {
      seenConfigs.push(cfg);
      return { publish: vi.fn(), revoke };
    });

    const ensureStage1 = vi.fn(async () => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 complete.',
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx } = makeCtx([
      'revoke', 'bafyOldCid',
      '--reason', 'replaced by v0.2.0',
      '--builder-agent-id', '999',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(seenConfigs[0].builderAgentId).toBe(999n);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/cli/commands/solver-plugins-revoke.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: FAIL — revoke handler is a stub.

- [ ] **Step 3: Commit failing tests**

```bash
git add client/test/cli/commands/solver-plugins-revoke.test.ts
git commit -m "test(1pbc): failing revoke-verb tests"
```

---

## Task 10: Implement `revoke` handler

**Files:**
- Modify: `client/src/cli/commands/solver-plugins-revoke.ts`

- [ ] **Step 1: Replace the stub with the full handler**

Replace `client/src/cli/commands/solver-plugins-revoke.ts` with:

```typescript
/**
 * `jinn solver-plugins revoke <pluginCid> --reason <text>` — builder action.
 *
 * Overwrites `plugin:<pluginCid>` with a `version=2, revoked=true, reason` payload.
 * Same Safe-routed write path as `publish`; same lazy `ensureStage1` gate.
 */

import { getAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { CommandContext } from '../command.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import type { RevocationPayload } from '../../erc8004/plugin-registry.js';
import { createJinnPublicClient, createJinnWalletClient } from '../../earning/viem-clients.js';
import { walletPrivateKeyAtIndex, decryptMnemonic } from '../../earning/wallet.js';
import { FleetStateStore } from '../../earning/store.js';

export interface RevokeOptions {
  pluginCid: string;
  reason: string;
  configPath: string | undefined;
  builderAgentIdOverride: bigint | undefined;
}

function writeJson(ctx: CommandContext, value: unknown): void {
  ctx.writer.write(JSON.stringify(value) + '\n');
}

export async function revokeHandler(
  ctx: CommandContext,
  opts: RevokeOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const passwordResult = deps.resolveCliPassword(ctx.argv, ctx.env);
  if (!passwordResult.ok) {
    writeJson(ctx, {
      error: {
        code: 'keystore_missing',
        message:
          'Could not resolve password. Set JINN_PASSWORD, write ~/.jinn-client/keystore-password, or pass --password-fd.',
      },
    });
    ctx.exit(1);
    return;
  }
  const password = passwordResult.password;

  let config;
  try {
    config = deps.loadConfig({
      configPath: deps.getConfigPathFromArgs(ctx.argv) ?? opts.configPath,
    });
  } catch (err) {
    writeJson(ctx, {
      error: { code: 'config_load_failed', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
    return;
  }

  try {
    const bootstrapper = deps.bootstrapperFactory(config);
    const stage1 = await bootstrapper.ensureStage1(password);
    if (!stage1.ok) {
      writeJson(ctx, { error: { code: 'ensure_stage1_failed', message: stage1.message } });
      ctx.exit(1);
      return;
    }
    const fleet = stage1.fleet_state;
    if (!fleet.fleet_agent_id || !fleet.fleet_safe_address || !fleet.fleet_identity_registry) {
      writeJson(ctx, {
        error: {
          code: 'fleet_identity_missing',
          message: 'Stage 1 completed but fleet identity is empty.',
        },
      });
      ctx.exit(1);
      return;
    }

    const builderAgentId =
      opts.builderAgentIdOverride ?? BigInt(fleet.fleet_agent_id);
    const safeAddress = getAddress(fleet.fleet_safe_address) as Address;
    const identityRegistry = getAddress(fleet.fleet_identity_registry) as Address;

    const publicClient = createJinnPublicClient(
      config.rpcUrl,
      config.network === 'testnet' ? 'base-sepolia' : 'base',
    );
    const store = new FleetStateStore(config.earningDir);
    const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
    const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);
    const account = privateKeyToAccount(agentKey);
    const walletClient = createJinnWalletClient(
      config.rpcUrl,
      config.network === 'testnet' ? 'base-sepolia' : 'base',
      account,
    );

    const publisher = deps.publisherFactory({
      identityRegistryAddress: identityRegistry,
      builderAgentId,
      safeAddress,
      publicClient,
      walletClient,
    });

    const payload: RevocationPayload = {
      version: 2,
      revoked: true,
      reason: opts.reason,
    };

    const txHash = await publisher.revoke({ pluginCid: opts.pluginCid, payload });

    writeJson(ctx, {
      verb: 'solver-plugins revoke',
      txHash,
      pluginCid: opts.pluginCid,
      reason: opts.reason,
      builderAgentId: builderAgentId.toString(),
      identityRegistry,
      safeAddress,
    });
  } catch (err) {
    writeJson(ctx, {
      error: {
        code: 'revoke_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
  }
}
```

- [ ] **Step 2: Run revoke test — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn vitest run test/cli/commands/solver-plugins-revoke.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/cli/commands/solver-plugins-revoke.ts
git commit -m "feat(1pbc): jinn solver-plugins revoke — v2 revoked-marker payload"
```

---

## Task 11: Wire `solver-plugins` into the CLI dispatcher (if not already)

**Files:**
- Verify: `client/src/cli/index.ts` or `client/src/cli/commands/index.ts` already registers `solver-plugins`. The existing module's `export default command` is unchanged shape (now produced by `createSolverPluginsCommand()`); no dispatcher edit should be needed.

- [ ] **Step 1: Grep for current registration**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && grep -rn "solver-plugins" src/cli/ | grep -v test
```

Expected: an existing entry in the dispatcher importing the default export from `commands/solver-plugins.js`. If absent, add it; otherwise skip this task.

- [ ] **Step 2: Smoke-test the help text**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn tsx src/main.ts solver-plugins --help 2>&1 | head -20
```

Expected: prints the new `HELP` block with publish/revoke lines.

- [ ] **Step 3: Commit (only if dispatcher changed)**

```bash
git add client/src/cli/
git commit -m "chore(1pbc): wire solver-plugins publish/revoke into CLI help" || true
```

---

## Task 12: Anvil-fork integration test — `publish` against deployed Base Sepolia IdentityRegistry

**Files:**
- Create: `client/test/cli/commands/solver-plugins-publish.anvil.test.ts`

This test follows the pattern in `client/test/earning/bootstrap.test.ts` (already in the nghf branch): construct a real `FleetBootstrapper` against `http://127.0.0.1:8545`, stub `publicClient.getBalance` for the funding gate, stub IPFS, and verify a real on-chain `setMetadata` call would be encoded against the deployed Base Sepolia IdentityRegistry contract. Because constructing a full Anvil-funded fleet is heavy, we run a **lighter integration test**: assemble a real `PluginRegistryPublisher` against an Anvil fork and verify `MetadataSet`-shaped behaviour through the calldata path, without requiring a live Stage 1 deploy.

- [ ] **Step 1: Create the Anvil integration test**

Create `client/test/cli/commands/solver-plugins-publish.anvil.test.ts`:

```typescript
/**
 * Anvil-fork integration test for `jinn solver-plugins publish` (1pbc).
 *
 * Verifies the full encode + Safe-routed `setMetadata` path against a forked
 * Base Sepolia chain. Skipped automatically when ANVIL_RPC_URL is unset.
 *
 * Setup expectations (matches docs/runbooks/testing.md "anvil-fork" pyramid level):
 *   anvil --fork-url https://sepolia.base.org --port 8545 &
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 yarn vitest run test/cli/commands/solver-plugins-publish.anvil.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  decodeAbiParameters,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  PLUGIN_PAYLOAD_TUPLE,
  REVOCATION_PAYLOAD_TUPLE,
  IDENTITY_REGISTRY_SET_METADATA_ABI,
} from '../../../src/erc8004/abis.js';
import {
  encodePluginPayload,
  encodeRevocationPayload,
  buildPluginMetadataKey,
} from '../../../src/erc8004/plugin-registry.js';

const ANVIL_RPC = process.env.ANVIL_RPC_URL;
const BASE_SEPOLIA_IDENTITY_REGISTRY: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

const runOrSkip = ANVIL_RPC ? describe : describe.skip;

runOrSkip('solver-plugins publish — Anvil fork against Base Sepolia IdentityRegistry', () => {
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(ANVIL_RPC) });

  it('encodePluginPayload calldata decodes to the original payload', () => {
    const payload = {
      version: 1 as const,
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: ('0x' + 'cd'.repeat(32)) as Hex,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000,
    };

    const encoded = encodePluginPayload(payload);
    const decoded = decodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe('@builder/swe-skill');
    expect(decoded[3]).toBe(payload.pluginSha256);
    expect(decoded[4]).toEqual(['swe-rebench-v2.v1']);
  });

  it('encodes setMetadata calldata against the deployed IdentityRegistry', () => {
    const pluginCid = 'bafyExampleCid';
    const metadataKey = buildPluginMetadataKey(pluginCid);
    const payloadBytes = encodePluginPayload({
      version: 1,
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: ('0x' + 'ab'.repeat(32)) as Hex,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000,
    });

    const calldata = encodeFunctionData({
      abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
      functionName: 'setMetadata',
      args: [777n, metadataKey, payloadBytes],
    });

    expect(calldata).toMatch(/^0x[0-9a-f]+$/);
    // setMetadata(uint256, string, bytes) selector = 0x… verify length & shape.
    expect(calldata.length).toBeGreaterThan(2 + 8);
  });

  it('revocation payload v2 round-trips', () => {
    const encoded = encodeRevocationPayload({
      version: 2,
      revoked: true,
      reason: 'replaced by v0.2.0',
    });
    const decoded = decodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(2);
    expect(decoded[1]).toBe(true);
    expect(decoded[2]).toBe('replaced by v0.2.0');
  });
});
```

- [ ] **Step 2: Run the test — Anvil active**

```bash
# Terminal 1:
# anvil --fork-url https://sepolia.base.org --port 8545
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && \
  ANVIL_RPC_URL=http://127.0.0.1:8545 \
  yarn vitest run test/cli/commands/solver-plugins-publish.anvil.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 3: Run the test — Anvil unset**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && \
  yarn vitest run test/cli/commands/solver-plugins-publish.anvil.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: SKIPPED.

- [ ] **Step 4: Commit**

```bash
git add client/test/cli/commands/solver-plugins-publish.anvil.test.ts
git commit -m "test(1pbc): Anvil-fork integration test for setMetadata calldata shape"
```

---

## Task 13: Full-suite verification + typecheck + build

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn test 2>&1 | tail -40
```

Expected: all PASS (no regressions in existing solver-plugins tests, bootstrap tests, identity-publisher tests, reputation-registry tests).

- [ ] **Step 2: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn typecheck 2>&1 | tail -10
```

Expected: zero errors.

- [ ] **Step 3: Build**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn build 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Lint (if configured)**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/1pbc/client && yarn lint 2>&1 | tail -10 || true
```

Expected: clean or unchanged.

- [ ] **Step 5: Commit any auto-formatter changes (if any)**

```bash
git status
git diff --stat
# If only whitespace/format changes:
git add -A && git commit -m "chore(1pbc): formatter pass" || true
```

---

## Self-review

Run through this checklist before declaring the plan executed:

- [ ] `PLUGIN_PAYLOAD_TUPLE` matches spec §5.2 exactly (`version, pluginName, pluginVersion, pluginSha256, supports[], publishedAt`).
- [ ] `REVOCATION_PAYLOAD_TUPLE` matches spec §5.2 revoked-marker (`version=2, revoked=bool, reason=string`).
- [ ] `encodePluginPayload` validates before encoding — never silently produces malformed bytes.
- [ ] `buildPluginMetadataKey` is `plugin:<cid>` (no normalization, no stripping).
- [ ] `PluginRegistryPublisher` routes writes through `executeSafeTransaction` with `fleet_safe_address` — same pattern as `ReputationRegistryClient.sendWrite`.
- [ ] CLI's `createSolverPluginsCommand` factory is the public surface; PRODUCTION_DEPS wired correctly.
- [ ] `show / validate / pack` behaviour is byte-identical to pre-refactor.
- [ ] `publish` sub-verb lazy-runs `bootstrapper.ensureStage1(password)` before any chain write.
- [ ] When `fleet_stage === 'stage1'` or `'stage1_and_2'`, `ensureStage1` short-circuits (existing bootstrap behaviour; verified in unit test).
- [ ] `--builder-agent-id <id>` flag overrides `fleet_agent_id` in both `publish` and `revoke`.
- [ ] Missing password / missing config / failed-Stage-1 each produce a clear error envelope (`keystore_missing`, `config_load_failed`, `ensure_stage1_failed`).
- [ ] Revoke requires `--reason <text>`; emits `invalid_invocation` otherwise.
- [ ] Tarball upload uses `pinFileToIpfs` (binary path), not `uploadToIpfs` (JCS-JSON path).
- [ ] Anvil-fork test skips cleanly when `ANVIL_RPC_URL` is unset.
- [ ] Verb doc-string clarifies "BUILDER ACTION, NOT AN OPERATOR ACTION" at the top of `solver-plugins-publish.ts`.
- [ ] No new top-level CLI verb is introduced — `publish` and `revoke` are subverbs under the existing `solver-plugins` tree (per spec §6.3 default).
- [ ] No emoji in any user-facing string (per BRAND.md non-negotiables).

---

```