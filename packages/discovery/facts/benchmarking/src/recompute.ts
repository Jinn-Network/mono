import {
  BENCHMARK_ACCOUNTING_MEDIA_TYPE,
  REPORT_MEDIA_TYPE,
  SIGNED_REPORT_MEDIA_TYPE,
  parseBenchmarkAccounting,
  parseBenchmark,
  parseMatrix,
  parseReport,
  parseRun,
  parseSignedReportRecord,
  readMatrixPublicationExtension,
  readRunPublicationExtension,
  serializeCanonicalJson,
} from "@jinn-network/benchmarking-records";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import { validateAuthorization } from "@jinn-network/trust-core";
import type {
  FactsRecompute,
  RecordFactRecompute,
  RecordFactValue,
  ReferencedBytes,
} from "@jinn-network/record-discovery-protocol";

import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_RECORD_KIND,
} from "./identifiers.js";

// Record-fact recompute (design §11, program §7.128–§7.130): each function
// recomputes its kind's record facts from the record's own sealed BYTES via
// `@jinn-network/benchmarking-records` parsers — never from a supplied
// projection. Own-record digests use discovery protocol `recordDigest` over
// the exact received bytes. Reference-bearing digests fail closed: emit only
// after `ReferencedBytes.fetch` returns bytes that re-hash to the embedded
// digest and parse as the expected kind; otherwise that field is `undefined`
// (facts-consistency → indeterminate) while native fields still recompute.

function noFacts(): Record<string, never> {
  return {};
}

function asPrefixedDigest(hex: string | undefined): `sha256:${string}` | undefined {
  if (hex === undefined) return undefined;
  return `sha256:${hex}`;
}

