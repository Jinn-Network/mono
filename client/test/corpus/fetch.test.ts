import { describe, it, expect, vi } from 'vitest';
import { fetchManifest } from '../../src/corpus/fetch.js';

const sampleEnvelope = {
  schemaVersion: 'jinn.execution.v1',
  solverType: 'prediction.v0',
  role: 'solution',
  generatedAt: 1745978400,
  task: { cid: 'bafyIntent', onchainCreationTx: '0x' + 'a'.repeat(64), onchainCreationBlock: 1, requestId: '0x' + 'b'.repeat(64) },
  participant: { safeAddress: '0x' + '1'.repeat(40), agentEoa: '0x' + '2'.repeat(40) },
  window: { startTs: 0, endTs: 1000 },
  executor: { implName: 'test', implVersion: '0.1.0', clientGitSha: 'abc', codeDigest: 'sha256:' + 'c'.repeat(64), runtimeBundleDigest: 'sha256:' + 'd'.repeat(64), plugins: [], signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) } },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: {},
  signature: { algo: 'secp256k1', signer: '0x' + '2'.repeat(40), hash: '0x' + 'e'.repeat(64), sig: '0x' + 'f'.repeat(130) },
};

describe('fetchManifest', () => {
  it('returns ManifestPreview on success', async () => {
    const ref = {
      manifestCid: 'bafyManifest1',
      manifestHash: '0x' + 'a'.repeat(64),
      operator: { agentId: '1', safeAddress: '0x' + '3'.repeat(40) },
      evidenceTier: 'self-signed' as const,
      publishedAt: 1745978400,
    };
    const fetchFromIpfsMock = vi.fn(async () => sampleEnvelope);
    const preview = await fetchManifest(ref, 'https://gateway.example.com', fetchFromIpfsMock);
    expect(preview.ref).toEqual(ref);
    expect(preview.envelope.solverType).toBe('prediction.v0');
  });

  it('throws ManifestFetchError on parse failure', async () => {
    const ref = {
      manifestCid: 'bafyBad',
      manifestHash: '0x' + 'a'.repeat(64),
      operator: { agentId: '1', safeAddress: '0x' + '3'.repeat(40) },
      evidenceTier: 'self-signed' as const,
      publishedAt: 1745978400,
    };
    const fetchFromIpfsMock = vi.fn(async () => ({ not: 'an envelope' }));
    await expect(
      fetchManifest(ref, 'https://gateway.example.com', fetchFromIpfsMock),
    ).rejects.toThrow(/ManifestFetchError|schema/);
  });
});
