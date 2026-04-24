import { describe, it, expect, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';
import { emitTrajectory } from '../../src/trajectory/emit.js';
import { canonicalJson } from '../../src/restorer/engine/canonical-json.js';
import { JinnTrajectoryV1Schema } from '../../src/trajectory/schema.js';

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async (_url: string, data: unknown) => {
    // Deterministic stub CID derived from content
    const h = keccak256(toBytes(canonicalJson(data)));
    return `bafy-stub-${h.slice(2, 10)}`;
  }),
}));

describe('emitTrajectory', () => {
  it('returns a CID and sha256 of the signed blob, and the signed blob schema-validates', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy-intent', runId: 'run-1' });
    c.addSpan({
      name: 'phase.design',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });

    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const result = await emitTrajectory({
      collector: c,
      runId: 'run-1',
      signerPrivateKey: pk,
      signerAddress: account.address,
      ipfsRegistryUrl: 'http://stub',
    });

    expect(result.cid).toMatch(/^bafy-stub-/);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Signed blob must schema-validate
    expect(() => JinnTrajectoryV1Schema.parse(result.signed)).not.toThrow();
    // Signer matches
    expect(result.signed.signature.signer.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('signs keccak256(JCS(trajectory without signature))', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy-intent', runId: 'run-2' });
    c.addSpan({
      name: 'x',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'p' },
      events: [],
      status: { code: 'OK' },
    });
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const result = await emitTrajectory({
      collector: c,
      runId: 'run-2',
      signerPrivateKey: pk,
      signerAddress: account.address,
      ipfsRegistryUrl: 'http://stub',
    });
    const { signature: _s, ...unsigned } = result.signed;
    expect(result.signed.signature.hash).toBe(keccak256(toBytes(canonicalJson(unsigned))));
  });
});
