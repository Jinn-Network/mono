import { TASK_EXECUTION_PROTOCOL_URI } from "@jinn-network/task-execution-protocol";
import { compareCodeUnitStrings } from "../order.js";
import { sealDocument } from "../bytes.js";
import { EVALUATION_TASK_PROFILE_URI, TASK_PROFILE_FORMAT_URI, VERDICT_DSSE_PAYLOAD_TYPE } from "../identifiers.js";
import {
  ResourceDescriptorSchema,
  type ResourceDescriptorLike,
} from "../resource-descriptor.js";
import { sealTaskProfile } from "../task-profile/seal.js";
import type { TaskProfileDocument } from "../task-profile/schema.js";

/**
 * The one generic, thin profile for evaluation-as-work (design §9). Evaluation *declaration*
 * stays part of the subject Task (its sealed `evaluation` descriptor); this profile exists
 * because evaluation *execution* is itself agentic work executed through the same claim →
 * execute → deliver machinery as any solve.
 */
export function buildEvaluationTaskProfile(): TaskProfileDocument {
  return {
    protocol: TASK_PROFILE_FORMAT_URI,
    profile: EVALUATION_TASK_PROFILE_URI,
    description:
      "Executes an EvaluationSpec against a subject (Task, Delivery, Results) pair and delivers "
      + "the DSSE-signed Result Evaluation Statement as the required `verdict` output (design §9).",
    // Deliberately closed (`additionalProperties: false`), unlike repository-work/1.0: the design
    // fixes the ENTIRE evaluation Task document — including this payload — as a deterministic
    // template over `(T, D)`. There is no declared sub-profile of evaluation-task/1.0 (design §9);
    // if one is ever added, it becomes the point that requires reopening this shape.
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        subjectTask: { $ref: "#/$defs/subjectRef" },
        subjectDelivery: { $ref: "#/$defs/subjectRef" },
        subjectResults: { type: "array", items: { $ref: "#/$defs/subjectRef" } },
        evaluationSpec: { type: "string" },
      },
      required: ["subjectTask", "subjectDelivery", "subjectResults", "evaluationSpec"],
      $defs: {
        subjectRef: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, digest: { type: "string" } },
          required: ["name", "digest"],
        },
      },
    },
    inputConventions: {
      slots: [
        // The referenced artifacts as fetchable descriptors (design §9.2) — the fixed derivation
        // (`deriveEvaluationTask`) populates one entry per subjectTask/subjectDelivery/subjectResult.
        { name: "subject-artifacts", required: true, descriptorMustCarry: ["digest"] },
        // The grader bundle and any private test material (access via the evaluation
        // Submission's capabilityGrants, TEP §7.5) — not derivable from `(T, D)` digests alone,
        // so these ride the Submission, not the fixed derivation template.
        { name: "grader-bundle", required: true, descriptorMustCarry: ["digest"] },
        { name: "test-material", required: false, descriptorMustCarry: [] },
        // The admission receipt where present (design §7.6).
        { name: "admission-receipt", required: false, descriptorMustCarry: [] },
      ],
    },
    outputConventions: {
      slots: [{ name: "verdict", required: true, mediaType: VERDICT_DSSE_PAYLOAD_TYPE }],
    },
    // Evaluation of an evaluation is opt-in, deployment-commissioned breadth (design §9.3 point
    // 2), not part of the fixed v1 derivation — no families declared here.
    evaluationFamilies: [],
    requirementKeys: [],
  };
}

/** The evaluation-task/1.0 profile document's own sealed digest — computed once, purely, from
 * the builder above (no I/O; this package resolves nothing from disk at runtime). Every derived
 * evaluation Task's `profile` field pins this digest (carried TEP amendment 2, design §6.2). */
const EVALUATION_TASK_PROFILE_DIGEST = sealTaskProfile(buildEvaluationTaskProfile()).digest;

/**
 * Fixed `instructions` text (design §9.1): template-fixed rather than an injection surface, so
 * independent derivers of the same `(T, D)` pair produce byte-identical Task documents.
 */
export const EVALUATION_TASK_INSTRUCTIONS =
  "Execute the EvaluationSpec named by payload.evaluationSpec against the subject Task and "
  + "Delivery named by payload.subjectTask and payload.subjectDelivery, grading the subject "
  + "Results named by payload.subjectResults. Deliver the graded outcome as the required "
  + "`verdict` output slot: a DSSE envelope (payloadType application/vnd.in-toto+json) "
  + "containing the in-toto Result Evaluation Statement, signed by the evaluator Agent's key.";

export interface EvaluationTaskSubjectRef {
  name: string;
  digest: `sha256:${string}`;
}

export interface DeriveEvaluationTaskInput {
  subjectTask: EvaluationTaskSubjectRef;
  subjectDelivery: EvaluationTaskSubjectRef;
  subjectResults: EvaluationTaskSubjectRef[];
  evaluationSpecDigest: `sha256:${string}`;
  /**
   * The subject requester's signed admission receipt descriptor, when the
   * deployment requires one. Program §7.39 fixes its position after every
   * name-sorted subject artifact without changing the receipt-free template.
   */
  admissionReceipt?: ResourceDescriptorLike;
}

function stripSha256Prefix(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function toFetchableDescriptor(ref: EvaluationTaskSubjectRef): ResourceDescriptorLike {
  return { name: ref.name, digest: { sha256: stripSha256Prefix(ref.digest) } };
}

/**
 * The derivation — full-document template, slot-fixed pair (design §9.1). Fixes the ENTIRE
 * evaluation Task document over `(T, D)`: fixed `instructions`, fixed input-slot construction,
 * fixed output declaration, and the payload `{ subjectTask, subjectDelivery, subjectResults
 * (sorted by name), evaluationSpec }` — digests only, schema-fixed field order, so the sealed
 * bytes (and therefore the digest) are identical across independent derivers.
 */
export function deriveEvaluationTask(
  input: DeriveEvaluationTaskInput,
): { document: unknown; bytes: Uint8Array; digest: `sha256:${string}` } {
  const subjectResults = [...input.subjectResults].sort((a, b) =>
    compareCodeUnitStrings(a.name, b.name),
  );
  let admissionReceipt: ResourceDescriptorLike | undefined;
  if (input.admissionReceipt !== undefined) {
    admissionReceipt = ResourceDescriptorSchema.parse(input.admissionReceipt);
    if (admissionReceipt.name !== "admission-receipt") {
      throw new Error('evaluation Task admission receipt descriptor must be named "admission-receipt" (§7.39)');
    }
  }

  const document = {
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: EVALUATION_TASK_PROFILE_URI,
      digest: { sha256: stripSha256Prefix(EVALUATION_TASK_PROFILE_DIGEST) },
    },
    instructions: EVALUATION_TASK_INSTRUCTIONS,
    payload: {
      subjectTask: input.subjectTask,
      subjectDelivery: input.subjectDelivery,
      subjectResults,
      evaluationSpec: input.evaluationSpecDigest,
    },
    inputs: [
      toFetchableDescriptor(input.subjectTask),
      toFetchableDescriptor(input.subjectDelivery),
      ...subjectResults.map(toFetchableDescriptor),
      ...(admissionReceipt === undefined ? [] : [admissionReceipt]),
    ],
    outputs: [{ name: "verdict", mediaType: VERDICT_DSSE_PAYLOAD_TYPE, required: true }],
  };

  const sealed = sealDocument(document);
  return { document, ...sealed };
}
