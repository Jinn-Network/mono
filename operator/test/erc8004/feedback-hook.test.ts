import { describe, it, expect, vi } from 'vitest';
import type { ReputationRegistryClient } from '../../src/erc8004/reputation.js';

const RESTORER_AGENT_ID = 1234n;
const MANIFEST_CID = 'bafyharness123';
const EVIDENCE_HASH =
  '0xfeedfacedeadbeef00000000000000000000000000000000000000000000beef' as `0x${string}`;

function makeRegistry(
  giveFeedbackImpl: (...args: unknown[]) => Promise<`0x${string}`> = async () =>
    '0xtx-hash' as `0x${string}`,
): ReputationRegistryClient {
  return {
    giveFeedback: vi.fn(giveFeedbackImpl),
    revokeFeedback: vi.fn(),
    respondToFeedback: vi.fn(),
    readFeedback: vi.fn(),
    readAllFeedback: vi.fn(),
    getSummary: vi.fn(),
    getClients: vi.fn(),
    getLastIndex: vi.fn(),
  } as unknown as ReputationRegistryClient;
}

describe('mapVerdictToScore (policy)', () => {
  it('PASS → 100/2 (= 1.00)', async () => {
    const { mapVerdictToScore } = await import('../../src/erc8004/reputation.js');
    expect(mapVerdictToScore('PASS')).toEqual({ score: 100, scoreDecimals: 2 });
  });

  it('FAIL → 0/2 (= 0.00)', async () => {
    const { mapVerdictToScore } = await import('../../src/erc8004/reputation.js');
    expect(mapVerdictToScore('FAIL')).toEqual({ score: 0, scoreDecimals: 2 });
  });

  it('REJECTED → null (no on-chain feedback)', async () => {
    const { mapVerdictToScore } = await import('../../src/erc8004/reputation.js');
    expect(mapVerdictToScore('REJECTED')).toBeNull();
  });

  it('INDETERMINATE → null (no on-chain feedback)', async () => {
    const { mapVerdictToScore } = await import('../../src/erc8004/reputation.js');
    expect(mapVerdictToScore('INDETERMINATE')).toBeNull();
  });
});