async function referencedKindOk(
  refs: ReferencedBytes,
  digest: `sha256:${string}`,
  parse: (bytes: Uint8Array) => unknown,
): Promise<boolean> {
  const bytes = await refs.fetch(digest);
  if (bytes === undefined) return false;
  if (recordDigest(bytes) !== digest) return false;
  try {
    parse(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates an exact referenced authorization record without inferring
 * signature validity or author trust. The Accounting schema pins its declared
 * kind; trust-core validates only the DSSE envelope and authorization payload
 * structure here.
 */
async function referencedAuthorizationOk(
  refs: ReferencedBytes,
  digest: `sha256:${string}`,
): Promise<boolean> {
  const bytes = await refs.fetch(digest);
  return bytes !== undefined && recordDigest(bytes) === digest && validateAuthorization(bytes).conforms;
}

/**
 * Facts profiles can carry only scalars or scalar arrays. Preserve each
 * declared scope stream as one canonical JSON string; its position in this
 * ordered array is its deterministic stream index and retains the complete
 * kind-specific `through` object without lossy projection.
 */
function scopeStreamFacts(streams: readonly unknown[]): string[] {
  return streams.map((stream) => new TextDecoder().decode(serializeCanonicalJson(stream as never)));
}

export const benchmarkRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const record = parseBenchmark(bytes);
    const facts: Record<string, RecordFactValue> = {
      benchmarkDigest: recordDigest(bytes),
      version: record.version,
    };
    if (record.author !== undefined) facts.author = record.author;
    return facts;
  } catch {
    return noFacts();
  }
};

export const runRecompute: RecordFactRecompute = async (bytes, refs) => {
  try {
    const record = parseRun(bytes);
    const facts: Record<string, RecordFactValue> = {
      runDigest: recordDigest(bytes),
      owner: record.owner,
    };
    const benchmarkDigest = asPrefixedDigest(record.benchmark.digest.sha256);
    if (
      benchmarkDigest !== undefined
      && (await referencedKindOk(refs, benchmarkDigest, parseBenchmark))
    ) {
      facts.benchmarkDigest = benchmarkDigest;
    }
    return facts;
  } catch {
    return noFacts();
  }
};

export const matrixRecompute: RecordFactRecompute = async (bytes, refs) => {
  try {
    const record = parseMatrix(bytes);
    const facts: Record<string, RecordFactValue> = {
      matrixDigest: recordDigest(bytes),
      runOutcome: record.completeness.runOutcome,
    };
    const runDigest = asPrefixedDigest(record.run.digest.sha256);
    if (runDigest !== undefined && (await referencedKindOk(refs, runDigest, parseRun))) {
      facts.runDigest = runDigest;
    }
    return facts;
  } catch {
    return noFacts();
  }
};

export const reportRecompute: RecordFactRecompute = async (bytes, refs) => {
  try {
    const record = parseReport(bytes);
    const facts: Record<string, RecordFactValue> = {
      methodId: record.method.id,
      methodVersion: record.method.version,
      author: record.author,
    };
    if (record.preregistered !== undefined) facts.preregistered = record.preregistered;

    const digests: `sha256:${string}`[] = [];
    let allOk = true;
    for (const subject of record.subjects) {
      const digest = asPrefixedDigest(subject.digest.sha256);
      if (digest === undefined || !(await referencedKindOk(refs, digest, parseMatrix))) {
        allOk = false;
        break;
      }
      digests.push(digest);
    }
    if (allOk) facts.matrixDigests = digests;
    return facts;
  } catch {
    return noFacts();
  }
};

/** Facts for the signed Report v2 record, whose identity is the exact DSSE envelope. */
export const signedReportRecompute: RecordFactRecompute = async (bytes, refs) => {
  try {
    const record = parseSignedReportRecord(bytes);
    const facts: Record<string, RecordFactValue> = {
      reportRecordDigest: recordDigest(bytes),
      reportPayloadDigest: recordDigest(record.payloadBytes),
      recordMediaType: SIGNED_REPORT_MEDIA_TYPE,
      payloadMediaType: REPORT_MEDIA_TYPE,
      methodId: record.payload.method.id,
      methodVersion: record.payload.method.version,
      author: record.payload.author,
    };
    if (record.payload.preregistered !== undefined) facts.preregistered = record.payload.preregistered;

    const digests: `sha256:${string}`[] = [];
    let allOk = true;
    for (const subject of record.payload.subjects) {
      const digest = asPrefixedDigest(subject.digest.sha256);
      if (digest === undefined || !(await referencedKindOk(refs, digest, parseMatrix))) {
        allOk = false;
        break;
      }
      digests.push(digest);
    }
    if (allOk) facts.matrixDigests = digests;
    return facts;
  } catch {
    return noFacts();
  }
};

/**
 * Facts for BenchmarkAccounting describe the publisher's declaration, not a
 * completed scope enumeration, signature verification, or publisher trust.
 */
export const benchmarkAccountingRecompute: RecordFactRecompute = async (bytes, refs) => {
  try {
    const record = parseBenchmarkAccounting(bytes);
    const facts: Record<string, RecordFactValue> = {
      accountingDigest: recordDigest(bytes),
      recordMediaType: BENCHMARK_ACCOUNTING_MEDIA_TYPE,
      publisher: record.publisher,
      procedureId: record.procedure.id,
      procedureVersion: record.procedure.version,
      closeAt: record.closeBoundary.at,
      scopeStreamCount: record.scope.streams.length,
      scopeStreams: scopeStreamFacts(record.scope.streams),
      publicRegistrationStatus: record.publicRegistration.status,
      publisherAuthorityKind: record.publisherAuthority.kind,
      cellCount: record.cells.length,
      dispatchCount: record.cells.reduce((count, cell) => count + cell.dispatches.length, 0),
    };
    if (record.closeBoundary.anchor !== undefined) {
      facts.closeAnchorChain = record.closeBoundary.anchor.chain;
      facts.closeAnchorBlockNumber = record.closeBoundary.anchor.blockNumber;
      facts.closeAnchorBlockHash = record.closeBoundary.anchor.blockHash;
    }

    const runDigest = asPrefixedDigest(record.run.digest.sha256);
    if (runDigest !== undefined && (await referencedKindOk(refs, runDigest, parseRun))) {
      facts.runDigest = runDigest;
    }

    if (record.publisherAuthority.kind === "authorization") {
      const authorizationDigest = asPrefixedDigest(record.publisherAuthority.authorization.record.digest.sha256);
      if (authorizationDigest !== undefined && (await referencedAuthorizationOk(refs, authorizationDigest))) {
        facts.publisherAuthorizationDigest = authorizationDigest;
      }
    }
    return facts;
  } catch {
    return noFacts();
  }
};

// --- v2 revisions (join-edge completeness, protocol design §12 amendment 2026-08-28) --------
//
// The added fields point at records this tree cannot parse — Tasks, Submissions, Deliveries and
// verdicts are owned by other trees, and this leaf's frozen dependency set is the benchmarking
// tree plus discovery. So they cannot use the fail-closed `referencedKindOk` path the
// same-tree digests above use; they are emitted directly from the record's own statement, the
// posture the environment leaf documents for its image digest. Reference-bearing labels the
// indexing relation; it does not by itself promise the target is retrievable.

/** Ordered de-duplication: a matrix names the same Task once per cell that ran it. */
function distinct(digests: readonly (`sha256:${string}` | undefined)[]): `sha256:${string}`[] {
  const seen = new Set<string>();
  const out: `sha256:${string}`[] = [];
  for (const digest of digests) {
    if (digest === undefined || seen.has(digest)) continue;
    seen.add(digest);
    out.push(digest);
  }
  return out;
}

/** v1's card plus the Tasks the benchmark is made of and its supersession pointer. */
export const benchmarkRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await benchmarkRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  try {
    const record = parseBenchmark(bytes);
    const taskDigests = distinct(record.items.map((item) => asPrefixedDigest(item.task.digest.sha256)));
    const supersedes = asPrefixedDigest(record.supersedes?.digest.sha256);
    return {
      ...facts,
      taskDigests,
      ...(supersedes === undefined ? {} : { supersedesDigest: supersedes }),
    };
  } catch {
    return noFacts();
  }
};

/**
 * v1's card plus the per-cell references. A matrix is already the join table between a run's
 * cells and the records that produced them; v1 stated only the run, so the join stopped there.
 *
 * `verdictDigests` carries every verdict the cells name. Validity is the matrix's own judgment
 * about a verdict, not an edge to a different record, so it stays in the record.
 */
