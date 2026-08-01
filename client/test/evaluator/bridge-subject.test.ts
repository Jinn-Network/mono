import { describe, it, expect } from 'vitest';
import { SubmissionRecordSchema } from '@jinn-network/task-execution-protocol';
import { ADMISSION_RECEIPT_ANNOTATION_URI } from '@jinn-network/marketplace-binding';
import { synthesizeBridgeSubject } from '../../src/evaluator/bridge-subject.js';
import { testDsseSigner } from '../_support/evaluation-fixtures.js';

const input = {
  subjectTaskDigest: `sha256:${'a'.repeat(64)}` as const,
  evaluationSpecDigest: `sha256:${'b'.repeat(64)}` as const,
  requesterAgentIri: 'https://agents.example/jinn/requester-1',
  admissionAgentIri: 'https://agents.example/jinn/admission-1',
  legacyAnchor: { chainId: 84532, taskId: 7n, blockHash: `0x${'ee'.repeat(32)}` as const },
  now: '2026-07-30T00:00:00.000Z',
};

describe('synthesizeBridgeSubject', () => {
  it('produces a schema-valid Submission carrying the admission-receipt descriptor', async () => {
    const subject = await synthesizeBridgeSubject({ ...input, signer: testDsseSigner('admission') });
    expect(() => SubmissionRecordSchema.parse(subject.submission.document)).not.toThrow();
    expect(subject.submission.document.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI]).toBeDefined();
    expect(subject.submission.document.task.digest?.sha256).toBe(input.subjectTaskDigest.slice(7));
  });

  it('is deterministic — two independent parties derive byte-identical Submissions', async () => {
    const a = await synthesizeBridgeSubject({ ...input, signer: testDsseSigner('admission') });
    const b = await synthesizeBridgeSubject({ ...input, signer: testDsseSigner('admission') });
    expect(a.submission.bytes).toEqual(b.submission.bytes);
    expect(a.submission.digest).toBe(b.submission.digest);
  });

  it('marks the derivation as legacy so consumers can see the bridge provenance', async () => {
    const subject = await synthesizeBridgeSubject({ ...input, signer: testDsseSigner('admission') });
    expect(subject.derivation).toBe('legacy');
  });
});
