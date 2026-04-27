import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIpfsFetchCidPathCandidates,
  buildIpfsHexCidCandidatesFromPartialHex,
  normalizeIpfsGatewayBase,
  fetchSignedIntentFromIpfs,
  fetchSourceBundleFromIpfs,
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

// ── fetchSourceBundleFromIpfs ─────────────────────────────────────────────────

const MANIFEST_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const FILE_CID = 'bafybeif2pall7dybz7vecqka3zo24irdwabwdi4wc55mdxa3scnvnklcva';
const FILE_TEXT = 'export const answer = 42;\n';

/**
 * Returns a fetch stub that serves `manifest` JSON for the manifest CID path
 * and raw text bytes for the file CID path. This exercises the split fetch
 * path: manifest uses JSON, source files use raw bytes via TextDecoder.
 */
function makeSourceBundleFetchStub(
  manifest: Record<string, unknown>,
  fileText: string,
) {
  return vi.fn().mockImplementation((url: string) => {
    const isFileCid = url.includes(FILE_CID);
    if (isFileCid) {
      // Simulate a text/plain response for source files
      const encoder = new TextEncoder();
      const bytes = encoder.encode(fileText);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'text/plain; charset=utf-8' },
        arrayBuffer: () => Promise.resolve(bytes.buffer),
        json: () => Promise.reject(new Error('Not JSON')),
        text: () => Promise.resolve(fileText),
      });
    }
    // Serve the manifest as JSON
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(manifest),
      text: () => Promise.resolve(JSON.stringify(manifest)),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(manifest)).buffer),
    });
  });
}

describe('fetchSourceBundleFromIpfs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches manifest as JSON and source files as raw bytes via TextDecoder', async () => {
    const manifest = {
      files: [{ path: 'index.ts', cid: FILE_CID }],
    };

    vi.stubGlobal('fetch', makeSourceBundleFetchStub(manifest, FILE_TEXT));

    const result = await fetchSourceBundleFromIpfs(
      'https://gateway.autonolas.tech',
      MANIFEST_CID,
    );

    // The file text should be returned as-is (not JSON.stringified or parsed)
    expect(result.files.get('index.ts')).toBe(FILE_TEXT);
    expect(result.manifest).toMatchObject({ files: [{ path: 'index.ts', cid: FILE_CID }] });
  });

  it('returns empty files map when manifest has no files array', async () => {
    const manifest = { version: 1 };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(manifest),
      text: () => Promise.resolve(JSON.stringify(manifest)),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(manifest)).buffer),
    }));

    const result = await fetchSourceBundleFromIpfs(
      'https://gateway.autonolas.tech',
      MANIFEST_CID,
    );

    expect(result.files.size).toBe(0);
  });

  it('preserves raw text content including newlines without JSON round-trip mangling', async () => {
    const multilineSource = 'const x = 1;\nconst y = 2;\nexport { x, y };\n';
    const manifest = {
      files: [{ path: 'utils.ts', cid: FILE_CID }],
    };

    vi.stubGlobal('fetch', makeSourceBundleFetchStub(manifest, multilineSource));

    const result = await fetchSourceBundleFromIpfs(
      'https://gateway.autonolas.tech',
      MANIFEST_CID,
    );

    expect(result.files.get('utils.ts')).toBe(multilineSource);
  });
});
