/**
 * Tests for SolverNet manifest cryptography (Task 2).
 *
 * Covers:
 * - canonicalize (signature stripped, RFC 8785 JCS)
 * - sign / verify round-trip
 * - tampered body fails
 * - wrong-signer key fails
 * - manifestHash determinism + signature-field-independence
 * - verifyManifestAgainstChain happy path + agentId / Safe mismatches
 *
 * The IdentityRegistry surface is mocked at the interface level — Task 4 will
 * wire the on-chain implementation.
 */

import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';

import {
  canonicalManifestJson,
  manifestHash,
  signManifest,
  verifyManifestSignature,
  verifyManifestAgainstChain,
  type IdentityRegistryReader,
  type UnsignedSolverNetManifestV1,
} from '../../src/solvernets/manifest.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function buildUnsignedManifest(overrides: {
  agentEoa: `0x${string}`;
  safeAddress?: `0x${string}`;
  agentId?: string;
  name?: string;
}): UnsignedSolverNetManifestV1 {
  return {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: 'launcher-1/prediction-001',
    network: 'base-sepolia',
    name: overrides.name ?? 'Prediction Markets — Test',
    description: 'A test SolverNet for the manifest module test suite.',
    launcher: {
      safeAddress:
        overrides.safeAddress ??
        ('0x1111111111111111111111111111111111111111' as `0x${string}`),
      agentEoa: overrides.agentEoa,
      agentId: overrides.agentId ?? '5474',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: {
        task: { type: 'object' },
        solution: { type: 'object' },
        verdict: { type: 'object' },
      },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 10,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      credentialRequirements: {
        creator: [],
        solver: [],
        evaluator: [],
      },
      evaluationFunction: {
        id: 'prediction.brier-loss.v1',
        deterministic: true,
        inputs: ['solution', 'resolution'],
        output: 'verdict',
        implementation: 'jinn:harness:prediction-v1-evaluator',
      },
      aggregationFunction: {
        id: 'prediction.trailing-mean-brier-spread.v1',
        deterministic: true,
        inputs: ['verdict[]'],
        output: 'score',
        windowDays: 30,
      },
    },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
    createdAt: '2026-05-06T00:00:00Z',
    launchedAt: '2026-05-06T00:01:00Z',
  };
}

// ── canonicalManifestJson ────────────────────────────────────────────────────

describe('canonicalManifestJson', () => {
  it('strips the signature field and produces deterministic output', () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });

    const a = canonicalManifestJson(unsigned);
    const withFakeSig: SolverNetManifestV1 = {
      ...unsigned,
      signature: {
        alg: 'eip-191',
        signer: acct.address,
        value: ('0x' + 'ab'.repeat(65)) as `0x${string}`,
      },
    };
    const b = canonicalManifestJson(withFakeSig);

    expect(a).toEqual(b);
    expect(a).not.toContain('"signature"');
  });

  it('sorts object keys lexicographically (RFC 8785 JCS)', () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });

    const out = canonicalManifestJson(unsigned);
    // `description` should appear before `launcher` (alphabetical).
    expect(out.indexOf('"description"')).toBeLessThan(out.indexOf('"launcher"'));
    // `name` should appear before `network`.
    expect(out.indexOf('"name"')).toBeLessThan(out.indexOf('"network"'));
  });
});

// ── manifestHash ─────────────────────────────────────────────────────────────

describe('manifestHash', () => {
  it('returns a 32-byte hex string', () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });
    const h = manifestHash(unsigned);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic for the same body', () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });
    const h1 = manifestHash(unsigned);
    const h2 = manifestHash(unsigned);
    expect(h1).toEqual(h2);
  });

  it('changes when any non-signature field changes', () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const a = buildUnsignedManifest({ agentEoa: acct.address, name: 'Alpha' });
    const b = buildUnsignedManifest({ agentEoa: acct.address, name: 'Beta' });
    expect(manifestHash(a)).not.toEqual(manifestHash(b));
  });

  it('is independent of the signature field', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });
    const hUnsigned = manifestHash(unsigned);

    const signed = await signManifest(unsigned, pk);
    const hSigned = manifestHash(signed);

    expect(hUnsigned).toEqual(hSigned);
  });
});

// ── signManifest / verifyManifestSignature ───────────────────────────────────

