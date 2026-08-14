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
