import {
  parseBenchmark,
  parseMatrix,
  parseReport,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type {
  FactsRecompute,
  RecordFactRecompute,
  RecordFactValue,
  ReferencedBytes,
} from "@jinn-network/record-discovery-protocol";

import {
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
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
      default:
        return undefined;
    }
  },
};
