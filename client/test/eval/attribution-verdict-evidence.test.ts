import { describe, expect, it } from 'vitest';

import { VerdictCode } from '../../src/adapters/mech/verdict-code.js';
import {
  verifyAttributionVerdictProof,
} from '../../src/eval/attribution-verdict-evidence.js';
import { createAttributionVerdictProof } from './attribution-verdict-fixture.js';

const INSTANCE_ID = 'django__django-12345';
const proof = () => createAttributionVerdictProof({
  instanceId: INSTANCE_ID,
  acceptedDiff: true,
  nonce: 41,
});

describe('attribution marketplace verdict proof', () => {
  it('derives acceptedDiff from a valid signed envelope and exact marketplace join', async () => {
    const valid = await proof();
    await expect(
      verifyAttributionVerdictProof(valid, INSTANCE_ID),
    ).resolves.toMatchObject({
      acceptedDiff: true,
      verdictRef:
        `verdict:84532:42:0:0:${valid.marketplace.verdict.requestId}`,
    });
    expect(valid.marketplace.verdict.verdictCode).toBe(VerdictCode.Pass);
  });

  it('rejects a marketplace verdict code that contradicts signed passed_match', async () => {
    const mismatch = await proof();
    mismatch.marketplace.verdict.verdictCode = VerdictCode.Fail;

    await expect(
      verifyAttributionVerdictProof(mismatch, INSTANCE_ID),
    ).rejects.toThrow(/verdict code.*signed.*passed_match/i);
  });

  it('rejects arbitrary refs and evidence hashes even when the embedded rows agree', async () => {
    const arbitraryRequest = await proof();
    arbitraryRequest.marketplace.attempt.requestId = `0x${'99'.repeat(32)}`;
    await expect(
      verifyAttributionVerdictProof(arbitraryRequest, INSTANCE_ID),
    ).rejects.toThrow(/solution.*request/i);

    const arbitraryEvidenceHash = await proof();
    arbitraryEvidenceHash.marketplace.verdict.evidenceHash = `0x${'88'.repeat(32)}`;
    await expect(
      verifyAttributionVerdictProof(arbitraryEvidenceHash, INSTANCE_ID),
    ).rejects.toThrow(/verdict.*evidence hash/i);
  });

  it('rejects tuple and participant drift in the marketplace join', async () => {
    const mismatchedTuple = await proof();
    mismatchedTuple.marketplace.verdict.taskId = '43';
    await expect(
      verifyAttributionVerdictProof(mismatchedTuple, INSTANCE_ID),
    ).rejects.toThrow(/exact tuple/i);

    const mismatchedParticipant = await proof();
    mismatchedParticipant.marketplace.verdict.evaluator = `0x${'77'.repeat(20)}`;
    await expect(
      verifyAttributionVerdictProof(mismatchedParticipant, INSTANCE_ID),
    ).rejects.toThrow(/participant Safe/i);
  });

  it('rejects a fabricated outcome that contradicts the signed verdict bytes', async () => {
    const fabricated = await proof();
    fabricated.verdictEnvelope = {
      ...(fabricated.verdictEnvelope as Record<string, unknown>),
      payload: {
        schemaVersion: 'swe-rebench-v2-verdict.v1',
        score: 0,
        passed_match: false,
        evaluator_cost_usd: 0.01,
      },
    };

    await expect(
      verifyAttributionVerdictProof(fabricated, INSTANCE_ID),
    ).rejects.toThrow(/signature authentication/i);
  });
});
