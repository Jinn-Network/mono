import {
  deriveAndSealEvaluationSubmission,
  type SealedDocumentTriple,
} from '@jinn-network/marketplace-binding';
import { parseEvaluationSpec, type EvaluationSpec } from '@jinn-network/task-execution-profiles';
import type { BridgeSubject } from './bridge-subject.js';
import type { SubjectMaterial } from './subject-material.js';

export const EVALUATOR_SIGNER_GRANT_KEY = 'evaluator-signer';

export type CarveOutRefusal =
  | { readonly kind: 'private-specification'; readonly detail: string }
  | { readonly kind: 'grant-bearing-specification'; readonly detail: string };

function graderDescriptors(spec: EvaluationSpec): readonly { accessClass?: string }[] {
  const grader = spec.grader;
  return Array.isArray(grader) ? grader : [grader];
}

function testMaterialDescriptors(spec: EvaluationSpec): readonly { accessClass?: string }[] {
  if (spec.family !== 'deterministic-process') return [];
  const block = spec.familyBlock as { testMaterial?: readonly { accessClass?: string }[] };
  return block.testMaterial ?? [];
}

function requiresCapabilityGrants(accessClass: string | undefined): boolean {
  return accessClass !== 'public';
}

export function evaluationCarveOutRefusal(spec: EvaluationSpec): CarveOutRefusal | undefined {
  for (const material of testMaterialDescriptors(spec)) {
    if (material.accessClass === 'private') {
      return {
        kind: 'private-specification',
        detail: 'evaluation specification test material is private',
      };
    }
  }

  for (const grader of graderDescriptors(spec)) {
    if (requiresCapabilityGrants(grader.accessClass)) {
      return {
        kind: 'grant-bearing-specification',
        detail: 'evaluation specification declares private or unstamped grader material',
      };
    }
  }

  for (const material of testMaterialDescriptors(spec)) {
    if (requiresCapabilityGrants(material.accessClass)) {
      return {
        kind: 'grant-bearing-specification',
        detail: 'evaluation specification declares unstamped test material requiring grants',
      };
    }
  }

  return undefined;
}

function bareHex(digest: `sha256:${string}`): string {
  return digest.slice('sha256:'.length);
}

export function buildEvaluationDispatch(input: {
  readonly material: SubjectMaterial;
  readonly subject: BridgeSubject;
  readonly evaluatorAgentIri: string;
  readonly deadline: string;
}): { readonly task: SealedDocumentTriple; readonly submission: SealedDocumentTriple } {
  const spec = parseEvaluationSpec(input.material.evaluationSpec.bytes);
  const refusal = evaluationCarveOutRefusal(spec);
  if (refusal !== undefined) {
    throw new Error(`${refusal.kind}: ${refusal.detail}`);
  }

  const taskDigestHex = bareHex(input.material.task.digest);
  const deliveryDigestHex = bareHex(input.material.delivery.digest);

  return deriveAndSealEvaluationSubmission({
    subjectTask: { name: input.material.task.name, digest: input.material.task.digest },
    subjectDelivery: { name: input.material.delivery.name, digest: input.material.delivery.digest },
    subjectResults: input.material.results.map((result) => ({
      name: result.name,
      digest: result.digest,
    })),
    evaluationSpecDigest: input.material.evaluationSpec.digest,
    subjectSubmission: input.subject.submission.document,
    submissionFields: {
      submission: 'urn:uuid:50000000-0000-4000-8000-000000000005',
      requester: input.evaluatorAgentIri,
      idempotencyKey: `evaluation-dispatch:${taskDigestHex}`,
      nonce: `evaluation-nonce:${deliveryDigestHex}`,
      deadline: input.deadline,
      attempts: { maxTotal: 1, maxConcurrent: 1 },
      evaluationRequirements: { minVerdicts: 1 },
    },
    capabilityGrants: {
      [EVALUATOR_SIGNER_GRANT_KEY]: { name: EVALUATOR_SIGNER_GRANT_KEY },
    },
    publicSpec: true,
    sealerRole: 'evaluator',
    selfSignerGrantKey: EVALUATOR_SIGNER_GRANT_KEY,
  });
}
