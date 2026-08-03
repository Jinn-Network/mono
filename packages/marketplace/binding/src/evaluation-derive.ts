import {
  deriveEvaluationTask,
  type DeriveEvaluationTaskInput,
} from "@jinn-network/task-execution-profiles";
import {
  ResourceDescriptorSchema,
  SubmissionRecordSchema,
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealSubmission,
  type SubmissionRecord,
} from "@jinn-network/task-execution-protocol";

export const ADMISSION_RECEIPT_ANNOTATION_URI =
  "https://jinn.network/annotations/admission-receipt/1.0" as const;

export interface EvaluationSubmissionFields {
  readonly submission: string;
  readonly requester: string;
  readonly idempotencyKey: string;
  readonly nonce: string;
  readonly deadline: string;
  readonly closeAt?: string;
  readonly attempts?: SubmissionRecord["attempts"];
  readonly evaluationRequirements?: SubmissionRecord["evaluationRequirements"];
  readonly requirements?: SubmissionRecord["requirements"];
  readonly profileParameters?: SubmissionRecord["profileParameters"];
  readonly annotations?: SubmissionRecord["annotations"];
}

export interface DeriveAndSealEvaluationSubmissionInput
  extends DeriveEvaluationTaskInput {
  readonly subjectSubmission: SubmissionRecord;
  readonly submissionFields: EvaluationSubmissionFields;
  readonly capabilityGrants: Record<string, unknown>;
  readonly publicSpec: boolean;
  readonly sealerRole: "requester" | "evaluator";
}

export interface SealedDocumentTriple {
  readonly document: unknown;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export interface DerivedEvaluationSubmission {
  readonly task: SealedDocumentTriple;
  readonly submission: SealedDocumentTriple;
}

const SUBMISSION_FIELD_KEYS = new Set([
  "submission",
  "requester",
  "idempotencyKey",
  "nonce",
  "deadline",
  "closeAt",
  "attempts",
  "evaluationRequirements",
  "requirements",
  "profileParameters",
  "annotations",
]);

function assertClosedSubmissionFields(fields: EvaluationSubmissionFields): void {
  const unsupported = Object.keys(fields).filter((key) => !SUBMISSION_FIELD_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(`unsupported submissionFields: ${unsupported.join(", ")}`);
  }
}

function parseSubjectSubmission(subjectSubmission: SubmissionRecord) {
  const parsed = SubmissionRecordSchema.parse(subjectSubmission);
  const candidate = parsed.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI];
  if (candidate === undefined) {
    throw new Error(
      `subject Submission must carry the admission-receipt descriptor at ${ADMISSION_RECEIPT_ANNOTATION_URI} (§7.39)`,
    );
  }
  const receipt = ResourceDescriptorSchema.parse(candidate);
  if (receipt.name !== "admission-receipt") {
    throw new Error('subject Submission receipt descriptor must be named "admission-receipt" (§7.39)');
  }
  return { parsed, receipt };
}

function assertSealerRule(input: DeriveAndSealEvaluationSubmissionInput): void {
  const grantKeys = Object.keys(input.capabilityGrants);
  if (input.sealerRole === "evaluator") {
    if (!input.publicSpec) {
      throw new Error("private evaluation specifications require requester-side sealing (§7.40)");
    }
    if (grantKeys.length > 0) {
      throw new Error("evaluator sealing is allowed only for a fully public, grant-free evaluation (§7.40)");
    }
  }
}

/**
 * Derives the pair-fixed evaluation Task, then canonically seals the new
 * dispatch Submission. "Seal" is the TEP canonical-byte operation; the
 * requester DSSE envelope is a separate named-check input (program §7.40).
 */
export function deriveAndSealEvaluationSubmission(
  input: DeriveAndSealEvaluationSubmissionInput,
): DerivedEvaluationSubmission {
  assertClosedSubmissionFields(input.submissionFields);
  assertSealerRule(input);

  const { parsed: subjectSubmission, receipt: admissionReceipt } =
    parseSubjectSubmission(input.subjectSubmission);
  const expectedTaskDigest = input.subjectTask.digest.slice("sha256:".length);
  if (subjectSubmission.task.digest?.sha256 !== expectedTaskDigest) {
    throw new Error(
      "subject Submission task digest must equal the supplied settlement Task digest (§7.40)",
    );
  }
  if (
    input.sealerRole === "requester"
    && input.submissionFields.requester !== subjectSubmission.requester
  ) {
    throw new Error(
      "requester-side evaluation Submission requester must equal the subject Submission requester (§7.40)",
    );
  }
  const task = deriveEvaluationTask({
    subjectTask: input.subjectTask,
    subjectDelivery: input.subjectDelivery,
    subjectResults: input.subjectResults,
    evaluationSpecDigest: input.evaluationSpecDigest,
    admissionReceipt,
  });

  const document = {
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: input.submissionFields.submission,
    task: {
      name: "evaluation-task",
      digest: { sha256: task.digest.slice("sha256:".length) },
    },
    requester: input.submissionFields.requester,
    idempotencyKey: input.submissionFields.idempotencyKey,
    nonce: input.submissionFields.nonce,
    deadline: input.submissionFields.deadline,
    ...(input.submissionFields.closeAt === undefined
      ? {}
      : { closeAt: input.submissionFields.closeAt }),
    ...(input.submissionFields.attempts === undefined
      ? {}
      : { attempts: input.submissionFields.attempts }),
    ...(input.submissionFields.evaluationRequirements === undefined
      ? {}
      : { evaluationRequirements: input.submissionFields.evaluationRequirements }),
    ...(Object.keys(input.capabilityGrants).length === 0
      ? {}
      : { capabilityGrants: input.capabilityGrants }),
    ...(input.submissionFields.requirements === undefined
      ? {}
      : { requirements: input.submissionFields.requirements }),
    ...(input.submissionFields.profileParameters === undefined
      ? {}
      : { profileParameters: input.submissionFields.profileParameters }),
    ...(input.submissionFields.annotations === undefined
      ? {}
      : { annotations: input.submissionFields.annotations }),
  };
  const bytes = sealSubmission(document);
  return {
    task,
    submission: {
      document,
      bytes,
      digest: documentDigest(bytes),
    },
  };
}
