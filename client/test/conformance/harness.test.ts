/**
 * Integration tests for the conformance harness.
 *
 * Tests:
 *   1. Good self-signed envelope → PASS, layer2 = 'N/A'.
 *   2. Tampered schemaVersion → FAIL, envelope.schema failing.
 *   3. Tampered generatedAt (hash stale) → FAIL, envelope.hash-signature failing.
 *   4. Good verdict envelope → PASS, verdict checks present.
 *
 * All tests inject pre-loaded objects via ConformanceOptions to avoid IPFS.
 */

import { describe, it, expect, vi } from 'vitest';
import { runConformance } from '../../src/conformance/harness.js';

// Mock IPFS so fixture builders and harness don't make real network calls.
// The fixture builders call assembleAndSignEnvelope → uploadToIpfs; tests
// inject pre-built objects via ConformanceOptions so fetchSignedEnvelopeBytesRaw
// is never reached either. This mirrors the pattern in all check-level tests.
vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => 'bafy-mock-cid'),
  normalizeIpfsRegistryAddUrl: vi.fn((url: string) => url),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000'),
  digestHexToGatewayUrl: vi.fn((hex: string) => `https://gateway.autonolas.tech/ipfs/${hex}`),
  fetchFromIpfs: vi.fn(),
  fetchSignedEnvelopeBytesRaw: vi.fn(),
  fetchSignedEnvelopeFromIpfs: vi.fn(),
}));
import {
  buildGoodRestorationFixture,
  buildGoodVerdictFixture,
} from './fixtures/good-envelope.js';
import { buildGoodTrajectoryFixture } from './fixtures/good-trajectory.js';

// ─── Pass case ────────────────────────────────────────────────────────────────

describe('runConformance — pass case', () => {
  it('returns PASS + layer1Passed + layer2=N/A for a good self-signed solution envelope', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);

    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: fx.envelopeBytes,
        task: fx.task,
        trajectory: traj,
      },
    });

    expect(report.overall).toBe('PASS');
    expect(report.layer1Passed).toBe(true);
    expect(report.layer2Passed).toBe('N/A');
    expect(report.summary.failed).toBe(0);
    expect(report.envelopeCid).toBe(fx.envelopeCid);
    expect(report.envelopeTier).toBe('self-signed');
    // All Layer 1 checks must be present
    const ids = report.checks.map((c) => c.id);
    expect(ids).toContain('envelope.schema');
    expect(ids).toContain('envelope.payload');
    expect(ids).toContain('envelope.hash-signature');
    expect(ids).toContain('trajectory.schema');
    expect(ids).toContain('trajectory.hash-chain');
    expect(ids).toContain('trajectory.span-profile');
    expect(ids).toContain('artifacts.vocabulary');
    expect(ids).toContain('artifacts.linkage');
  });

  it('returns PASS for a good verdict envelope with solution bytes', async () => {
    const vfx = await buildGoodVerdictFixture();

    const report = await runConformance({
      envelopeCid: vfx.envelopeCid,
      options: {
        envelopeBytes: vfx.envelopeBytes,
        solutionEnvelopeBytes: vfx.solutionEnvelopeBytes,
      },
    });

    expect(report.overall).toBe('PASS');
    expect(report.layer1Passed).toBe(true);
    // Verdict checks must appear
    const ids = report.checks.map((c) => c.id);
    expect(ids).toContain('verdict.back-ref');
    expect(ids).toContain('verdict.verification-record');
  });
});

// ─── Known-bad matrix ─────────────────────────────────────────────────────────