export const matrixRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await matrixRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  try {
    const record = parseMatrix(bytes);
    // Mandatory for assembly v2 and rejected outright for anything else, so an absent extension
    // means an assembly-v1 matrix, which pins no accounting record and owes the card no edge.
    const accounting = asPrefixedDigest(
      readMatrixPublicationExtension(record)?.accounting.digest.sha256,
    );
    return {
      ...facts,
      taskDigests: distinct(record.cells.map((cell) => asPrefixedDigest(cell.taskDigest))),
      submissionDigests: distinct(record.cells.map((cell) => cell.submission as `sha256:${string}` | undefined)),
      deliveryDigests: distinct(record.cells.map((cell) => cell.delivery as `sha256:${string}` | undefined)),
      verdictDigests: distinct(
        record.cells.flatMap((cell) => cell.verdicts as `sha256:${string}`[]),
      ),
      ...(accounting === undefined ? {} : { accountingDigest: accounting }),
    };
  } catch {
    return noFacts();
  }
};

/**
 * v1's card plus the registration artifacts the Run's publication extension pins. The extension
 * is namespaced but its shape is closed and schema-validated, so `registrationArtifacts` is an
 * enumerable field. An arm's `pinning` map stays outside the rule: its keys are not enumerated
 * by the defining schema, so there is no field for a profile to declare.
 */
export const runRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await runRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  try {
    const record = parseRun(bytes);
    const extension = readRunPublicationExtension(record);
    if (extension === undefined) return facts;
    return {
      ...facts,
      registrationArtifactDigests: distinct(
        extension.registrationArtifacts.map((entry) => asPrefixedDigest(entry.artifact.digest.sha256)),
      ),
    };
  } catch {
    return noFacts();
  }
};

/** The leaf's `FactsRecompute` registry entry (program §7.13): the host
 * assembles the tree-wide registry by merging each leaf's export. Unknown
 * kinds return `undefined` (preserved unknown-kind behavior). */
export const BENCHMARKING_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    switch (kind) {
      case BENCHMARK_RECORD_KIND:
        return benchmarkRecompute;
      case RUN_RECORD_KIND:
        return runRecompute;
      case MATRIX_RECORD_KIND:
        return matrixRecompute;
      case REPORT_RECORD_KIND:
        return reportRecompute;
      case REPORT_V2_RECORD_KIND:
        return signedReportRecompute;
      case BENCHMARK_ACCOUNTING_RECORD_KIND:
        return benchmarkAccountingRecompute;
      default:
        return undefined;
    }
  },
};

/**
 * v1's card plus every record and artifact the cells' dispatches name. An accounting record is a
 * closure claim over dispatches -- the same join-table shape as a Matrix -- so leaving those
 * references off the card left the closure unwalkable from the feed.
 *
 * Cross-tree targets again: emitted from the record's own statement, deduplicated in record order.
 * A native artifact whose availability is not `public` carries no descriptor and contributes no
 * edge; its absence is the record's own statement, not a gap in the card.
 */
export const benchmarkAccountingRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await benchmarkAccountingRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  try {
    const record = parseBenchmarkAccounting(bytes);
    const dispatches = record.cells.flatMap((cell) => cell.dispatches);
    return {
      ...facts,
      submissionDigests: distinct(dispatches.map((d) => asPrefixedDigest(d.submission.record.digest.sha256))),
      deliveryDigests: distinct(dispatches.map((d) => asPrefixedDigest(d.delivery?.record.digest.sha256))),
      evidenceDigests: distinct(
        dispatches.flatMap((d) => d.evidence.map((reference) => asPrefixedDigest(reference.record.digest.sha256))),
      ),
      evaluationDigests: distinct(
        dispatches.flatMap((d) => d.evaluations.map((reference) => asPrefixedDigest(reference.record.digest.sha256))),
      ),
      observationArchiveDigests: distinct(dispatches.map((d) => asPrefixedDigest(d.observations?.digest.sha256))),
      correlationArtifactDigests: distinct(
        dispatches.flatMap((d) => d.correlations.map((correlation) => asPrefixedDigest(correlation.artifact.digest.sha256))),
      ),
      nativeArtifactDigests: distinct(
        dispatches.flatMap((d) => d.nativeArtifacts.map((native) => asPrefixedDigest(native.artifact?.digest.sha256))),
      ),
    };
  } catch {
    return noFacts();
  }
};

/** Explicit registry for the coexisting Benchmarking facts v2 profiles. */
export const BENCHMARKING_FACTS_RECOMPUTE_V2: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    switch (kind) {
      case BENCHMARK_RECORD_KIND:
        return benchmarkRecomputeV2;
      case RUN_RECORD_KIND:
        return runRecomputeV2;
      case MATRIX_RECORD_KIND:
        return matrixRecomputeV2;
      case BENCHMARK_ACCOUNTING_RECORD_KIND:
        return benchmarkAccountingRecomputeV2;
      default:
        return BENCHMARKING_FACTS_RECOMPUTE.get(kind);
    }
  },
};
