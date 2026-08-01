import {
  deriveEvaluationTask,
  type DeriveEvaluationTaskInput,
} from "@jinn-network/task-execution-profiles";
import {
  SubmissionRecordSchema,
  documentDigest,
  sealSubmission,
  type SubmissionRecord,
} from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import {
  ADMISSION_RECEIPT_ANNOTATION_URI,
  deriveAndSealEvaluationSubmission,
  type DeriveAndSealEvaluationSubmissionInput,
} from "./evaluation-derive.js";

const receipt = {
  name: "admission-receipt",
  digest: { sha256: "a".repeat(64) },
  uri: "ipfs://bafy-admission-receipt",
  mediaType: "application/vnd.in-toto+json",
};

const subjectTask = {
  name: "subject-task.json",
  digest: `sha256:${"1".repeat(64)}` as const,
};
const subjectDelivery = {
  name: "subject-delivery.json",
  digest: `sha256:${"2".repeat(64)}` as const,
};
const subjectResults = [
  { name: "z-result.txt", digest: `sha256:${"3".repeat(64)}` as const },
  { name: "a-result.txt", digest: `sha256:${"4".repeat(64)}` as const },
];
const evaluationSpecDigest = `sha256:${"5".repeat(64)}` as const;

const subjectSubmission = SubmissionRecordSchema.parse({
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  submission: "urn:uuid:10000000-0000-4000-8000-000000000001",
  task: { name: subjectTask.name, digest: { sha256: subjectTask.digest.slice("sha256:".length) } },
  requester: "urn:uuid:20000000-0000-4000-8000-000000000002",
  idempotencyKey: "subject-submission",
  nonce: "subject-nonce",
  deadline: "2030-01-01T00:00:00Z",
  annotations: { [ADMISSION_RECEIPT_ANNOTATION_URI]: receipt },
});

function evaluatorSealedInput(): DeriveAndSealEvaluationSubmissionInput {
  return input({
    publicSpec: true,
    sealerRole: "evaluator",
    capabilityGrants: {},
  });
}

function input(
  overrides: Partial<DeriveAndSealEvaluationSubmissionInput> = {},
): DeriveAndSealEvaluationSubmissionInput {
  return {
    subjectTask,
    subjectSubmission,
    subjectDelivery,
    subjectResults,
    evaluationSpecDigest,
    submissionFields: {
      submission: "urn:uuid:30000000-0000-4000-8000-000000000003",
      requester: "urn:uuid:20000000-0000-4000-8000-000000000002",
      idempotencyKey: "evaluation-submission",
      nonce: "evaluation-nonce",
      deadline: "2030-01-02T00:00:00Z",
      attempts: { maxTotal: 1, maxConcurrent: 1 },
      evaluationRequirements: { minVerdicts: 1 },
    },
    capabilityGrants: {
      "grader-bundle": { uri: "urn:jinn:capability:grader" },
      "test-material": { uri: "urn:jinn:capability:tests" },
    },
    publicSpec: false,
    sealerRole: "requester",
    ...overrides,
  };
}