describe('runConformance — known-bad matrix', () => {
  it('FAIL: wrong schemaVersion → envelope.schema fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, schemaVersion: 'jinn.execution.v99' as unknown as 'jinn.execution.v1' };
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(bad)),
        task: fx.task,
      },
    });
    expect(report.overall).toBe('FAIL');
    const schemaCheck = report.checks.find((c) => c.id === 'envelope.schema');
    expect(schemaCheck?.passed).toBe(false);
    expect(schemaCheck?.detail).toMatch(/schemaVersion/i);
  });

  it('FAIL: bogus payload → envelope.payload fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, payload: { garbage: 1 } };
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(bad)),
        task: fx.task,
      },
    });
    expect(report.overall).toBe('FAIL');
    const payloadCheck = report.checks.find((c) => c.id === 'envelope.payload');
    expect(payloadCheck?.passed).toBe(false);
  });

  it('FAIL: generatedAt tampered → envelope.hash-signature fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, generatedAt: fx.envelope.generatedAt + 1 };
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(bad)),
        task: fx.task,
        trajectory: traj,
      },
    });
    expect(report.overall).toBe('FAIL');
    const hashCheck = report.checks.find((c) => c.id === 'envelope.hash-signature');
    expect(hashCheck?.passed).toBe(false);
    expect(hashCheck?.detail).toMatch(/hash/i);
  });

  it('FAIL: signer replaced → envelope.hash-signature fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = {
      ...fx.envelope,
      signature: {
        ...fx.envelope.signature,
        signer: ('0xdead' + '0'.repeat(36)) as `0x${string}`,
      },
    };
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(bad)),
        task: fx.task,
      },
    });
    expect(report.overall).toBe('FAIL');
    const sigCheck = report.checks.find((c) => c.id === 'envelope.hash-signature');
    expect(sigCheck?.passed).toBe(false);
  });

  it('FAIL: hash-chain corrupted → trajectory.hash-chain fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    // Corrupt span[2]'s prevSpanHash
    traj.spans[2].attributes['jinn.prevSpanHash'] = '0x' + 'de'.repeat(32);
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: fx.envelopeBytes,
        task: fx.task,
        trajectory: traj,
      },
    });
    expect(report.overall).toBe('FAIL');
    const chainCheck = report.checks.find((c) => c.id === 'trajectory.hash-chain');
    expect(chainCheck?.passed).toBe(false);
    expect(chainCheck?.detail).toMatch(/span\[2\]/);
  });

  it('FAIL: span profile violated → trajectory.span-profile fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    // Remove required attribute from llm_call span
    const llmSpan = traj.spans.find(
      (s) => s.attributes['jinn.span.kind'] === 'jinn.llm_call',
    );
    delete llmSpan!.attributes['gen_ai.system'];
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: fx.envelopeBytes,
        task: fx.task,
        trajectory: traj,
      },
    });
    expect(report.overall).toBe('FAIL');
    const profCheck = report.checks.find((c) => c.id === 'trajectory.span-profile');
    expect(profCheck?.passed).toBe(false);
    expect(profCheck?.detail).toMatch(/gen_ai\.system/);
  });

  it('FAIL: artifact type vocabulary missing → artifacts.vocabulary fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    // Remove output.portfolio.v0 artifact
    const badArtifacts = fx.envelope.artifacts.filter(
      (a) => !a.artifactType.startsWith('output.'),
    );
    const bad = { ...fx.envelope, artifacts: badArtifacts };
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(bad)),
        task: fx.task,
        trajectory: traj,
      },
    });
    expect(report.overall).toBe('FAIL');
    const vocabCheck = report.checks.find((c) => c.id === 'artifacts.vocabulary');
    expect(vocabCheck?.passed).toBe(false);
    expect(vocabCheck?.detail).toMatch(/output\.portfolio\.v0/);
  });

  it('FAIL: artifact linkage broken → artifacts.linkage fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    // Corrupt the emit span's jinn.artifact.sha256 (linkage is sha256-keyed
    // post jinn-mono-vy37.1.2 — artifacts no longer carry IPFS CIDs).
    const emitSpan = traj.spans.find(
      (s) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit',
    );
    const orphanSha = '8'.repeat(64);
    emitSpan!.attributes['jinn.artifact.sha256'] = orphanSha;
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: fx.envelopeBytes,
        task: fx.task,
        trajectory: traj,
      },
    });
    expect(report.overall).toBe('FAIL');
    const linkageCheck = report.checks.find((c) => c.id === 'artifacts.linkage');
    expect(linkageCheck?.passed).toBe(false);
    expect(linkageCheck?.detail).toMatch(new RegExp(orphanSha));
  });

  it('FAIL: verdict sha256 mismatch → verdict.back-ref fails', async () => {
    const vfx = await buildGoodVerdictFixture();
    const tampered = new Uint8Array([...vfx.solutionEnvelopeBytes, 0x00]);
    const report = await runConformance({
      envelopeCid: vfx.envelopeCid,
      options: {
        envelopeBytes: vfx.envelopeBytes,
        solutionEnvelopeBytes: tampered,
      },
    });
    expect(report.overall).toBe('FAIL');
    const backRefCheck = report.checks.find((c) => c.id === 'verdict.back-ref');
    expect(backRefCheck?.passed).toBe(false);
    expect(backRefCheck?.detail).toMatch(/sha256/i);
  });

  it('FAIL: verdict verificationOfRestoration has empty checks[] → verdict.verification-record fails', async () => {
    const vfx = await buildGoodVerdictFixture();
    const badPayload = {
      ...(vfx.envelope.payload as Record<string, unknown>),
      verificationOfRestoration: {
        claimedTier: 'self-signed',
        sdkVersion: '1.0.0',
        timestamp: 1700000000000,
        checks: [], // empty — should fail
        overall: 'valid',
      },
    };
    const badEnvelope = { ...vfx.envelope, payload: badPayload };
    const report = await runConformance({
      envelopeCid: vfx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(badEnvelope)),
        solutionEnvelopeBytes: vfx.solutionEnvelopeBytes,
      },
    });
    expect(report.overall).toBe('FAIL');
    const verCheck = report.checks.find((c) => c.id === 'verdict.verification-record');
    expect(verCheck?.passed).toBe(false);
    expect(verCheck?.detail).toMatch(/checks/i);
  });

  it('FAIL: raw credential in trajectory → secret-scrub fails', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.task.cid);
    // Inject a Bearer token into a span attribute
    traj.spans[0].attributes['http.request.header.authorization'] =
      'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: fx.envelopeBytes,
        task: fx.task,
        trajectory: traj,
      },
    });
    expect(report.overall).toBe('FAIL');
    const scrubCheck = report.checks.find((c) => c.id === 'secret-scrub.compliance');
    expect(scrubCheck?.passed).toBe(false);
    expect(scrubCheck?.detail).toMatch(/authorization/i);
  });
});

