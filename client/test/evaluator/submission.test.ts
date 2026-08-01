import { describe, it, expect } from 'vitest';
import { evaluationCarveOutRefusal, buildEvaluationDispatch, EVALUATOR_SIGNER_GRANT_KEY }
  from '../../src/evaluator/submission.js';
import { publicSpec, privateSpec, grantBearingSpec, subjectMaterialFixture, bridgeSubjectFixture }
  from '../_support/evaluation-fixtures.js';

describe('evaluator-seals carve-out', () => {
  it('accepts a fully public evaluation specification', () => {
    expect(evaluationCarveOutRefusal(publicSpec())).toBeUndefined();
  });

  it('refuses a specification whose test material is private — requester-side sealing is stage 3', () => {
    expect(evaluationCarveOutRefusal(privateSpec())).toMatchObject({ kind: 'private-specification' });
  });

  it('refuses a specification that requires capability grants', () => {
    expect(evaluationCarveOutRefusal(grantBearingSpec())).toMatchObject({ kind: 'grant-bearing-specification' });
  });
});

describe('buildEvaluationDispatch', () => {
  it('carries exactly the self-signer grant and nothing else', async () => {
    const dispatch = buildEvaluationDispatch({
      material: await subjectMaterialFixture(),
      subject: await bridgeSubjectFixture(),
      evaluatorAgentIri: 'https://agents.example/jinn/operator-1',
      deadline: '2026-07-31T00:00:00.000Z',
    });
    const grants = (dispatch.submission.document as { capabilityGrants: Record<string, unknown> }).capabilityGrants;
    expect(Object.keys(grants)).toEqual([EVALUATOR_SIGNER_GRANT_KEY]);
  });

  it('derives a Task byte-identical to an independent derivation of the same pair', async () => {
    const material = await subjectMaterialFixture();
    const subject = await bridgeSubjectFixture();
    const a = buildEvaluationDispatch({ material, subject, evaluatorAgentIri: 'x', deadline: '2026-07-31T00:00:00.000Z' });
    const b = buildEvaluationDispatch({ material, subject, evaluatorAgentIri: 'y', deadline: '2026-07-31T00:00:00.000Z' });
    expect(a.task.bytes).toEqual(b.task.bytes);
  });
});
