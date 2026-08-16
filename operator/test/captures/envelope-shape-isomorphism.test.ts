import { describe, expect, it } from 'vitest';
import { buildUnsignedCaptureEnvelope } from '../../src/captures/publish.js';
import { EMPTY_BUNDLE_SHA256 } from '../../src/trajectory/schema.js';

const executor = {
  implName: 'claude-code-learner',
  implVersion: '1.0.0',
  clientGitSha: 'abc1234',
  codeDigest: `sha256:${'a'.repeat(64)}`,
  runtimeBundleDigest: `sha256:${'b'.repeat(64)}`,
  plugins: [],
  signingKey: { kind: 'agent-eoa' as const, pubkey: `0x${'1'.repeat(40)}` },
  mode: 'train' as const,
};

describe('capture vs solver envelope isomorphism', () => {
  it('captures and solver Solutions have the same executor shape', () => {
    const capture = buildUnsignedCaptureEnvelope({
      capture: {
        sessionId: 'sess-1',
        capturedAt: '2026-05-08T00:00:00.000Z',
        originatingTool: { name: 'claude-code-learner', version: '1.0.0' },
        capturePath: 'A',
        status: 'pending',
        spanCount: 0,
        durationMs: 0,
        redactedSpanCount: 0,
      },
      now: new Date('2026-05-08T00:00:00.000Z'),
      participant: { safeAddress: `0x${'2'.repeat(40)}`, agentEoa: `0x${'1'.repeat(40)}` },
      signerAddress: `0x${'1'.repeat(40)}`,
      clientGitSha: 'abc1234',
      trajectory: { cid: 'bafytraj', sha256: 'c'.repeat(64), endpoint: 'https://example.com/t', priceUsdc: '0' },
      artifacts: [],
      harnessBundleSha: EMPTY_BUNDLE_SHA256,
      executorOverrides: executor,
    });
    const solution = {
      role: 'restoration',
      task: { cid: 'bafytask' },
      executor,
    };

    expect(Object.keys(capture.executor).sort()).toEqual(Object.keys(solution.executor).sort());
    expect(typeof capture.executor.codeDigest).toBe(typeof solution.executor.codeDigest);
    expect(typeof capture.executor.runtimeBundleDigest).toBe(typeof solution.executor.runtimeBundleDigest);
    expect(Array.isArray(capture.executor.plugins)).toBe(true);
    expect(Array.isArray(solution.executor.plugins)).toBe(true);
  });

  it('only legitimate differences are role + provenance swap', () => {
    const capture = buildUnsignedCaptureEnvelope({
      capture: {
        sessionId: 'sess-1',
        capturedAt: '2026-05-08T00:00:00.000Z',
        originatingTool: { name: 'claude-code-learner' },
        capturePath: 'A',
        status: 'pending',
        spanCount: 0,
        durationMs: 0,
        redactedSpanCount: 0,
      },
      now: new Date('2026-05-08T00:00:00.000Z'),
      participant: { safeAddress: `0x${'2'.repeat(40)}`, agentEoa: `0x${'1'.repeat(40)}` },
      signerAddress: `0x${'1'.repeat(40)}`,
      clientGitSha: 'abc1234',
      trajectory: { cid: 'bafytraj', sha256: 'c'.repeat(64), endpoint: 'https://example.com/t', priceUsdc: '0' },
      artifacts: [],
      harnessBundleSha: EMPTY_BUNDLE_SHA256,
    });
    expect(capture.role).toBe('capture');
    expect(capture.task).toBeUndefined();
    expect(capture.sessionProvenance).toBeDefined();
  });
});