describe("deriveAndSealEvaluationSubmission (§6.4, program §7.39–§7.40)", () => {
  test("derives the exact evaluation Task and seals a Submission bound to its digest", () => {
    const result = deriveAndSealEvaluationSubmission(input());
    const independentlyDerived = deriveEvaluationTask({
      subjectTask,
      subjectDelivery,
      subjectResults,
      evaluationSpecDigest,
      admissionReceipt: receipt,
    } satisfies DeriveEvaluationTaskInput);

    expect(result.task.bytes).toEqual(independentlyDerived.bytes);
    expect(result.task.digest).toBe(independentlyDerived.digest);
    expect(result.task.document).toEqual(independentlyDerived.document);

    const parsed = SubmissionRecordSchema.parse(result.submission.document);
    expect(parsed.task).toEqual({
      name: "evaluation-task",
      digest: { sha256: result.task.digest.slice("sha256:".length) },
    });
    expect(parsed.capabilityGrants).toEqual(input().capabilityGrants);
    expect(parsed).not.toHaveProperty("admissionReceipt");
    expect(parsed.profileParameters).toBeUndefined();
    expect(parsed.annotations).toBeUndefined();
    expect(result.submission.bytes).toEqual(sealSubmission(parsed));
    expect(result.submission.digest).toBe(documentDigest(result.submission.bytes));
  });

  test("requires the exact admission-receipt descriptor on the subject Submission", () => {
    const withoutReceipt: SubmissionRecord = {
      ...subjectSubmission,
      annotations: {},
    };
    expect(() => deriveAndSealEvaluationSubmission(input({ subjectSubmission: withoutReceipt })))
      .toThrow(/admission-receipt/);

    const wrongName: SubmissionRecord = {
      ...subjectSubmission,
      annotations: {
        [ADMISSION_RECEIPT_ANNOTATION_URI]: { ...receipt, name: "not-the-admission-receipt" },
      },
    };
    expect(() => deriveAndSealEvaluationSubmission(input({ subjectSubmission: wrongName })))
      .toThrow(/named "admission-receipt"/);
  });

  test("requires the receipt-bearing subject Submission to bind the supplied settlement Task", () => {
    const mismatched: SubmissionRecord = {
      ...subjectSubmission,
      task: {
        name: "another-task.json",
        digest: { sha256: "f".repeat(64) },
      },
    };
    expect(() => deriveAndSealEvaluationSubmission(input({ subjectSubmission: mismatched })))
      .toThrow(/subject Submission task digest/);
  });

  test("requester-side sealing preserves the subject Submission requester IRI", () => {
    expect(() => deriveAndSealEvaluationSubmission(input({
      submissionFields: {
        ...input().submissionFields,
        requester: "https://jinn.network/agents/not-the-subject-requester",
      },
    }))).toThrow(/requester must equal/);
  });

  test("requires requester sealing for private or grant-bearing evaluation dispatch", () => {
    expect(() => deriveAndSealEvaluationSubmission(input({ sealerRole: "evaluator" })))
      .toThrow(/requester/);
    expect(() => deriveAndSealEvaluationSubmission(input({
      publicSpec: true,
      sealerRole: "evaluator",
    }))).toThrow(/grant-free/);
  });

  test("allows evaluator sealing only for a fully public, grant-free evaluation", () => {
    const result = deriveAndSealEvaluationSubmission(input({
      publicSpec: true,
      sealerRole: "evaluator",
      capabilityGrants: {},
    }));
    expect(SubmissionRecordSchema.parse(result.submission.document).capabilityGrants).toEqual({});
  });

  test("rejects caller attempts to widen the closed submissionFields surface", () => {
    const widened = input();
    const fields = widened.submissionFields as unknown as Record<string, unknown>;
    fields.protocol = "https://attacker.invalid/protocol";
    fields.task = { digest: { sha256: "0".repeat(64) } };
    expect(() => deriveAndSealEvaluationSubmission(widened)).toThrow(/unsupported submissionFields/);
  });

  test("evaluator sealing admits exactly one declared self-signer grant (§7.40 addendum)", () => {
    const result = deriveAndSealEvaluationSubmission({
      ...evaluatorSealedInput(),
      publicSpec: true,
      sealerRole: "evaluator",
      selfSignerGrantKey: "evaluator-signer",
      capabilityGrants: { "evaluator-signer": { name: "evaluator-signer" } },
    });
    expect(result.submission.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("evaluator sealing still refuses a grant that is not the declared self-signer", () => {
    expect(() => deriveAndSealEvaluationSubmission({
      ...evaluatorSealedInput(),
      publicSpec: true,
      sealerRole: "evaluator",
      selfSignerGrantKey: "evaluator-signer",
      capabilityGrants: { "evaluator-signer": {}, "private-grader": {} },
    })).toThrow(/fully public/);
  });

  test("evaluator sealing still refuses a private specification even with a self-signer grant", () => {
    expect(() => deriveAndSealEvaluationSubmission({
      ...evaluatorSealedInput(),
      publicSpec: false,
      sealerRole: "evaluator",
      selfSignerGrantKey: "evaluator-signer",
      capabilityGrants: { "evaluator-signer": {} },
    })).toThrow(/requester-side sealing/);
  });

  test("evaluator sealing refuses a grant when no self-signer key is declared", () => {
    expect(() => deriveAndSealEvaluationSubmission({
      ...evaluatorSealedInput(),
      publicSpec: true,
      sealerRole: "evaluator",
      capabilityGrants: { "evaluator-signer": {} },
    })).toThrow(/fully public/);
  });
});
