import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIpfsFetchCidPathCandidates,
  buildIpfsHexCidCandidatesFromPartialHex,
  normalizeIpfsGatewayBase,
  fetchSignedIntentFromIpfs,
} from '../../../src/adapters/mech/ipfs.js';

describe('ipfs gateway + CID helpers (jinn-node parity)', () => {
  it('normalizeIpfsGatewayBase handles origin-only, /ipfs suffix, and trailing slashes', () => {
    expect(normalizeIpfsGatewayBase('https://gateway.autonolas.tech')).toBe(
      'https://gateway.autonolas.tech/ipfs/',
    );
    expect(normalizeIpfsGatewayBase('https://gateway.autonolas.tech/ipfs')).toBe(
      'https://gateway.autonolas.tech/ipfs/',
    );
    expect(normalizeIpfsGatewayBase('https://gateway.autonolas.tech/ipfs/')).toBe(
      'https://gateway.autonolas.tech/ipfs/',
    );
  });

  it('buildIpfsHexCidCandidatesFromPartialHex returns raw then dag-pb for 32-byte digest', () => {
    const d = 'a'.repeat(64);
    expect(buildIpfsHexCidCandidatesFromPartialHex(d)).toEqual([
      `f01551220${d}`,
      `f01701220${d}`,
    ]);
  });

  it('buildIpfsFetchCidPathCandidates expands f015 full hex to both codecs', () => {
    const d = 'b'.repeat(64);
    const f015 = `f01551220${d}`;
    expect(buildIpfsFetchCidPathCandidates(f015)).toEqual([`f01551220${d}`, `f01701220${d}`]);
  });

  it('buildIpfsFetchCidPathCandidates passes through base32 CIDs unchanged', () => {
    const bafy =
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    expect(buildIpfsFetchCidPathCandidates(bafy)).toEqual([bafy]);
  });
});

// ── fetchSignedIntentFromIpfs ─────────────────────────────────────────────────

/** Minimal valid SignedIntentV1 fixture. */
const VALID_SIGNED_INTENT = {
  schemaVersion: 'intent.v1',
  id: 'test-intent-id',
  kind: 'portfolio.v0',
  description: 'Test intent description',
  window: { startTs: 1_000_000, endTs: 1_086_400_000 },
  spec: { kind: 'portfolio.v0' },
  eligibility: {},
  creator: {
    safeAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    agentEoa: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
  createdAt: 1_000_000,
  signature: {
    algo: 'secp256k1',
    signer: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hash: '0x' + 'ab'.repeat(32),
    sig: '0x' + 'cd'.repeat(65),
  },
};

function makeFetchStub(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('fetchSignedIntentFromIpfs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid SignedIntentV1 fetched from IPFS', async () => {
    vi.stubGlobal('fetch', makeFetchStub(VALID_SIGNED_INTENT));

    const result = await fetchSignedIntentFromIpfs(
      'https://gateway.autonolas.tech',
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    );

    expect(result.schemaVersion).toBe('intent.v1');
    expect(result.id).toBe('test-intent-id');
    expect(result.kind).toBe('portfolio.v0');
    expect(result.signature.algo).toBe('secp256k1');
  });

  it('throws ZodError when the fetched document lacks a signature field', async () => {
    const noSig = { ...VALID_SIGNED_INTENT };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (noSig as any).signature;

    vi.stubGlobal('fetch', makeFetchStub(noSig));

    await expect(
      fetchSignedIntentFromIpfs(
        'https://gateway.autonolas.tech',
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ),
    ).rejects.toThrow();
  });

  it('throws ZodError when schemaVersion is not intent.v1', async () => {
    const wrongVersion = { ...VALID_SIGNED_INTENT, schemaVersion: 'intent.v0' };

    vi.stubGlobal('fetch', makeFetchStub(wrongVersion));

    await expect(
      fetchSignedIntentFromIpfs(
        'https://gateway.autonolas.tech',
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ),
    ).rejects.toThrow();
  });

  it('throws when kind and spec.kind do not match', async () => {
    const mismatch = {
      ...VALID_SIGNED_INTENT,
      kind: 'portfolio.v0',
      spec: { kind: 'something-else' },
    };

    vi.stubGlobal('fetch', makeFetchStub(mismatch));

    await expect(
      fetchSignedIntentFromIpfs(
        'https://gateway.autonolas.tech',
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ),
    ).rejects.toThrow();
  });
});
