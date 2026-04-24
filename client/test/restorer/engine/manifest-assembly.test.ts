import { describe, it, expect, vi } from 'vitest';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '../../../src/restorer/engine/canonical-json.js';

// ── Mock IPFS upload ──────────────────────────────────────────────────────────

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymanifest123'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000'),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('assembleAndSignManifest', () => {
  // Use a deterministic test private key
  const testPrivKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
  const account = privateKeyToAccount(testPrivKey);

  function makeProvenance() {
    return {
      intentCid: 'bafyintent123',
      onchainCreationTx: '0xdeadbeef' as `0x${string}`,
      onchainCreationBlock: 100,
      requestId: '0xreq001' as `0x${string}`,
      safeAddress: account.address,
      agentEoa: account.address,
      windowStartTs: 1000,
      windowEndTs: 87401000,
    };
  }

  function makeImplOutput() {
    return {
      preSnapshot: { capturedAt: 1000, hlTime: 100, payload: { equity: '1000' } },
      postSnapshot: { capturedAt: 87401000, hlTime: 200, payload: { equity: '1100' } },
      fills: [{ tid: 1, px: '1.0', sz: '10', side: 'B' }],
      gating: { equityReturnPct: '10.0', maxDrawdownPct: '5.0', closedTradesCount: 25, tradedNotionalMultiple: '8.5' },
      informational: { sharpe: '1.5' },
    };
  }

  it('produces a manifest with the correct schemaVersion', async () => {
    const { assembleAndSignManifest } = await import('../../../src/restorer/engine/manifest-assembly.js');
    const result = await assembleAndSignManifest(
      makeProvenance(),
      makeImplOutput(),
      [],
      { ipfsRegistryUrl: 'http://ipfs.test', agentEoaPrivateKey: testPrivKey },
    );
    expect(result.manifest.schemaVersion).toBe('portfolio.v0.manifest.v1');
  });

  it('populates intent provenance fields', async () => {
    const { assembleAndSignManifest } = await import('../../../src/restorer/engine/manifest-assembly.js');
    const provenance = makeProvenance();
    const result = await assembleAndSignManifest(
      provenance,
      makeImplOutput(),
      [],
      { ipfsRegistryUrl: 'http://ipfs.test', agentEoaPrivateKey: testPrivKey },
    );
    const intent = result.manifest.intent as Record<string, unknown>;
    expect(intent.cid).toBe('bafyintent123');
    expect(intent.onchainCreationBlock).toBe(100);
  });

  it('populates restorer fields', async () => {
    const { assembleAndSignManifest } = await import('../../../src/restorer/engine/manifest-assembly.js');
    const result = await assembleAndSignManifest(
      makeProvenance(),
      makeImplOutput(),
      [],
      { ipfsRegistryUrl: 'http://ipfs.test', agentEoaPrivateKey: testPrivKey },
    );
    const restorer = result.manifest.restorer as Record<string, unknown>;
    expect(restorer.agentEoa).toBe(account.address);
  });

  it('includes artifacts array', async () => {
    const { assembleAndSignManifest } = await import('../../../src/restorer/engine/manifest-assembly.js');
    const artifacts = [
      { cid: 'bafyart1', artifactType: 'session_transcript', sha256: 'abc123', access: { kind: 'open' as const } },
    ];
    const result = await assembleAndSignManifest(
      makeProvenance(),
      makeImplOutput(),
      artifacts,
      { ipfsRegistryUrl: 'http://ipfs.test', agentEoaPrivateKey: testPrivKey },
    );
    expect((result.manifest.artifacts as unknown[]).length).toBe(1);
  });

  it('includes a signature field with secp256k1 algo', async () => {
    const { assembleAndSignManifest } = await import('../../../src/restorer/engine/manifest-assembly.js');
    const result = await assembleAndSignManifest(
      makeProvenance(),
      makeImplOutput(),
      [],
      { ipfsRegistryUrl: 'http://ipfs.test', agentEoaPrivateKey: testPrivKey },
    );
    const sig = result.manifest.signature as Record<string, unknown>;
    expect(sig.algo).toBe('secp256k1');
    expect(sig.signer).toBe(account.address);
    expect(typeof sig.hash).toBe('string');
    expect((sig.hash as string).startsWith('0x')).toBe(true);
    expect(typeof sig.sig).toBe('string');
  });

  it('signatureHash matches keccak256 of canonical JSON of unsigned manifest', async () => {
    const { assembleAndSignManifest } = await import('../../../src/restorer/engine/manifest-assembly.js');
    const result = await assembleAndSignManifest(
      makeProvenance(),
      makeImplOutput(),
      [],
      { ipfsRegistryUrl: 'http://ipfs.test', agentEoaPrivateKey: testPrivKey },
    );
    const { signature: _sig, ...unsigned } = result.manifest;
    const canonicalStr = canonicalJson(unsigned);
    const canonicalBytes = new TextEncoder().encode(canonicalStr);
    const expectedHash = keccak256(canonicalBytes);
    expect(result.signatureHash).toBe(expectedHash);
  });

  it('uploads to IPFS and returns a manifestCid', async () => {
    const { assembleAndSignManifest } = await import('../../../src/restorer/engine/manifest-assembly.js');
    const result = await assembleAndSignManifest(
      makeProvenance(),
      makeImplOutput(),
      [],
      { ipfsRegistryUrl: 'http://ipfs.test', agentEoaPrivateKey: testPrivKey },
    );
    expect(result.manifestCid).toBe('bafymanifest123');
  });

  it('omits optional fields when not provided', async () => {
    const { assembleAndSignManifest } = await import('../../../src/restorer/engine/manifest-assembly.js');
    const implOutput = makeImplOutput();
    // No informational, no rationale
    const { informational: _, ...outputNoInfo } = implOutput;
    const result = await assembleAndSignManifest(
      makeProvenance(),
      outputNoInfo,
      [],
      { ipfsRegistryUrl: 'http://ipfs.test', agentEoaPrivateKey: testPrivKey },
    );
    expect(result.manifest).not.toHaveProperty('rationale');
  });
});
