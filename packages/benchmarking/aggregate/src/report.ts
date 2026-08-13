import {
  BENCHMARK_PUBLICATION_EXTENSION,
  BENCHMARKING_PROTOCOL,
  BENCHMARKING_REPORTS_SCOPE,
  isCalendarStrictRfc3339,
  REPORT_MEDIA_TYPE,
  REPORT_V2_RECORD_KIND,
  SIGNED_REPORT_MEDIA_TYPE,
  checkPublicRegistrationOrder,
  parseBenchmarkAccounting,
  parseMatrix,
  parseReport,
  parseSignedReportRecord,
  readMatrixPublicationExtension,
  sealBenchmarkAccounting,
  sealMatrix,
  sealReport,
  type BenchmarkAccountingRecord,
  type DigestBearingResourceDescriptor,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import {
  canonicalJsonBytes,
  dssePreAuthEncoding,
  parseExactDsseEnvelope,
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
export function deriveDisclosures(
  subjectBytes: readonly Uint8Array[],
  resolveRunBytes: (digest: string) => Uint8Array | undefined,
): Disclosures {
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
      const run = resolveRun(`sha256:${matrix.run.digest.sha256}`, { resolveRunBytes });
      for (const cell of matrix.cells) {
        integrityTiers[cell.integrityTier] += 1;
        for (const axis of pinningAxes) pinning[axis][cell.verification[axis]] += 1;
        if (
          cell.outcome === "judged"
          && run.policy.independence === "disclosed"
          && cell.verification.checksFailed.includes("evaluator-independence")
        ) independence += 1;
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

export type PublicRegistrationStatus = "pre-dispatch" | "post-hoc" | "unverifiable";

export type PublicRegistrationCheck =
  | { readonly status: "pass" }
  | { readonly status: "fail"; readonly detail: string }
  | { readonly status: "indeterminate"; readonly detail: string };

/** The report extension deliberately keeps analysis preregistration and publication timing apart. */
export interface PublicRegistrationDisclosure {
  readonly subjectSha256: string;
  readonly status: PublicRegistrationStatus;
  /** Exact accounting descriptor is the evidence for this independent disclosure. */
  readonly accounting: DigestBearingResourceDescriptor;
  readonly check: PublicRegistrationCheck;
}

export interface ReportPublicationExtension {
  readonly publicRegistration: {
    readonly perSubject: readonly PublicRegistrationDisclosure[];
  };
}

/** Exact accounting bytes are supplied in sealed Report subject order. */
export interface PublicRegistrationInput {
  readonly accountingBytes: readonly Uint8Array[];
  /** Optional caller display data; production refuses any value not derived from accounting. */
  readonly disclosure?: ReportPublicationExtension;
}

export interface ProduceReportV2Input extends ProduceReportInput {
  readonly publicRegistration: PublicRegistrationInput;
}

/** Signed Report v2 keeps the legacy fields while making the two identities explicit. */
export interface ProducedReportV2 extends ProducedReport {
  readonly reportPayloadSha256: string;
  readonly reportRecordSha256: string;
  readonly recordKind: typeof REPORT_V2_RECORD_KIND;
  readonly recordMediaType: typeof SIGNED_REPORT_MEDIA_TYPE;
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

interface ExactAccountingSubject {
  readonly bytes: Uint8Array;
  readonly record: BenchmarkAccountingRecord;
  readonly digest: `sha256:${string}`;
}

function parseExactAccounting(bytes: Uint8Array): ExactAccountingSubject {
  const digest = recordDigest(bytes);
  let record: BenchmarkAccountingRecord;
  try {
    record = parseBenchmarkAccounting(bytes);
  } catch (cause) {
    throw new Error(`accounting ${digest} is not a valid BenchmarkAccounting record: ${String(cause)}`);
  }
  if (!bytesEqual(bytes, sealBenchmarkAccounting(record).bytes)) {
    throw new Error(`accounting ${digest} is not the exact canonical BenchmarkAccounting encoding`);
  }
  return { bytes, record, digest };
}

function derivePublicationExtension(
  exactSubjects: readonly ExactMatrixSubject[],
  publicRegistration: PublicRegistrationInput,
): ReportPublicationExtension {
  if (publicRegistration.accountingBytes.length !== exactSubjects.length) {
    throw new Error("Report v2 publicRegistration.accountingBytes must match the Report subject count and order");
  }
  const perSubject = exactSubjects.map((subject, index) => {
    if (subject.record.assembly.procedure !== "jinn.benchmarking.assembly" || subject.record.assembly.version !== "2.0") {
      throw new Error(`Report v2 subject ${subject.digest} must be a Matrix assembled by jinn.benchmarking.assembly@2.0`);
    }
    let matrixPublication: ReturnType<typeof readMatrixPublicationExtension>;
    try {
      matrixPublication = readMatrixPublicationExtension(subject.record as Record<string, unknown>);
    } catch (cause) {
      throw new Error(`Report v2 subject ${subject.digest} has an invalid benchmark-publication extension: ${String(cause)}`);
    }
    if (matrixPublication === undefined) {
      throw new Error(`Report v2 subject ${subject.digest} is missing its Matrix accounting publication extension`);
    }
    const accounting = parseExactAccounting(publicRegistration.accountingBytes[index]!);
    if (`sha256:${matrixPublication.accounting.digest.sha256}` !== accounting.digest) {
      throw new Error(`Report v2 subject ${subject.digest} Matrix accounting descriptor does not bind the provided exact accounting bytes`);
    }
    if (accounting.record.run.digest.sha256 !== subject.record.run.digest.sha256) {
      throw new Error(`Report v2 subject ${subject.digest} accounting Run does not match the Matrix Run`);
    }
    return {
      subjectSha256: stripSha256Prefix(subject.digest),
      status: accounting.record.publicRegistration.status,
      accounting: matrixPublication.accounting,
      check: checkPublicRegistrationOrder(accounting.record),
    };
  });
  const extension = { publicRegistration: { perSubject } } as const;
  if (
    publicRegistration.disclosure !== undefined
    && !exactJsonEqual(publicRegistration.disclosure, extension)
  ) {
    throw new Error("Report v2 publicRegistration disclosure must be derived faithfully from exact accounting bytes");
  }
  return extension;
}

async function produceReportWithExtension(
  input: ProduceReportInput,
  signer: DsseSigner,
  publicationExtension?: ReportPublicationExtension,
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

  const derivedDisclosures = deriveDisclosures(input.subjects, input.resolveRunBytes);
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
    ...(publicationExtension === undefined ? {} : { [BENCHMARK_PUBLICATION_EXTENSION]: publicationExtension }),
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

/**
 * Computes results from exact subject/reference bytes, derives disclosures and universal
 * preregistration, seals the raw canonical Report payload, and signs those exact payload bytes.
 */
export async function produceReport(
  input: ProduceReportInput,
  signer: DsseSigner,
): Promise<ProducedReport> {
  // Retain v1's raw-payload meaning: it does not inject publication timing or v2 record metadata.
  return produceReportWithExtension(input, signer, undefined);
}

/** Produces the signed Report v2 whose public identity is the exact DSSE envelope digest. */
export async function produceReportV2(
  input: ProduceReportV2Input,
  signer: DsseSigner,
): Promise<ProducedReportV2> {
  const extension = derivePublicationExtension(input.subjects.map(parseExactMatrix), input.publicRegistration);
  const produced = await produceReportWithExtension(input, signer, extension);
  return {
    ...produced,
    reportPayloadSha256: stripSha256Prefix(recordDigest(produced.bytes)),
    reportRecordSha256: stripSha256Prefix(recordDigest(produced.envelope)),
    recordKind: REPORT_V2_RECORD_KIND,
    recordMediaType: SIGNED_REPORT_MEDIA_TYPE,
  };
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

export type VerifyReportV2Check = VerifyReportCheck | "report-record" | "publication-disclosure";
export type VerifyReportV2Result =
  | {
      readonly ok: true;
      readonly record: ReportRecord;
      readonly reportPayloadSha256: string;
      readonly reportRecordSha256: string;
    }
  | { readonly ok: false; readonly check: VerifyReportV2Check; readonly detail: string };

export interface VerifyReportV2Input extends VerifyReportInput {
  /** External record metadata is validated independently from the DSSE payload type. */
  readonly recordKind: string;
  readonly recordMediaType: string;
  readonly publicRegistration: PublicRegistrationInput;
}

/**
 * Verifies from exact received bytes: DSSE media/payload/signature/trust, exact subject bytes and
 * order, method replay, resolved comparability, universal preregistration, and disclosures.
 */
export async function verifyReport(
  input: VerifyReportInput,
  ports: VerifyReportPorts,
): Promise<VerifyReportResult> {
  let envelope: ReturnType<typeof parseExactDsseEnvelope>;
  try {
    envelope = parseExactDsseEnvelope(input.envelopeBytes);
  } catch (cause) {
    return { ok: false, check: "report-envelope", detail: `invalid DSSE envelope: ${String(cause)}` };
  }
  if (!isCalendarStrictRfc3339(input.effectiveTime)) {
    return {
      ok: false,
      check: "report-authenticity",
      detail: "effectiveTime context must be an explicit RFC 3339 verification instant",
    };
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
  let recomputedDisclosures: Disclosures;
  try { recomputedDisclosures = deriveDisclosures(input.subjects, ports.resolveRunBytes); }
  catch (cause) { return { ok: false, check: "disclosures-faithfulness", detail: String(cause) }; }
  if (!exactJsonEqual(recomputedDisclosures, record.disclosures)) {
    return {
      ok: false,
      check: "disclosures-faithfulness",
      detail: "recomputed per-subject disclosures do not match the exact subject bytes/order",
    };
  }
  return { ok: true, record };
}

/**
 * Verifies signed Report v2 without reinterpreting Report v1: the external record is a DSSE
 * envelope, its payload remains exact immutable Report v1 bytes, and publication timing is
 * independently bound through every Matrix v2 accounting extension.
 */
export async function verifyReportV2(
  input: VerifyReportV2Input,
  ports: VerifyReportPorts,
): Promise<VerifyReportV2Result> {
  if (input.recordKind !== REPORT_V2_RECORD_KIND) {
    return {
      ok: false,
      check: "report-record",
      detail: `recordKind must be ${REPORT_V2_RECORD_KIND}`,
    };
  }
  if (input.recordMediaType !== SIGNED_REPORT_MEDIA_TYPE) {
    return {
      ok: false,
      check: "report-record",
      detail: `recordMediaType must be ${SIGNED_REPORT_MEDIA_TYPE}`,
    };
  }
  let signed;
  try {
    signed = parseSignedReportRecord(input.envelopeBytes);
  } catch (cause) {
    return {
      ok: false,
      check: "report-envelope",
      detail: `invalid signed Report v2 envelope: ${String(cause)}`,
    };
  }
  const legacyResult = await verifyReport(input, ports);
  if (!legacyResult.ok) return legacyResult;

  let extension: ReportPublicationExtension;
  try {
    extension = derivePublicationExtension(input.subjects.map(parseExactMatrix), input.publicRegistration);
  } catch (cause) {
    return { ok: false, check: "publication-disclosure", detail: String(cause) };
  }
  const declaredExtension = (signed.payload as Record<string, unknown>)[BENCHMARK_PUBLICATION_EXTENSION];
  if (!exactJsonEqual(declaredExtension, extension)) {
    return {
      ok: false,
      check: "publication-disclosure",
      detail: "sealed Report publicRegistration disclosure does not match exact Matrix/accounting publication evidence",
    };
  }
  return {
    ok: true,
    record: legacyResult.record,
    reportPayloadSha256: stripSha256Prefix(recordDigest(signed.payloadBytes)),
    reportRecordSha256: stripSha256Prefix(signed.recordDigest),
  };
}

export type { DsseProducedSignature };
