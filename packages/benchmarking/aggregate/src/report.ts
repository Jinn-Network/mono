import {
  BENCHMARKING_PROTOCOL,
  BENCHMARKING_REPORTS_SCOPE,
  isCalendarStrictRfc3339,
  REPORT_MEDIA_TYPE,
  parseMatrix,
  parseReport,
  sealMatrix,
  sealReport,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import {
  canonicalJsonBytes,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  recordDigest,
  sealDsseEnvelope,
  verifyEnvelopeBinding,
  type DsseProducedSignature,
  type DsseSigner as TrustDsseSigner,
  type VerifyEnvelopeBindingDeps,
} from "@jinn-network/trust-core";
import type {
  AnchoredBenchmarkAnnouncementVerifier,
  Method,
  MethodComputeInput,
  MethodRegistry,
  VerdictRuleName,
} from "./method.js";
import { matrixRunDigest, resolveRun } from "./resolved-inputs.js";

/** `ReportRecord["disclosures"]` is optional at the schema-type level (superRefine enforces
 * presence at runtime); this package always builds/verifies the non-optional shape. */
export type Disclosures = NonNullable<ReportRecord["disclosures"]>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function stripSha256Prefix(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

interface ExactMatrixSubject {
  readonly bytes: Uint8Array;
  readonly record: MatrixRecord;
  readonly digest: `sha256:${string}`;
}

function parseExactMatrix(bytes: Uint8Array): ExactMatrixSubject {
  const digest = recordDigest(bytes);
  let record: MatrixRecord;
  try {
    record = parseMatrix(bytes);
  } catch (cause) {
    throw new Error(`subject ${digest} is not a valid Matrix: ${String(cause)}`);
  }
  if (!bytesEqual(bytes, sealMatrix(record).bytes)) {
    throw new Error(`subject ${digest} is not the exact canonical Matrix encoding`);
  }
  return { bytes, record, digest };
}

/**
 * Derives lossless one-to-one Report disclosures from exact canonical subject bytes. No counts,
 * floors, arm IDs, run outcomes, or flags are merged across subjects.
 */
export function deriveDisclosures(subjectBytes: readonly Uint8Array[]): Disclosures {
  return {
    perSubject: subjectBytes.map((bytes) => {
      const subject = parseExactMatrix(bytes);
      const matrix = subject.record;
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
        subjectSha256: stripSha256Prefix(subject.digest),
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
  readonly resolveVerdictBytes: (verdictDigest: string) => Uint8Array | undefined;
  readonly resolveRunBytes: (runDigest: string) => Uint8Array | undefined;
  readonly resolveTaskBytes: (taskDigest: string) => Uint8Array | undefined;
  readonly resolveAnchoredBenchmarkAnnouncement?: (benchmarkDigest: string) => Uint8Array | undefined;
  readonly verifyAnchoredBenchmarkAnnouncement?: AnchoredBenchmarkAnnouncementVerifier;
  readonly registry: MethodRegistry;
}

export interface ProduceReportInput extends MethodPorts {
  /** Exact canonical Matrix bytes, in Report subject order. */
  readonly subjects: readonly Uint8Array[];
  readonly method: {
    readonly id: string;
    readonly version: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
  readonly verdictRule: VerdictRuleName;
  readonly disclosures?: Disclosures;
  readonly limitations?: readonly string[];
  readonly author: string;
}

export type DsseSigner = TrustDsseSigner;

export interface ProducedReport {
  readonly record: ReportRecord;
  readonly bytes: Uint8Array;
  readonly envelope: Uint8Array;
}

function computeInputFor(
  ports: MethodPorts,
  exactSubjects: readonly ExactMatrixSubject[],
  parameters: Readonly<Record<string, unknown>>,
  verdictRule: VerdictRuleName,
): MethodComputeInput {
  return {
    subjects: exactSubjects.map((subject) => ({
      subjectSha256: stripSha256Prefix(subject.digest),
      matrix: subject.record,
    })),
    parameters,
    verdictRule,
    resolveVerdictBytes: ports.resolveVerdictBytes,
    resolveRunBytes: ports.resolveRunBytes,
    resolveTaskBytes: ports.resolveTaskBytes,
    registry: ports.registry,
    ...(ports.resolveAnchoredBenchmarkAnnouncement === undefined
      ? {}
      : { resolveAnchoredBenchmarkAnnouncement: ports.resolveAnchoredBenchmarkAnnouncement }),
    ...(ports.verifyAnchoredBenchmarkAnnouncement === undefined
      ? {}
      : { verifyAnchoredBenchmarkAnnouncement: ports.verifyAnchoredBenchmarkAnnouncement }),
  };
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  try {
    return bytesEqual(canonicalJsonBytes(left), canonicalJsonBytes(right));
  } catch {
    return false;
  }
}

function resolvedRuns(
  matrices: readonly MatrixRecord[],
  ports: Pick<MethodPorts, "resolveRunBytes">,
): RunRecord[] {
  return matrices.map((matrix) => resolveRun(matrixRunDigest(matrix), ports as MethodPorts));
}

function derivePreregistered(
  runs: readonly RunRecord[],
  method: { readonly id: string; readonly version: string; readonly parameters: Readonly<Record<string, unknown>> },
): boolean {
  return runs.length > 0 && runs.every((run) => (run.analysisPlan ?? []).some((entry) =>
    entry.method === method.id
    && entry.version === method.version
    && exactJsonEqual(entry.parameters, method.parameters)));
}

function perSubjectPairingTaskDigests(
  results: unknown,
  subjectSha256s: readonly string[],
): string[][] | undefined {
  if (typeof results !== "object" || results === null) return undefined;
  const perSubject = (results as Record<string, unknown>)["perSubject"];
  if (!Array.isArray(perSubject) || perSubject.length !== subjectSha256s.length) return undefined;
  const pairings: string[][] = [];
  for (const [index, entry] of perSubject.entries()) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const subject = entry as Record<string, unknown>;
    if (subject["subjectSha256"] !== subjectSha256s[index]) return undefined;
    const subjectResults = subject["results"];
    if (typeof subjectResults !== "object" || subjectResults === null) return undefined;
    const pairing = (subjectResults as Record<string, unknown>)["pairing"];
    if (typeof pairing !== "object" || pairing === null) return undefined;
    const taskDigests = (pairing as Record<string, unknown>)["taskDigests"];
    if (
      !Array.isArray(taskDigests)
      || taskDigests.some((digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    ) {
      return undefined;
    }
    pairings.push(taskDigests as string[]);
  }
  return pairings;
}

function checkResolvedComparability(
  matrices: readonly MatrixRecord[],
  runs: readonly RunRecord[],
  method: Method,
  results: unknown,
): { ok: true } | { ok: false; detail: string } {
  const benchmarkDigests = [...new Set(runs.map((run) => `sha256:${run.benchmark.digest.sha256}`))];
  if (benchmarkDigests.length <= 1) return { ok: true };
  if (!method.versionRobust) {
    return {
      ok: false,
      detail: `subjects resolve to distinct Benchmark digests: ${benchmarkDigests.sort().join(", ")}`,
    };
  }
  const subjectSha256s = matrices.map((matrix) => sealMatrix(matrix).digest.slice("sha256:".length));
  const pairings = perSubjectPairingTaskDigests(results, subjectSha256s);
  if (pairings === undefined) {
    return { ok: false, detail: "version-robust result does not disclose exact paired Task digests" };
  }
  const pairing = pairings[0] ?? [];
  if (pairing.length === 0) {
    return {
      ok: false,
      detail: "version-robust cross-Benchmark result has no exact shared Task-digest pairing",
    };
  }
  const sortedPairing = [...pairing].sort();
  if (
    new Set(pairing).size !== pairing.length
    || pairing.some((digest, index) => digest !== sortedPairing[index])
  ) {
    return { ok: false, detail: "version-robust pairing must be unique and code-unit sorted" };
  }
  if (pairings.some((candidate) =>
    candidate.length !== pairing.length
    || candidate.some((digest, index) => digest !== pairing[index])
  )) {
    return {
      ok: false,
      detail: "version-robust cross-Benchmark results must disclose one identical Task-digest pairing per subject",
    };
  }
  const perSubjectTasks = matrices.map(
    (matrix) => new Set(matrix.cells.map((cell) => cell.taskDigest)),
  );
  if (pairing.some((digest) => perSubjectTasks.some((tasks) => !tasks.has(digest)))) {
    return {
      ok: false,
      detail: "version-robust pairing includes a Task digest not shared by every subject",
    };
  }
  return { ok: true };
}

function resolveAvailableMethod(
  registry: MethodRegistry,
  ref: { readonly id: string; readonly version: string },
): Method {
  const method = registry.get(ref.id, ref.version);
  if (method === undefined) {
    throw new Error(`method ${ref.id}@${ref.version} is not registered`);
  }
  if (method.computeAvailability !== "available" || method.compute === undefined) {
    throw new Error(`method ${ref.id}@${ref.version} is unavailable`);
  }
  return method;
}

/**
 * Computes results from exact subject/reference bytes, derives disclosures and universal
 * preregistration, seals the raw canonical Report payload, and signs those exact payload bytes.
 */
export async function produceReport(
  input: ProduceReportInput,
  signer: DsseSigner,
): Promise<ProducedReport> {
  const method = resolveAvailableMethod(input.registry, input.method);
  if (
    Object.hasOwn(input.method.parameters, "verdictRule")
    && input.method.parameters["verdictRule"] !== input.verdictRule
  ) {
    throw new Error("produceReport: method.parameters.verdictRule conflicts with verdictRule");
  }
  const parameters = { ...input.method.parameters, verdictRule: input.verdictRule };
  const validation = method.validateParameters(parameters);
  if (!validation.ok) {
    throw new Error(`produceReport: invalid method parameters: ${validation.issues.join("; ")}`);
  }
  const exactSubjects = input.subjects.map(parseExactMatrix);
  const matrices = exactSubjects.map((subject) => subject.record);
  const runs = resolvedRuns(matrices, input);
  const results = method.compute!(computeInputFor(input, exactSubjects, parameters, input.verdictRule));
  const comparability = checkResolvedComparability(matrices, runs, method, results);
  if (!comparability.ok) {
    throw new Error(`produceReport: benchmark-comparability: ${comparability.detail}`);
  }

  const derivedDisclosures = deriveDisclosures(input.subjects);
  if (input.disclosures !== undefined && !exactJsonEqual(input.disclosures, derivedDisclosures)) {
    throw new Error("produceReport: disclosures must be derived faithfully from exact subject bytes");
  }
  const methodTuple = { id: input.method.id, version: input.method.version, parameters };
  const preregistered = derivePreregistered(runs, methodTuple);
  const document: Record<string, unknown> = {
    protocol: BENCHMARKING_PROTOCOL,
    subjects: exactSubjects.map((subject) => ({
      digest: { sha256: stripSha256Prefix(subject.digest) },
    })),
    method: methodTuple,
    preregistered,
    results,
    disclosures: derivedDisclosures,
    author: input.author,
    ...(input.limitations === undefined ? {} : { limitations: input.limitations }),
  };

  const sealed = sealReport(document);
  const preAuthEncoding = dssePreAuthEncoding(REPORT_MEDIA_TYPE, sealed.bytes);
  const signatures = await signer({
    payloadType: REPORT_MEDIA_TYPE,
    payloadBytes: sealed.bytes,
    preAuthEncoding,
  });
  const envelope = sealDsseEnvelope({
    payloadBytes: sealed.bytes,
    signatures,
    payloadType: REPORT_MEDIA_TYPE,
  });
  return { record: parseReport(sealed.bytes), bytes: sealed.bytes, envelope };
}

export type VerifyReportCheck =
  | "report-envelope"
  | "report-authenticity"
  | "report-recompute"
  | "benchmark-comparability"
  | "preregistration"
  | "disclosures-faithfulness";
export type VerifyReportResult =
  | { ok: true; record: ReportRecord }
  | { ok: false; check: VerifyReportCheck; detail: string };

export interface VerifyReportInput {
  readonly envelopeBytes: Uint8Array;
  readonly subjects: readonly Uint8Array[];
  /** Explicit verification evaluation instant. Report has no sealed timestamp; this is context. */
  readonly effectiveTime: string;
}

export interface VerifyReportPorts extends MethodPorts {
  readonly trust: VerifyEnvelopeBindingDeps;
}

/**
 * Verifies from exact received bytes: DSSE media/payload/signature/trust, exact subject bytes and
 * order, method replay, resolved comparability, universal preregistration, and disclosures.
 */
export async function verifyReport(
  input: VerifyReportInput,
  ports: VerifyReportPorts,
): Promise<VerifyReportResult> {
  if (!isCalendarStrictRfc3339(input.effectiveTime)) {
    return {
      ok: false,
      check: "report-authenticity",
      detail: "effectiveTime context must be an explicit RFC 3339 verification instant",
    };
  }
  let envelope: ReturnType<typeof parseDsseEnvelope>;
  try {
    envelope = parseDsseEnvelope(input.envelopeBytes);
  } catch (cause) {
    return { ok: false, check: "report-envelope", detail: `invalid DSSE envelope: ${String(cause)}` };
  }
  if (envelope.payloadType !== REPORT_MEDIA_TYPE) {
    return {
      ok: false,
      check: "report-envelope",
      detail: `payloadType must be ${REPORT_MEDIA_TYPE}`,
    };
  }
  let record: ReportRecord;
  try {
    record = parseReport(envelope.payloadBytes);
    if (!bytesEqual(envelope.payloadBytes, sealReport(record).bytes)) {
      return {
        ok: false,
        check: "report-envelope",
        detail: "Report payload bytes are not the exact canonical encoding",
      };
    }
  } catch (cause) {
    return { ok: false, check: "report-envelope", detail: `invalid Report payload: ${String(cause)}` };
  }

  const signerKeys = [...new Set(
    envelope.signatures
      .map((signature) => signature.keyid)
      .filter((keyid): keyid is string => keyid !== undefined),
  )];
  if (signerKeys.length === 0) {
    return {
      ok: false,
      check: "report-authenticity",
      detail: "Report envelope has no signer keyid to bind to author",
    };
  }
  let trusted = false;
  const trustFailures: string[] = [];
  for (const key of signerKeys) {
    // eslint-disable-next-line no-await-in-loop -- signer lists are tiny and deterministic.
    const outcome = await verifyEnvelopeBinding(
      {
        envelopeBytes: input.envelopeBytes,
        key,
        agent: record.author,
        family: BENCHMARKING_REPORTS_SCOPE,
        atTime: input.effectiveTime,
      },
      ports.trust,
    );
    if (outcome.ok) {
      trusted = true;
      break;
    }
    trustFailures.push(`${key}:${outcome.reason ?? "unknown"}`);
  }
  if (!trusted) {
    return {
      ok: false,
      check: "report-authenticity",
      detail: `no valid signer binds to author/scope/time: ${trustFailures.join(", ")}`,
    };
  }

  let exactSubjects: ExactMatrixSubject[];
  try {
    exactSubjects = input.subjects.map(parseExactMatrix);
  } catch (cause) {
    return { ok: false, check: "report-recompute", detail: String(cause) };
  }
  const sealedSubjectDigests = record.subjects.map((subject) => subject.digest.sha256);
  const providedSubjectDigests = exactSubjects.map((subject) => stripSha256Prefix(subject.digest));
  if (
    sealedSubjectDigests.length !== providedSubjectDigests.length
    || sealedSubjectDigests.some((digest, index) => digest !== providedSubjectDigests[index])
  ) {
    return {
      ok: false,
      check: "report-recompute",
      detail: "exact subject bytes/order do not match the sealed Report subjects",
    };
  }

  let method: Method;
  try {
    method = resolveAvailableMethod(ports.registry, record.method);
  } catch (cause) {
    return { ok: false, check: "report-recompute", detail: String(cause) };
  }
  const verdictRuleParam = record.method.parameters["verdictRule"];
  if (
    typeof verdictRuleParam !== "string"
    || !["sole", "unanimous", "any-pass", "majority"].includes(verdictRuleParam)
  ) {
    return {
      ok: false,
      check: "report-recompute",
      detail: "method.parameters.verdictRule is missing or invalid",
    };
  }
  const parameterValidation = method.validateParameters(record.method.parameters);
  if (!parameterValidation.ok) {
    return {
      ok: false,
      check: "report-recompute",
      detail: `invalid method parameters: ${parameterValidation.issues.join("; ")}`,
    };
  }
  const matrices = exactSubjects.map((subject) => subject.record);
  let runs: RunRecord[];
  let recomputed: unknown;
  try {
    runs = resolvedRuns(matrices, ports);
    recomputed = method.compute!(
      computeInputFor(ports, exactSubjects, record.method.parameters, verdictRuleParam as VerdictRuleName),
    );
  } catch (cause) {
    return { ok: false, check: "report-recompute", detail: String(cause) };
  }
  const comparability = checkResolvedComparability(matrices, runs, method, recomputed);
  if (!comparability.ok) {
    return { ok: false, check: "benchmark-comparability", detail: comparability.detail };
  }
  if (!exactJsonEqual(recomputed, record.results)) {
    return {
      ok: false,
      check: "report-recompute",
      detail: "recomputed results do not match the sealed Report results",
    };
  }

  const preregistered = derivePreregistered(runs, record.method);
  if ((record.preregistered ?? false) !== preregistered) {
    return {
      ok: false,
      check: "preregistration",
      detail: `sealed preregistered=${String(record.preregistered)} but exact resolved Runs derive ${preregistered}`,
    };
  }
  const recomputedDisclosures = deriveDisclosures(input.subjects);
  if (!exactJsonEqual(recomputedDisclosures, record.disclosures)) {
    return {
      ok: false,
      check: "disclosures-faithfulness",
      detail: "recomputed per-subject disclosures do not match the exact subject bytes/order",
    };
  }
  return { ok: true, record };
}

export type { DsseProducedSignature };
