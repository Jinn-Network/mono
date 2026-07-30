import { z } from "zod";
import { canonicalJsonBytes } from "./bytes.js";
import type { DsseEnvelope } from "./admission-receipt.js";
import { IN_TOTO_STATEMENT_TYPE, RESULT_EVALUATION_PREDICATE_TYPE, VERDICT_DSSE_PAYLOAD_TYPE } from "./identifiers.js";

/**
 * `ResultEvaluationStatementShape` — a structural mirror transcribed field-for-field from
 * `packages/evidence/protocol/src/schemas.ts` (`ResultEvaluationStatementSchema` /
 * `EvaluationPredicateSchema` / `ResourceDescriptorSchema` / `Sha256DigestSchema`). No evidence
 * import: byte-compat with the real Evidence predicate is held by the
 * `fixtures/result-evaluation/golden/evidence-statement.json` byte-pin fixture (design §12/§14;
 * program §7.15; plan Task 13 Finding 8), not by a compile-time link.
 *
 * Shape traps (transcribed exactly — getting any of these wrong emits a Statement that is NOT a
 * valid Evidence record):
 * - every `subject[].digest` and every ResourceDescriptor's `digest` is an OBJECT `{ sha256: hex
 *   }`, NOT a bare `sha256:…` string — the one place this mirror diverges from the rest of this
 *   package's own `sha256:${string}` digest-string convention;
 * - `predicate.evaluationSpecification` / `predicate.evaluationMethod` are ResourceDescriptor
 *   OBJECTS (`{ name, digest: { sha256 } }`), NOT bare spec-digest strings — design §9.2's "= the
 *   spec digest" names the referent, not the wire shape;
 * - `predicate.taskSubject` / `predicate.resultSubjects` are subject-NAME strings (e.g.
 *   `"execution/task/task.md"`), NOT digests;
 * - `predicate.measurements` carry DELIVERED values `{ name, value, unit? }` — a DIFFERENT shape
 *   from an EvaluationSpec's DECLARED measurements `{ name, type, unit?, direction, required }`
 *   (`evaluation-spec/schema.ts`).
 */
const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const Sha256DigestObjectSchema = z.looseObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const ResultEvaluationResourceDescriptorSchema = z.looseObject({
  name: z.string().min(1),
  digest: Sha256DigestObjectSchema,
  uri: z.string().optional(),
  content: z.string().optional(),
  mediaType: z.string().optional(),
  downloadLocation: z.string().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type ResultEvaluationResourceDescriptor = z.infer<typeof ResultEvaluationResourceDescriptorSchema>;

const AgentDescriptorSchema = z.looseObject({ id: z.string().min(1) });

const DeliveredMeasurementSchema = z.looseObject({
  name: z.string().min(1),
  value: JsonScalarSchema,
  unit: z.string().optional(),
});

const ResultEvaluationPredicateSchema = z.looseObject({
  evaluatedAt: z.iso.datetime(),
  evaluator: AgentDescriptorSchema,
  evaluationMethod: ResultEvaluationResourceDescriptorSchema.optional(),
  evaluationSpecification: ResultEvaluationResourceDescriptorSchema.optional(),
  taskSubject: z.string().min(1),
  resultSubjects: z.array(z.string().min(1)).min(1),
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  measurements: z.array(DeliveredMeasurementSchema).optional(),
  evidence: z.array(ResultEvaluationResourceDescriptorSchema).optional(),
  explanation: z.string().optional(),
  limitations: z.array(z.string()).optional(),
  supersedes: z.array(ResultEvaluationResourceDescriptorSchema).optional(),
  disputes: z.array(ResultEvaluationResourceDescriptorSchema).optional(),
});
export type ResultEvaluationPredicate = z.infer<typeof ResultEvaluationPredicateSchema>;

export const ResultEvaluationStatementShape = z.looseObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.array(ResultEvaluationResourceDescriptorSchema).min(1),
  predicateType: z.literal(RESULT_EVALUATION_PREDICATE_TYPE),
  predicate: ResultEvaluationPredicateSchema,
});
export type ResultEvaluationStatement = z.infer<typeof ResultEvaluationStatementShape>;

/**
 * The delivered `verdict` output slot IS the DSSE-signed Result Evaluation Statement (design
 * §9.2) — no separate claim-issuance step. `payload` is the base64 encoding of the statement's
 * canonical JSON bytes (this package's own sealer, per Global Constraints: sealing is
 * re-implemented locally).
 */
export function buildVerdictEnvelope(
  statement: ResultEvaluationStatement,
  signatures: { keyid?: string; sig: string }[],
): DsseEnvelope {
  const bytes = canonicalJsonBytes(statement);
  return {
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(bytes).toString("base64"),
    signatures,
  };
}
