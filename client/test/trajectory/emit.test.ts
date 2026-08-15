import { describe, it, expect, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';
import { emitTrajectory } from '../../src/trajectory/emit.js';
import { ScrubPipeline } from '../../src/trajectory/scrub/pipeline.js';
import type { ScrubStage } from '../../src/trajectory/scrub/types.js';
import { uploadToIpfs } from '../../src/adapters/mech/ipfs.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
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
    const c = new TrajectoryCollector({ taskCid: 'bafy-task', runId: 'run-1' });
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
    const c = new TrajectoryCollector({ taskCid: 'bafy-task', runId: 'run-2' });
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

  it('scrubs identity, local paths, and credential-looking values before signing and pinning', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy-task', runId: 'run-scrub' });
    c.addSpan({
      name: 'artifact.emit',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {
        'jinn.span.kind': 'jinn.artifact.emit',
        message: 'adriano wrote /Users/adriano/repo/src/index.ts with Bearer sk-ant-oat01-abcdefghijklmnop',
        token: 'secret-value',
      },
      events: [{
        timeUnixNano: '2',
        name: 'stdout',
        attributes: {
          line: 'cwd=/Users/adriano/.jinn-client on devbox',
        },
      }],
      status: { code: 'OK' },
    });

    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const result = await emitTrajectory({
      collector: c,
      runId: 'run-scrub',
      signerPrivateKey: pk,
      signerAddress: account.address,
      ipfsRegistryUrl: 'http://stub',
      scrub: {
        identity: { username: 'adriano', hostname: 'devbox' },
        path: { home: '/Users/adriano', repoRoot: '/Users/adriano/repo' },
      },
    });

    const serialized = JSON.stringify(result.signed);
    expect(serialized).not.toContain('adriano');
    expect(serialized).not.toContain('devbox');
    expect(serialized).not.toContain('/Users/adriano');
    expect(serialized).not.toContain('sk-ant-oat01');
    expect(serialized).not.toContain('secret-value');
    expect(result.signed.spans[0]!.attributes.message).toContain('<USER>');
    expect(result.signed.spans[0]!.attributes.message).toContain('src/index.ts');
    expect(result.signed.spans[0]!.attributes.message).toContain('<REDACTED>');
    expect(result.signed.redactionManifest.totalRedactions).toBeGreaterThan(0);
    expect(() => JinnTrajectoryV1Schema.parse(result.signed)).not.toThrow();
  });

  // B1 (task-trajectory path): a scrub-stage throw — e.g. the fail-closed ML PII
  // stage when the model failed to load — must abort emit BEFORE the trajectory
  // is uploaded to IPFS. scrubSpansForEmit runs ahead of uploadToIpfs, so the
  // throw propagates and nothing is pinned (fail closed; the engine then leaves
  // envelope.trajectory = null). This proves no raw trajectory leaks to IPFS.
  it('fails closed: a throwing scrub stage aborts emit before any IPFS upload', async () => {
    vi.mocked(uploadToIpfs).mockClear();
    const c = new TrajectoryCollector({ taskCid: 'bafy-task', runId: 'run-fc' });
    c.addSpan({
      name: 'tool',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'tool', 'tool.output': 'raw content that must not be pinned' },
      events: [],
      status: { code: 'OK' },
    });

    const throwingStage: ScrubStage = {
      name: 'ml-pii',
      version: '0.1.0',
      scrub() {
        return Promise.reject(new Error('failing closed — this trajectory is NOT published'));
      },
    };

    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    await expect(
      emitTrajectory({
        collector: c,
        runId: 'run-fc',
        signerPrivateKey: pk,
        signerAddress: account.address,
        ipfsRegistryUrl: 'http://stub',
        scrubPipeline: new ScrubPipeline([throwingStage]),
      }),
    ).rejects.toThrow(/failing closed|NOT published/i);
    // The load-bearing assertion: nothing was uploaded to IPFS.
    expect(vi.mocked(uploadToIpfs)).not.toHaveBeenCalled();
  });
});
