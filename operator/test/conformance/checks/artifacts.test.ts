import { describe, it, expect, vi } from 'vitest';
import { checkArtifactVocabulary, checkArtifactLinkage } from '../../../src/conformance/checks/artifacts.js';
import type { ConformanceContext } from '../../../src/conformance/types.js';
import {
  buildGoodRestorationFixture,
} from '../fixtures/good-envelope.js';
import {
  buildGoodTrajectoryFixture,
  FIXTURE_ARTIFACT_CID,
  FIXTURE_EMIT_SPAN_ID,
} from '../fixtures/good-trajectory.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => 'bafy-mock-cid'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000'),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// ─── checkArtifactVocabulary ──────────────────────────────────────────────────

describe('checkArtifactVocabulary', () => {
  it('passes when all required artifact types are present', async () => {
    const fx = await buildGoodRestorationFixture();
    const ctx: ConformanceContext = {
      envelope: fx.envelope,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactVocabulary(ctx);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('artifacts.vocabulary');
    expect(result.layer).toBe(1);
  });

  it('fails when output.<kind> is missing', async () => {
    const fx = await buildGoodRestorationFixture();
    const env = {
      ...fx.envelope,
      artifacts: fx.envelope.artifacts.filter((a) => !a.artifactType.startsWith('output.')),
    };
    const ctx: ConformanceContext = {
      envelope: env,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactVocabulary(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/output\.portfolio\.v0/);
  });

  it('fails when system_snapshot is missing', async () => {
    const fx = await buildGoodRestorationFixture();
    const env = {
      ...fx.envelope,
      artifacts: fx.envelope.artifacts.filter((a) => a.artifactType !== 'system_snapshot'),
    };
    const ctx: ConformanceContext = {
      envelope: env,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactVocabulary(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/system_snapshot/);
  });

  it('fails when trajectory artifact is missing but envelope.trajectory is set', async () => {
    const fx = await buildGoodRestorationFixture();
    const env = {
      ...fx.envelope,
      artifacts: fx.envelope.artifacts.filter((a) => a.artifactType !== 'trajectory'),
    };
    const ctx: ConformanceContext = {
      envelope: env,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactVocabulary(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/trajectory/);
  });

  it('passes with custom artifactType (vocabulary is extensible)', async () => {
    const fx = await buildGoodRestorationFixture();
    const env = {
      ...fx.envelope,
      artifacts: [
        ...fx.envelope.artifacts,
        { cid: 'bafy-custom', artifactType: 'custom.operator-specific' },
      ],
    };
    const ctx: ConformanceContext = {
      envelope: env as any,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactVocabulary(ctx);
    expect(result.passed).toBe(true);
  });

  it('skips on verdict-role envelopes', async () => {
    const fx = await buildGoodRestorationFixture();
    const env = { ...fx.envelope, role: 'verdict' as const };
    const ctx: ConformanceContext = {
      envelope: env as any,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactVocabulary(ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails when envelope is not loaded', () => {
    const ctx: ConformanceContext = { envelopeCid: 'bafy-test', options: {} };
    const result = checkArtifactVocabulary(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/not loaded/);
  });
});

// ─── checkArtifactLinkage ─────────────────────────────────────────────────────

describe('checkArtifactLinkage', () => {
  it('passes when all artifacts and spans are correctly linked', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    const ctx: ConformanceContext = {
      envelope: fx.envelope,
      trajectory: traj as unknown,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactLinkage(ctx);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('artifacts.linkage');
  });

  it('skips when no trajectory is present', async () => {
    const fx = await buildGoodRestorationFixture();
    const ctx: ConformanceContext = {
      envelope: fx.envelope,
      trajectory: null as unknown,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactLinkage(ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails when an artifact.producedBy.spanId points to nonexistent span', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    const env = {
      ...fx.envelope,
      artifacts: [
        ...fx.envelope.artifacts,
        {
          sha256: '0'.repeat(64),
          artifactType: 'runtime_log',
          metadata: {
            producedBy: { spanId: 'nonexistent-span-id', trajectoryCid: 'bafy-traj' },
          },
        },
      ],
    };
    const ctx: ConformanceContext = {
      envelope: env as any,
      trajectory: traj as unknown,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactLinkage(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/nonexistent/);
  });

  it('fails when a jinn.artifact.emit span references a sha256 not in envelope.artifacts', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    // Corrupt the emit span's sha256 to one not in envelope.artifacts
    const emitSpan = traj.spans.find(
      (s) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit',
    );
    expect(emitSpan).toBeDefined();
    const orphanSha = '9'.repeat(64);
    emitSpan!.attributes['jinn.artifact.sha256'] = orphanSha;
    const ctx: ConformanceContext = {
      envelope: fx.envelope,
      trajectory: traj as unknown,
      envelopeCid: fx.envelopeCid,
      options: {},
    };
    const result = checkArtifactLinkage(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(new RegExp(orphanSha));
  });

  it('fails when envelope is not loaded', () => {
    const ctx: ConformanceContext = { envelopeCid: 'bafy-test', options: {} };
    const result = checkArtifactLinkage(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/not loaded/);
  });
});
