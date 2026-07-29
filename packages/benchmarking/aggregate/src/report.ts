import {
  BENCHMARKING_PROTOCOL,
  REPORT_MEDIA_TYPE,
  checkComparability,
  parseReport,
  sealMatrix,
  sealReport,
  type MatrixRecord,
  type ReportRecord,
} from "@jinn-network/benchmarking-records";
import { dssePreAuthEncoding, sealDsseEnvelope, type DsseProducedSignature, type DsseSigner as TrustDsseSigner } from "@jinn-network/trust-core";
import type { Method, MethodComputeInput, MethodRegistry, VerdictOutcome, VerdictRuleName } from "./method.js";

/** `ReportRecord["disclosures"]` is optional at the schema-type level (superRefine enforces
 * presence at runtime); this package always builds/verifies the non-optional shape. */
export type Disclosures = NonNullable<ReportRecord["disclosures"]>;

function stripSha256Prefix(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

/**
 * Derives the lossless one-to-one Report disclosures required by program §7.23. No counts,
 * floors, arm IDs, run outcomes, or flags are merged across Matrix subjects.
 */
export function deriveDisclosures(subjects: readonly MatrixRecord[]): Disclosures {
  return {
    perSubject: subjects.map((matrix) => {
      const integrityTiers = { "re-derivable": 0, "attested-only": 0 };
      const pinningAxes = ["harness", "model", "loadout", "isolation"] as const;
      const pinning = Object.fromEntries(
        pinningAxes.map((axis) => [axis, { match: 0, mismatch: 0, unverifiable: 0 }]),
      ) as Disclosures["perSubject"][number]["pinning"];
      let independence = 0;
      for (const cell of matrix.cells) {
        integrityTiers[cell.integrityTier] += 1;
        for (const axis of pinningAxes) pinning[axis][cell.verification[axis]] += 1;
        if (cell.verification.checksFailed.includes("evaluator-independence")) independence += 1;
      }
      return {
        subjectSha256: stripSha256Prefix(sealMatrix(matrix).digest),
        integrityTiers,
        pinning,
        independence,
        completeness: matrix.completeness,
        attrition: matrix.attrition,
      };
    }),
  };
}

export interface MethodPorts {
  readonly resolveVerdict: (verdictDigest: string) => VerdictOutcome | undefined;
  readonly resolveClusterKey?: (taskDigest: string) => string | undefined;
  readonly resolveTaskTimestamp?: (taskDigest: string) => string | undefined;
  readonly rng?: () => number;
  readonly registry: MethodRegistry;
}

export interface ProduceReportInput extends MethodPorts {
  readonly subjects: readonly MatrixRecord[];
  readonly method: { readonly id: string; readonly version: string; readonly parameters: Readonly<Record<string, unknown>> };
  /** The contract-wide verdictRule (design §9.2) — sealed into `method.parameters.verdictRule`
   * (the only schema-conformant place a Report can carry it; neither Run nor Matrix stores it),
   * so a later `verifyReport` call recovers exactly what recomputation must use. */
  readonly verdictRule: VerdictRuleName;
  readonly disclosures?: Disclosures;
  readonly limitations?: readonly string[];
  readonly author: string;
  readonly preregistered?: boolean;
}

export type DsseSigner = TrustDsseSigner;

export interface ProducedReport {
  readonly record: ReportRecord;
  readonly bytes: Uint8Array;
  readonly envelope: Uint8Array;
}

function computeInputFor(ports: MethodPorts, matrices: readonly MatrixRecord[], parameters: Readonly<Record<string, unknown>>, verdictRule: VerdictRuleName): MethodComputeInput {
  return {
    matrices,
    parameters,
    verdictRule,
    resolveVerdict: ports.resolveVerdict,
    registry: ports.registry,
    ...(ports.resolveClusterKey === undefined ? {} : { resolveClusterKey: ports.resolveClusterKey }),
    ...(ports.resolveTaskTimestamp === undefined ? {} : { resolveTaskTimestamp: ports.resolveTaskTimestamp }),
    ...(ports.rng === undefined ? {} : { rng: ports.rng }),
  };
}

/**
 * Computes `results` via the registry, carries the subject matrices' `disclosures` whole, seals
 * the raw-JCS record bytes via `records`' `sealReport` (no second serializer, program §7.4
 * Delivery-sealing precedent), and DSSE-signs those exact bytes via the injected `DsseSigner`
 * (trust-core's PAE + envelope primitives — program §7.15: `task-execution-protocol` exports no
 * PAE/envelope; that machinery is trust-core's).
 */
export async function produceReport(input: ProduceReportInput, signer: DsseSigner): Promise<ProducedReport> {
  const method: Method | undefined = input.registry.get(input.method.id, input.method.version);
  if (method === undefined) {
    throw new Error(`produceReport: method ${input.method.id}@${input.method.version} is not registered`);
  }
  if (method.computeAvailability !== "available" || method.compute === undefined) {
    throw new Error(`produceReport: method ${input.method.id}@${input.method.version} is unavailable`);
  }
  const parameters = { ...input.method.parameters, verdictRule: input.verdictRule };
  const results = method.compute(computeInputFor(input, input.subjects, parameters, input.verdictRule));
  const derivedDisclosures = deriveDisclosures(input.subjects);
  if (input.disclosures !== undefined && !deepEqual(input.disclosures, derivedDisclosures)) {
    throw new Error("produceReport: disclosures must be derived faithfully from the subject matrices");
  }
  const disclosures = derivedDisclosures;

  const subjects = input.subjects.map((matrix) => ({
    digest: { sha256: stripSha256Prefix(sealMatrix(matrix).digest) },
  }));

  const document: Record<string, unknown> = {
    protocol: BENCHMARKING_PROTOCOL,
    subjects,
    method: { id: input.method.id, version: input.method.version, parameters },
    results,
    disclosures,
    author: input.author,
    ...(input.preregistered === undefined ? {} : { preregistered: input.preregistered }),
    ...(input.limitations === undefined ? {} : { limitations: input.limitations }),
  };

  const sealed = sealReport(document);
  const preAuthEncoding = dssePreAuthEncoding(REPORT_MEDIA_TYPE, sealed.bytes);
  const signatures = await signer({ payloadType: REPORT_MEDIA_TYPE, payloadBytes: sealed.bytes, preAuthEncoding });
  const envelope = sealDsseEnvelope({ payloadBytes: sealed.bytes, signatures, payloadType: REPORT_MEDIA_TYPE });
  const record = parseReport(sealed.bytes);
  return { record, bytes: sealed.bytes, envelope };
}

export type VerifyReportCheck = "report-recompute" | "benchmark-comparability" | "disclosures-faithfulness";
export type VerifyReportResult = { ok: true } | { ok: false; check: VerifyReportCheck; detail: string };

export interface VerifyReportPorts extends MethodPorts {
  /** Resolves each subject Matrix's owning Run's Benchmark digest (§6.2/§9/§12.1
   * `benchmark-comparability`) — required, since a Report cannot be honestly verified without
   * knowing whether its subjects share one Benchmark. */
  readonly resolveBenchmarkDigest: (runDigest: string) => string | undefined;
}

/**
 * `report-recompute` (§12.1): `results` reproduce from matrix + referenced verdict records +
 * method id + parameters; enforces `benchmark-comparability` and disclosures faithfulness.
 */
export function verifyReport(
  record: ReportRecord,
  subjects: readonly MatrixRecord[],
  ports: VerifyReportPorts,
): VerifyReportResult {
  const sealedSubjectDigests = record.subjects.map((subject) => subject.digest?.sha256);
  const providedSubjectDigests = subjects.map((matrix) => stripSha256Prefix(sealMatrix(matrix).digest));
  if (
    sealedSubjectDigests.length !== providedSubjectDigests.length
    || sealedSubjectDigests.some((digest, index) => digest !== providedSubjectDigests[index])
  ) {
    return { ok: false, check: "report-recompute", detail: "provided subjects do not match the sealed Report subjects" };
  }

  const method = ports.registry.get(record.method.id, record.method.version);
  if (method === undefined) {
    return { ok: false, check: "report-recompute", detail: `method ${record.method.id}@${record.method.version} is not registered` };
  }
  if (method.computeAvailability !== "available" || method.compute === undefined) {
    return { ok: false, check: "report-recompute", detail: `method ${record.method.id}@${record.method.version} is unavailable` };
  }
  const benchmarkDigests = subjects.map((matrix) => {
    const runDigest = matrix.run.digest?.["sha256"];
    const benchmarkDigest = runDigest === undefined ? undefined : ports.resolveBenchmarkDigest(runDigest);
    return { benchmarkDigest: benchmarkDigest ?? "unresolved" };
  });
  const comparability = checkComparability(benchmarkDigests, { versionRobust: method.versionRobust });
  if (!comparability.ok) {
    return {
      ok: false,
      check: "benchmark-comparability",
      detail: `subjects resolve to ${comparability.digests.length} distinct Benchmark digests: ${comparability.digests.join(", ")}`,
    };
  }

  const verdictRuleParam = record.method.parameters["verdictRule"];
  if (typeof verdictRuleParam !== "string" || !["sole", "unanimous", "any-pass", "majority"].includes(verdictRuleParam)) {
    return { ok: false, check: "report-recompute", detail: "method.parameters.verdictRule is missing or invalid" };
  }
  const verdictRule = verdictRuleParam as VerdictRuleName;
  const recomputed = method.compute(computeInputFor(ports, subjects, record.method.parameters, verdictRule));
  if (!deepEqual(recomputed, record.results)) {
    return { ok: false, check: "report-recompute", detail: "recomputed results do not match the sealed record's results" };
  }

  const recomputedDisclosures = deriveDisclosures(subjects);
  if (!deepEqual(recomputedDisclosures, record.disclosures)) {
    return { ok: false, check: "disclosures-faithfulness", detail: "recomputed disclosures do not match the sealed record's disclosures" };
  }

  return { ok: true };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export type { DsseProducedSignature };
