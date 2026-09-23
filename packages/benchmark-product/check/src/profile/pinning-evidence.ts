import type {
  LocalCellPinningEvidence,
} from "@jinn-network/benchmarking-local";
import { serializeCanonicalJson, type JsonValue } from "@jinn-network/task-execution-protocol";
import { z } from "zod";

const Sha256RefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const RunPinningCheckSchema = z.object({
  ready: z.boolean(),
  detail: z.string().optional(),
  checkedRequirementsDigest: Sha256RefSchema,
}).strict();

const AxisObservationSchema = z.object({
  axis: z.enum(["harness", "model", "loadout", "isolation"]),
  value: z.unknown(),
  source: z.enum(["runtime-observation", "materialization", "admission-probe"]),
}).strict();

/**
 * Product-private evidence artifact stored by digest in the existing sealed-bytes CAS.
 *
 * This is not a Benchmarking record kind and carries no publication-tier semantics. It is the
 * exact assembly input needed to recompute the Matrix pinning statuses. An artifact must carry
 * at least one real fact; an empty object cannot become an evidence reference.
 */
export const RunPinningEvidenceSchema = z.object({
  /** Exact accepted sealed Submission whose admission/observations this artifact describes. */
  submissionDigest: Sha256RefSchema,
  admission: RunPinningCheckSchema.optional(),
  observations: z.array(AxisObservationSchema).min(1).optional(),
}).strict().refine(
  (evidence) => evidence.admission !== undefined || evidence.observations !== undefined,
  "run-pinning evidence must carry an admission check or an observation",
);

export type RunPinningEvidence = z.infer<typeof RunPinningEvidenceSchema>;

export interface VerifiedRunPinningCheck {
  readonly ready: boolean;
  readonly detail?: string;
  readonly checkedRequirementsDigest: `sha256:${string}`;
}

export function canonicalRunPinningEvidenceBytes(
  check: VerifiedRunPinningCheck,
  submissionDigest: `sha256:${string}`,
): Uint8Array {
  const evidence = RunPinningEvidenceSchema.parse({ submissionDigest, admission: check });
  return serializeCanonicalJson(evidence as JsonValue);
}

export function parseRunPinningEvidenceArtifact(bytes: Uint8Array): RunPinningEvidence {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  return RunPinningEvidenceSchema.parse(value);
}

export function pinningEvidenceFacts(artifact: RunPinningEvidence): LocalCellPinningEvidence {
  return {
    ...(artifact.admission === undefined ? {} : { admission: artifact.admission }),
    ...(artifact.observations === undefined ? {} : { observations: artifact.observations }),
  } as LocalCellPinningEvidence;
}

export function parseRunPinningEvidence(bytes: Uint8Array): LocalCellPinningEvidence {
  return pinningEvidenceFacts(parseRunPinningEvidenceArtifact(bytes));
}