// ─── Layer 2 attested-tier check ─────────────────────────────────────────────

describe('runConformance — Layer 2 (attested tier)', () => {
  it('runs Layer 2 checks when tier=attested and source bundle is provided', async () => {
    const fx = await buildGoodRestorationFixture();
    // Build an attested-tier envelope (override the evidenceTier field)
    const attestedEnvelope = { ...fx.envelope, evidenceTier: 'attested' as const };

    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(attestedEnvelope)),
        task: fx.task,
        sourceBundle: {
          files: new Map([['src/index.ts', 'console.log("hello");']]),
        },
      },
    });

    // Layer 2 checks appear
    expect(report.checks.some((c) => c.layer === 2)).toBe(true);
    expect(report.layer2Passed).not.toBe('N/A');
    // Static checks should pass (no violations in the stub source bundle)
    const staticChecks = report.checks.filter((c) => c.layer === 2 && !c.skipped);
    expect(staticChecks.every((c) => c.passed)).toBe(true);
  });

  it('layer2Passed = "N/A" when tier=self-signed', async () => {
    const fx = await buildGoodRestorationFixture();
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: fx.envelopeBytes,
        task: fx.task,
      },
    });
    expect(report.layer2Passed).toBe('N/A');
    expect(report.checks.every((c) => c.layer === 1)).toBe(true);
  });
});
