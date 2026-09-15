import { createHash, type KeyObject } from "node:crypto";
import { z } from "zod";
import { parseDsseEnvelope } from "@jinn-network/trust-core";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { refuse } from "./errors.js";

const value = z.union([z.boolean(), z.number(), z.string()]);
const statement = z.object({ predicate: z.object({ evaluator: z.looseObject({ id: z.string().min(1) }), verdict: z.enum(["pass", "fail", "inconclusive"]), evaluationSpecification: z.looseObject({ digest: z.looseObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }) }), evaluationMethod: z.looseObject({ name: z.string().min(1), digest: z.looseObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }) }).optional(), measurements: z.array(z.looseObject({ name: z.string().min(1), value })).optional(), evidence: z.array(z.looseObject({ name: z.string().min(1), digest: z.looseObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }), mediaType: z.string().optional() })).optional(), evaluatedAt: z.string().min(1), limitations: z.array(z.string()).optional() }) });

export function verdictKeyIdFromEd25519PublicKey(publicKey: KeyObject): string {
  return `benchmark-product-verdict-${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16)}`;
}
export interface VerdictStatementView { readonly evaluatorId: string; readonly verdict: "pass" | "fail" | "inconclusive"; readonly evaluationSpecificationSha256: string; readonly measurements: Record<string, boolean | number | string>; readonly evaluatedAt: string; readonly evaluationMethod?: { readonly name: string; readonly sha256: string }; readonly evidence?: readonly { readonly name: string; readonly sha256: string; readonly mediaType?: string }[]; readonly evaluatorExtensions?: Readonly<Record<string, unknown>>; readonly limitations?: readonly string[]; }
export interface OrderedVerdictMeasurement { readonly name: string; readonly value: boolean | number | string; }

/** Parses only the public Result Evaluation Statement projection needed by bundle verification. */
export function readVerdictEnvelope(envelopeBytes: Uint8Array): VerdictStatementView {
  const envelope = parseDsseEnvelope(envelopeBytes);
  if (envelope.payloadType !== VERDICT_DSSE_PAYLOAD_TYPE) refuse("execution", "payloadType", "verdict envelope payloadType is not the verdict DSSE payload type");
  let json: unknown; try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes)); } catch { refuse("execution", "verdict envelope payload", "verdict envelope payload is not valid JSON"); }
  const parsed = statement.safeParse(json);
  if (!parsed.success) refuse("execution", "verdict envelope payload", "verdict envelope payload does not conform to the expected Result Evaluation Statement shape");
  const { id: evaluatorId, ...extensions } = parsed.data.predicate.evaluator;
  return { evaluatorId, verdict: parsed.data.predicate.verdict, evaluationSpecificationSha256: parsed.data.predicate.evaluationSpecification.digest.sha256, measurements: Object.fromEntries((parsed.data.predicate.measurements ?? []).map((measurement) => [measurement.name, measurement.value])), evaluatedAt: parsed.data.predicate.evaluatedAt, ...(parsed.data.predicate.evaluationMethod === undefined ? {} : { evaluationMethod: { name: parsed.data.predicate.evaluationMethod.name, sha256: parsed.data.predicate.evaluationMethod.digest.sha256 } }), ...(parsed.data.predicate.evidence === undefined ? {} : { evidence: parsed.data.predicate.evidence.map((entry) => ({ name: entry.name, sha256: entry.digest.sha256, ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }) })) }), ...(Object.keys(extensions).length === 0 ? {} : { evaluatorExtensions: extensions }), ...(parsed.data.predicate.limitations === undefined ? {} : { limitations: parsed.data.predicate.limitations }) };
}

/** Lossless measurement view for contracts that pre-register order as well as names. */
export function readOrderedVerdictMeasurements(
  envelopeBytes: Uint8Array,
): readonly OrderedVerdictMeasurement[] {
  const envelope = parseDsseEnvelope(envelopeBytes);
  if (envelope.payloadType !== VERDICT_DSSE_PAYLOAD_TYPE) {
    refuse("execution", "payloadType", "verdict envelope payloadType is not the verdict DSSE payload type");
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes));
  } catch {
    refuse("execution", "verdict envelope payload", "verdict envelope payload is not valid JSON");
  }
  const parsed = statement.safeParse(json);
  if (!parsed.success) {
    refuse("execution", "verdict envelope payload", "verdict envelope payload does not conform to the expected Result Evaluation Statement shape");
  }
  const measurements = parsed.data.predicate.measurements ?? [];
  if (new Set(measurements.map((measurement) => measurement.name)).size !== measurements.length) {
    refuse("execution", "verdict envelope payload", "verdict envelope carries duplicate measurement names");
  }
  return measurements.map((measurement) => ({ name: measurement.name, value: measurement.value }));
}
