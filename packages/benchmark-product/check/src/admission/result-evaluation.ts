// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { parseExactDsseEnvelope } from "@jinn-network/trust-core";

const MeasurementValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const VerdictStatementSchema = z.looseObject({
  predicateType: z.string().min(1),
  predicate: z.looseObject({
    evaluator: z.looseObject({ id: z.string().min(1) }),
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    evaluationSpecification: z.looseObject({
      digest: z.looseObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
    }),
    evaluationMethod: z.looseObject({
      name: z.string().min(1),
      digest: z.looseObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
    }).optional(),
    measurements: z.array(z.looseObject({ name: z.string().min(1), value: MeasurementValueSchema })).optional(),
    evidence: z.array(z.looseObject({
      name: z.string().min(1),
      digest: z.looseObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
      mediaType: z.string().optional(),
    })).optional(),
    evaluatedAt: z.string().min(1),
    limitations: z.array(z.string()).optional(),
  }),
});

export interface AdmissionVerdictStatementView {
  readonly evaluatorId: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly evaluationSpecificationSha256: string;
  readonly measurements: Readonly<Record<string, boolean | number | string>>;
  readonly evaluatedAt: string;
  readonly evidence?: readonly { readonly name: string; readonly sha256: string; readonly mediaType?: string }[];
  readonly limitations?: readonly string[];
}

function statement(envelopeBytes: Uint8Array) {
  const envelope = parseExactDsseEnvelope(envelopeBytes);
  if (envelope.payloadType !== VERDICT_DSSE_PAYLOAD_TYPE) throw new Error("wrong Result Evaluation payload type");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes));
  } catch {
    throw new Error("Result Evaluation payload is not UTF-8 JSON");
  }
  const parsed = VerdictStatementSchema.safeParse(json);
  if (!parsed.success) throw new Error("Result Evaluation payload is outside the closed view");
  return parsed.data;
}

export function readAdmissionVerdictEnvelope(envelopeBytes: Uint8Array): AdmissionVerdictStatementView {
  const { predicate } = statement(envelopeBytes);
  const measurements: Record<string, boolean | number | string> = {};
  for (const measurement of predicate.measurements ?? []) measurements[measurement.name] = measurement.value;
  return {
    evaluatorId: predicate.evaluator.id,
    verdict: predicate.verdict,
    evaluationSpecificationSha256: predicate.evaluationSpecification.digest.sha256,
    measurements,
    evaluatedAt: predicate.evaluatedAt,
    ...(predicate.evidence === undefined ? {} : {
      evidence: predicate.evidence.map((entry) => ({
        name: entry.name,
        sha256: entry.digest.sha256,
        ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
      })),
    }),
    ...(predicate.limitations === undefined ? {} : { limitations: predicate.limitations }),
  };
}

export function readOrderedAdmissionVerdictMeasurements(
  envelopeBytes: Uint8Array,
): readonly { readonly name: string; readonly value: boolean | number | string }[] {
  const measurements = statement(envelopeBytes).predicate.measurements ?? [];
  if (new Set(measurements.map((measurement) => measurement.name)).size !== measurements.length) {
    throw new Error("Result Evaluation carries duplicate measurement names");
  }
  return measurements.map((measurement) => ({ name: measurement.name, value: measurement.value }));
}