describe('submitEvaluatorFeedback', () => {
  it('submits feedback with manifest:<cid> URI + evidenceHash for PASS', async () => {
    const { submitEvaluatorFeedback } = await import('../../src/erc8004/reputation.js');
    const registry = makeRegistry();

    const outcome = await submitEvaluatorFeedback({
      registry,
      ref: {
        harnessAgentId: RESTORER_AGENT_ID,
        harnessManifestCid: MANIFEST_CID,
        harnessEvidenceHash: EVIDENCE_HASH,
      },
      verdict: { verdict: 'PASS', solverType: 'portfolio.v0' },
    });

    expect(outcome).toEqual({ kind: 'submitted', txHash: '0xtx-hash' });
    expect(registry.giveFeedback).toHaveBeenCalledOnce();
    expect(registry.giveFeedback).toHaveBeenCalledWith({
      harnessAgentId: RESTORER_AGENT_ID,
      score: 100,
      scoreDecimals: 2,
      manifestRef: `manifest:${MANIFEST_CID}`,
      manifestHash: EVIDENCE_HASH,
      tag1: 'portfolio.v0',
    });
  });

  it('submits 0-score feedback for FAIL', async () => {
    const { submitEvaluatorFeedback } = await import('../../src/erc8004/reputation.js');
    const registry = makeRegistry();
    const outcome = await submitEvaluatorFeedback({
      registry,
      ref: {
        harnessAgentId: RESTORER_AGENT_ID,
        harnessManifestCid: MANIFEST_CID,
        harnessEvidenceHash: EVIDENCE_HASH,
      },
      verdict: { verdict: 'FAIL', solverType: 'portfolio.v0' },
    });
    expect(outcome.kind).toBe('submitted');
    expect(registry.giveFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ score: 0, scoreDecimals: 2 }),
    );
  });

  it('skips feedback for REJECTED (eligibility miss, not quality)', async () => {
    const { submitEvaluatorFeedback } = await import('../../src/erc8004/reputation.js');
    const registry = makeRegistry();
    const outcome = await submitEvaluatorFeedback({
      registry,
      ref: {
        harnessAgentId: RESTORER_AGENT_ID,
        harnessManifestCid: MANIFEST_CID,
        harnessEvidenceHash: EVIDENCE_HASH,
      },
      verdict: { verdict: 'REJECTED' },
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'verdict-not-eligible' });
    expect(registry.giveFeedback).not.toHaveBeenCalled();
  });

  it('skips feedback for INDETERMINATE (evaluator could not rederive)', async () => {
    const { submitEvaluatorFeedback } = await import('../../src/erc8004/reputation.js');
    const registry = makeRegistry();
    const outcome = await submitEvaluatorFeedback({
      registry,
      ref: {
        harnessAgentId: RESTORER_AGENT_ID,
        harnessManifestCid: MANIFEST_CID,
        harnessEvidenceHash: EVIDENCE_HASH,
      },
      verdict: { verdict: 'INDETERMINATE' },
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'verdict-not-eligible' });
    expect(registry.giveFeedback).not.toHaveBeenCalled();
  });

  it('catches "Self-feedback not allowed" revert and returns skipped', async () => {
    const { submitEvaluatorFeedback } = await import('../../src/erc8004/reputation.js');
    const registry = makeRegistry(() => {
      throw new Error('execution reverted: Self-feedback not allowed');
    });
    const outcome = await submitEvaluatorFeedback({
      registry,
      ref: {
        harnessAgentId: RESTORER_AGENT_ID,
        harnessManifestCid: MANIFEST_CID,
        harnessEvidenceHash: EVIDENCE_HASH,
      },
      verdict: { verdict: 'PASS' },
      log: () => {},
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'self-feedback' });
  });

  it('catches ERC721NonexistentToken revert and returns skipped', async () => {
    const { submitEvaluatorFeedback } = await import('../../src/erc8004/reputation.js');
    const registry = makeRegistry(() => {
      throw new Error('ERC721NonexistentToken(1234)');
    });
    const outcome = await submitEvaluatorFeedback({
      registry,
      ref: {
        harnessAgentId: RESTORER_AGENT_ID,
        harnessManifestCid: MANIFEST_CID,
        harnessEvidenceHash: EVIDENCE_HASH,
      },
      verdict: { verdict: 'PASS' },
      log: () => {},
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'agent-not-found' });
  });

  it('catches arbitrary errors as failed (non-fatal — caller logs)', async () => {
    const { submitEvaluatorFeedback } = await import('../../src/erc8004/reputation.js');
    const registry = makeRegistry(() => {
      throw new Error('connection refused');
    });
    const outcome = await submitEvaluatorFeedback({
      registry,
      ref: {
        harnessAgentId: RESTORER_AGENT_ID,
        harnessManifestCid: MANIFEST_CID,
        harnessEvidenceHash: EVIDENCE_HASH,
      },
      verdict: { verdict: 'PASS' },
      log: () => {},
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('connection refused');
    }
  });

  it('forwards tag2 when supplied', async () => {
    const { submitEvaluatorFeedback } = await import('../../src/erc8004/reputation.js');
    const registry = makeRegistry();
    await submitEvaluatorFeedback({
      registry,
      ref: {
        harnessAgentId: RESTORER_AGENT_ID,
        harnessManifestCid: MANIFEST_CID,
        harnessEvidenceHash: EVIDENCE_HASH,
      },
      verdict: { verdict: 'PASS', solverType: 'portfolio.v0', tag2: 'eval-impl@1.0.0' },
    });
    expect(registry.giveFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ tag1: 'portfolio.v0', tag2: 'eval-impl@1.0.0' }),
    );
  });
});
