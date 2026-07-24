import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIpfsFetchCidPathCandidates,
  buildIpfsHexCidCandidatesFromPartialHex,
  normalizeIpfsGatewayBase,
  fetchSignedTaskFromIpfs,
  fetchSourceBundleFromIpfs,
  cidToDigestHex,
  rawSha256CidToDigestHex,
} from '../../../src/adapters/mech/ipfs.js';

const DEFAULT_CLAIM_POLICY = {
  mode: 'parallel' as const,
  maxClaims: 25,
  maxClaimsPerOperator: 1,
  claimLeaseTtlSeconds: 600,
};

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

// ── fetchSignedTaskFromIpfs ─────────────────────────────────────────────────

/** Minimal valid SignedTaskV1 fixture. */
const VALID_SIGNED_TASK = {
  schemaVersion: 'task.v1',
  id: 'test-task-id',
  solverType: 'portfolio.v0',
  contractId: 'portfolio',
  contractVersion: 'v0',
  solverNetManifestCid: 'bafyfixturecid',
  role: 'restoration',
  description: 'Test task description',
  window: { startTs: 1_000_000, endTs: 1_086_400_000 },
  spec: {},
  eligibility: {},
  claimPolicy: DEFAULT_CLAIM_POLICY,
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

describe('fetchSignedTaskFromIpfs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid SignedTaskV1 fetched from IPFS', async () => {
    vi.stubGlobal('fetch', makeFetchStub(VALID_SIGNED_TASK));

    const result = await fetchSignedTaskFromIpfs(
      'https://gateway.autonolas.tech',
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    );

    expect(result.schemaVersion).toBe('task.v1');
    expect(result.id).toBe('test-task-id');
    expect(result.solverType).toBe('portfolio.v0');
    expect(result.signature.algo).toBe('secp256k1');
  });

  it('throws ZodError when the fetched document lacks a signature field', async () => {
    const noSig = { ...VALID_SIGNED_TASK };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (noSig as any).signature;

    vi.stubGlobal('fetch', makeFetchStub(noSig));

    await expect(
      fetchSignedTaskFromIpfs(
        'https://gateway.autonolas.tech',
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ),
    ).rejects.toThrow();
  });

  it('throws ZodError when schemaVersion is not task.v1', async () => {
    const wrongVersion = { ...VALID_SIGNED_TASK, schemaVersion: 'intent.v1' };

    vi.stubGlobal('fetch', makeFetchStub(wrongVersion));

    await expect(
      fetchSignedTaskFromIpfs(
        'https://gateway.autonolas.tech',
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ),
    ).rejects.toThrow();
  });

  it('throws when a retired top-level kind is present', async () => {
    const legacy = { ...VALID_SIGNED_TASK, kind: 'portfolio.v0' };

    vi.stubGlobal('fetch', makeFetchStub(legacy));

    await expect(
      fetchSignedTaskFromIpfs(
        'https://gateway.autonolas.tech',
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ),
    ).rejects.toThrow();
  });

  it('throws when retired spec.kind is present', async () => {
    const legacy = { ...VALID_SIGNED_TASK, spec: { kind: 'portfolio.v0' } };

    vi.stubGlobal('fetch', makeFetchStub(legacy));

    await expect(
      fetchSignedTaskFromIpfs(
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

// ── cidToDigestHex ────────────────────────────────────────────────────────────
//
// All CIDs below encode the same 32-byte digest — the SHA-256 of the empty string:
//   e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
//
// Derivation:
//   multihash = 0x12 0x20 <32 digest bytes>      (sha2-256, 32 bytes)
//   CIDv1 raw = 0x01 0x55 <multihash>            (version=1, codec=raw)
//
//   f-multibase hex : f01551220<digestHex>
//   base32 CIDv1    : bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku
//   base58btc CIDv1 : zb2rhmy65F3REf8SZp7De11gxtECBGgUKaLdiDj7MCGCHxbDW
//   CIDv0 (Qm)      : QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n

const KNOWN_DIGEST = '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const KNOWN_DIGEST_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('cidToDigestHex', () => {
  it('CIDv0 (Qm base58 multihash) returns 0x-prefixed 64-char digest', () => {
    const cid = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n';
    const result = cidToDigestHex(cid);
    expect(result).toBe(KNOWN_DIGEST);
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('CIDv1 base32 (b prefix) returns correct digest', () => {
    // bafkrei... = CIDv1 raw codec, sha2-256, base32 multibase
    const cid = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
    expect(cidToDigestHex(cid)).toBe(KNOWN_DIGEST);
  });

  it('CIDv1 base58btc (z prefix) returns correct digest', () => {
    const cid = 'zb2rhmy65F3REf8SZp7De11gxtECBGgUKaLdiDj7MCGCHxbDW';
    expect(cidToDigestHex(cid)).toBe(KNOWN_DIGEST);
  });

  it('CIDv1 f-multibase hex (lowercase f) extracts exact digest bytes', () => {
    const cid = `f01551220${KNOWN_DIGEST_HEX}`;
    expect(cidToDigestHex(cid)).toBe(KNOWN_DIGEST);
  });

  it('CIDv1 f-multibase hex (uppercase F) extracts exact digest bytes', () => {
    const cid = `F01551220${KNOWN_DIGEST_HEX.toUpperCase()}`;
    expect(cidToDigestHex(cid)).toBe(KNOWN_DIGEST);
  });

  it('truncated f-prefix CID (f01) throws with a length-shaped error', () => {
    // 'f01' decodes to version=0x01 with no remaining bytes for the multihash.
    // The length-precheck should fire before the multihash-fn check, so the
    // thrown error names the real failure (payload too short) instead of
    // rendering an "fn=0xundefined" message from reading undefined out of
    // an empty array.
    expect(() => cidToDigestHex('f01')).toThrow(/CID payload too short/);
  });

  it('malformed input (non-CID garbage string) throws', () => {
    // 'xnotacid' hits the else branch (base58Decode of 'notacid') and the resulting
    // bytes fail the multihash check (fn !== 0x12 || len !== 0x20).
    expect(() => cidToDigestHex('xnotacid')).toThrow();
  });
});

describe('rawSha256CidToDigestHex', () => {
  it.each([
    `f01551220${KNOWN_DIGEST_HEX}`,
    `F01551220${KNOWN_DIGEST_HEX.toUpperCase()}`,
    'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
  ])('accepts canonical CIDv1 raw sha2-256 form %s', (cid) => {
    expect(rawSha256CidToDigestHex(cid)).toBe(KNOWN_DIGEST);
  });

  it.each([
    'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n',
    'zb2rhmy65F3REf8SZp7De11gxtECBGgUKaLdiDj7MCGCHxbDW',
    `f01701220${KNOWN_DIGEST_HEX}`,
    'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvykv',
  ])('rejects noncanonical aliases or a non-raw codec: %s', (cid) => {
    expect(() => rawSha256CidToDigestHex(cid)).toThrow(/manifest CID/);
  });
});

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