describe('signManifest + verifyManifestSignature', () => {
  it('round-trips: signed manifest verifies with recovered signer', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });

    const signed = await signManifest(unsigned, pk);

    expect(signed.signature.alg).toBe('eip-191');
    expect(signed.signature.signer.toLowerCase()).toBe(acct.address.toLowerCase());
    expect(signed.signature.value).toMatch(/^0x[0-9a-f]+$/i);

    const result = await verifyManifestSignature(signed);
    expect(result.valid).toBe(true);
    expect(result.signer?.toLowerCase()).toBe(acct.address.toLowerCase());
  });

  it('fails when the body is tampered after signing', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });

    const signed = await signManifest(unsigned, pk);
    const tampered: SolverNetManifestV1 = {
      ...signed,
      name: 'Tampered Name',
    };

    const result = await verifyManifestSignature(tampered);
    expect(result.valid).toBe(false);
  });

  it('fails when the signature was produced by a different key', async () => {
    const pkA = generatePrivateKey();
    const pkB = generatePrivateKey();
    const acctA = privateKeyToAccount(pkA);
    const acctB = privateKeyToAccount(pkB);

    // Sign a manifest legitimately with pkB (signManifest now requires the
    // private key to derive launcher.agentEoa). We then forge a lying body
    // that names acctA in `launcher.agentEoa` and `signature.signer` while
    // re-using pkB's signature value — the recovered signer (acctB) won't
    // match the claim (acctA), so verification must fail.
    const unsignedB = buildUnsignedManifest({ agentEoa: acctB.address });
    const signedB = await signManifest(unsignedB, pkB);

    const lying: SolverNetManifestV1 = {
      ...signedB,
      launcher: { ...signedB.launcher, agentEoa: acctA.address },
      signature: { ...signedB.signature, signer: acctA.address },
    };

    const result = await verifyManifestSignature(lying);
    expect(result.valid).toBe(false);
  });

  it('throws when the private key derives a different address than launcher.agentEoa', async () => {
    const pkA = generatePrivateKey();
    const pkB = generatePrivateKey();
    const acctA = privateKeyToAccount(pkA);

    // Manifest declares acctA as the agent EOA, but we hand sign a different key.
    const unsigned = buildUnsignedManifest({ agentEoa: acctA.address });

    await expect(signManifest(unsigned, pkB)).rejects.toThrow(/agentEoaPrivateKey derives/);
  });

  it('rejects manifests with non-eip-191 signatures', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });
    const signed = await signManifest(unsigned, pk);

    const broken = {
      ...signed,
      signature: { ...signed.signature, alg: 'ed25519' as unknown as 'eip-191' },
    } as SolverNetManifestV1;

    const result = await verifyManifestSignature(broken);
    expect(result.valid).toBe(false);
  });
});

// ── verifyManifestAgainstChain ───────────────────────────────────────────────

function makeRegistry(behavior: {
  agentByWallet: Record<string, { agentId: string } | null>;
  safeForAgent: Record<string, `0x${string}` | null>;
}): IdentityRegistryReader {
  return {
    async getAgentByWallet(wallet) {
      return behavior.agentByWallet[wallet.toLowerCase()] ?? null;
    },
    async getSafeForAgent(agentId) {
      return behavior.safeForAgent[agentId] ?? null;
    },
  };
}

describe('verifyManifestAgainstChain', () => {
  it('passes when signer + agentId + Safe all match the registry', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const safe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const unsigned = buildUnsignedManifest({
      agentEoa: acct.address,
      safeAddress: safe,
      agentId: '5474',
    });
    const signed = await signManifest(unsigned, pk);

    const registry = makeRegistry({
      agentByWallet: { [acct.address.toLowerCase()]: { agentId: '5474' } },
      safeForAgent: { '5474': safe },
    });

    const result = await verifyManifestAgainstChain(signed, registry);
    expect(result).toEqual({ valid: true });
  });

  it('fails when the registry does not know the signer wallet', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });
    const signed = await signManifest(unsigned, pk);

    const registry = makeRegistry({
      agentByWallet: {},
      safeForAgent: {},
    });

    const result = await verifyManifestAgainstChain(signed, registry);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/agent/i);
  });

  it('fails when the registry agentId does not match manifest.launcher.agentId', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const safe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const unsigned = buildUnsignedManifest({
      agentEoa: acct.address,
      safeAddress: safe,
      agentId: '5474',
    });
    const signed = await signManifest(unsigned, pk);

    const registry = makeRegistry({
      agentByWallet: { [acct.address.toLowerCase()]: { agentId: '9999' } },
      safeForAgent: { '9999': safe },
    });

    const result = await verifyManifestAgainstChain(signed, registry);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/agentId/);
  });

  it('fails when the registry Safe does not match manifest.launcher.safeAddress', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const declaredSafe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const otherSafe = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
    const unsigned = buildUnsignedManifest({
      agentEoa: acct.address,
      safeAddress: declaredSafe,
      agentId: '5474',
    });
    const signed = await signManifest(unsigned, pk);

    const registry = makeRegistry({
      agentByWallet: { [acct.address.toLowerCase()]: { agentId: '5474' } },
      safeForAgent: { '5474': otherSafe },
    });

    const result = await verifyManifestAgainstChain(signed, registry);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/safe/i);
  });

  it('fails when the signature itself is invalid (does not query the registry)', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const unsigned = buildUnsignedManifest({ agentEoa: acct.address });
    const signed = await signManifest(unsigned, pk);
    const tampered: SolverNetManifestV1 = { ...signed, name: 'Tampered' };

    let getAgentCalls = 0;
    const registry: IdentityRegistryReader = {
      async getAgentByWallet() {
        getAgentCalls += 1;
        return { agentId: '5474' };
      },
      async getSafeForAgent() {
        return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
      },
    };

    const result = await verifyManifestAgainstChain(tampered, registry);
    expect(result.valid).toBe(false);
    expect(getAgentCalls).toBe(0);
  });

  it('forwards atBlock to the registry reader', async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const safe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const unsigned = buildUnsignedManifest({
      agentEoa: acct.address,
      safeAddress: safe,
      agentId: '5474',
    });
    const signed = await signManifest(unsigned, pk);

    let walletAtBlock: bigint | undefined;
    let agentAtBlock: bigint | undefined;
    const registry: IdentityRegistryReader = {
      async getAgentByWallet(_wallet, atBlock) {
        walletAtBlock = atBlock;
        return { agentId: '5474' };
      },
      async getSafeForAgent(_agentId, atBlock) {
        agentAtBlock = atBlock;
        return safe;
      },
    };

    const result = await verifyManifestAgainstChain(signed, registry, 12345n);
    expect(result.valid).toBe(true);
    expect(walletAtBlock).toBe(12345n);
    expect(agentAtBlock).toBe(12345n);
  });
});
