import { z } from "zod";

import {
  DSSE_PAYLOAD_TYPE,
  EXECUTION_VERIFICATION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
} from "./identifiers.js";

const JsonScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const JsonLdReferenceSchema = z.looseObject({
  "@id": z.string(),
});

export const JsonLdEntitySchema = z.looseObject({
  "@id": z.string(),
  "@type": z.union([z.string(), z.array(z.string()).min(1)]),
});

export const ExecutionEvidenceDocumentSchema = z.looseObject({
  "@context": z.union([
    z.string(),
    z.record(z.string(), z.unknown()),
    z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  ]),
  "@graph": z.array(JsonLdEntitySchema),
});

export const Sha256DigestSchema = z.looseObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ResourceDescriptorSchema = z.looseObject({
  name: z.string().min(1),
  digest: Sha256DigestSchema,
  uri: z.string().optional(),
  content: z.string().optional(),
  mediaType: z.string().optional(),
  downloadLocation: z.string().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

const AgentDescriptorSchema = z.looseObject({
  id: z.string().min(1),
});

const MeasurementSchema = z.looseObject({
  name: z.string().min(1),
  value: JsonScalarSchema,
  unit: z.string().optional(),
});

const EvaluationPredicateSchema = z.looseObject({
  evaluatedAt: z.iso.datetime(),
  evaluator: AgentDescriptorSchema,
  evaluationMethod: ResourceDescriptorSchema.optional(),
  evaluationSpecification: ResourceDescriptorSchema.optional(),
  taskSubject: z.string().min(1),
  resultSubjects: z.array(z.string().min(1)).min(1),
  verdict: z.string().min(1),
  measurements: z.array(MeasurementSchema).optional(),
  evidence: z.array(ResourceDescriptorSchema).optional(),
  explanation: z.string().optional(),
  limitations: z.array(z.string()).optional(),
  supersedes: z.array(ResourceDescriptorSchema).optional(),
  disputes: z.array(ResourceDescriptorSchema).optional(),
});

const VerificationCheckSchema = z.looseObject({
  name: z.string().min(1),
  status: z.string().min(1),
  explanation: z.string().optional(),
  evidence: z.array(ResourceDescriptorSchema).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

const VerificationPredicateSchema = z.looseObject({
  verifiedAt: z.iso.datetime(),
  verifier: AgentDescriptorSchema,
  verificationMethod: ResourceDescriptorSchema.optional(),
  verificationPolicy: ResourceDescriptorSchema.optional(),
  executionId: z.string().min(1),
  verdict: z.string().min(1),
  checks: z.array(VerificationCheckSchema).optional(),
  explanation: z.string().optional(),
  limitations: z.array(z.string()).optional(),
  supersedes: z.array(ResourceDescriptorSchema).optional(),
  disputes: z.array(ResourceDescriptorSchema).optional(),
});

export const ResultEvaluationStatementSchema = z.looseObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.array(ResourceDescriptorSchema).min(1),
  predicateType: z.literal(RESULT_EVALUATION_PREDICATE_TYPE),
  predicate: EvaluationPredicateSchema,
});

export const ExecutionVerificationStatementSchema = z.looseObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.array(ResourceDescriptorSchema).min(1),
  predicateType: z.literal(EXECUTION_VERIFICATION_PREDICATE_TYPE),
  predicate: VerificationPredicateSchema,
});

export const DsseEnvelopeSchema = z.looseObject({
  payloadType: z.literal(DSSE_PAYLOAD_TYPE),
  payload: z.string(),
  signatures: z
    .array(
      z.looseObject({
        keyid: z.string().optional(),
        sig: z.string(),
      }),
    )
    .min(1),
});

export type ExecutionEvidenceDocument = z.infer<
  typeof ExecutionEvidenceDocumentSchema
>;
export type ResultEvaluationStatement = z.infer<
  typeof ResultEvaluationStatementSchema
>;
export type ExecutionVerificationStatement = z.infer<
  typeof ExecutionVerificationStatementSchema
>;
export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;
