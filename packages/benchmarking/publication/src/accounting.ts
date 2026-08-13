import {
  BENCHMARK_ACCOUNTING_PROCEDURE,
  BENCHMARK_ACCOUNTING_PROCEDURE_VERSION,
  BENCHMARKING_PROTOCOL,
  compareCodeUnitStrings,
  sealBenchmarkAccounting,
  type BenchmarkAccountingRecord,
  type SealedRecord,
} from "@jinn-network/benchmarking-records";
import { SubmissionRecordSchema } from "@jinn-network/task-execution-protocol";
import type { AccountingDispatchInput, BenchmarkAccountingBuildInput } from "./types.js";

function decodeSubmission(bytes: Uint8Array) {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("submission bytes are not UTF-8 JSON"); }
  return SubmissionRecordSchema.parse(value);
}
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function validateDispatch(input: BenchmarkAccountingBuildInput, dispatch: AccountingDispatchInput): void {
  const submission = decodeSubmission(dispatch.submissionBytes);
  if (submission.attempts?.maxTotal !== 1 || submission.attempts.maxConcurrent !== 1) throw new Error(`submission ${dispatch.cellKey}/${dispatch.index} must seal one-attempt bounds`);
  const annotations = submission.annotations;
  const runDigest = input.run.digest.sha256;
  if (annotations?.run !== `sha256:${runDigest}` || annotations.cellKey !== dispatch.cellKey) throw new Error(`submission ${dispatch.cellKey}/${dispatch.index} does not bind the Run and cell`);
  const [, armId] = dispatch.cellKey.split("/");
  if (annotations.armId !== armId) throw new Error(`submission ${dispatch.cellKey}/${dispatch.index} arm annotation does not match its cell`);
}

/** Builds and seals exactly one accounting record, while refusing missing expected cells or hidden dispatch identities. */
export function buildBenchmarkAccounting(input: BenchmarkAccountingBuildInput): { readonly record: BenchmarkAccountingRecord; readonly sealed: SealedRecord } {
  if (input.publisherAuthority.kind === "run-owner" && input.publisher !== input.runOwner) {
    throw new Error("run-owner authority requires publisher to equal the sealed Run owner");
  }
  const expected = [...input.expectedCellKeys].sort(compareCodeUnitStrings);
  if (new Set(expected).size !== expected.length || !sameStringSet(expected, input.expectedCellKeys)) {
    throw new Error("expectedCellKeys must be complete, sorted, and unique in code-unit order");
  }
  const grouped = new Map<string, AccountingDispatchInput[]>();
  for (const dispatch of input.dispatches) {
    if (!expected.includes(dispatch.cellKey)) throw new Error(`dispatch belongs to non-expected cell ${dispatch.cellKey}`);
    validateDispatch(input, dispatch);
    const values = grouped.get(dispatch.cellKey) ?? [];
    values.push(dispatch);
    grouped.set(dispatch.cellKey, values);
  }
  const cells = expected.map((cellKey) => ({
    cellKey,
    dispatches: [...(grouped.get(cellKey) ?? [])]
      .sort((left, right) => left.index - right.index)
      .map((dispatch) => ({
        index: dispatch.index,
        submission: dispatch.submission,
        ...(dispatch.attempt === undefined ? {} : { attempt: dispatch.attempt }),
        ...(dispatch.observations === undefined ? {} : { observations: dispatch.observations }),
        ...(dispatch.delivery === undefined ? {} : { delivery: dispatch.delivery }),
        evidence: [...(dispatch.evidence ?? [])], evaluations: [...(dispatch.evaluations ?? [])],
        correlations: [...(dispatch.correlations ?? [])], nativeArtifacts: [...(dispatch.nativeArtifacts ?? [])],
      })),
  }));
  for (const cell of cells) {
    if (cell.dispatches.some((dispatch, index) => dispatch.index !== index + 1)) throw new Error(`dispatch indices for ${cell.cellKey} must begin at one with no gaps`);
  }
  const record: BenchmarkAccountingRecord = {
    protocol: BENCHMARKING_PROTOCOL, run: input.run, publisher: input.publisher,
    publisherAuthority: input.publisherAuthority,
    procedure: { id: BENCHMARK_ACCOUNTING_PROCEDURE, version: BENCHMARK_ACCOUNTING_PROCEDURE_VERSION },
    scope: { streams: [...input.scope] }, publicRegistration: input.publicRegistration as BenchmarkAccountingRecord["publicRegistration"],
    closeBoundary: input.closeBoundary, cells,
  };
  return { record, sealed: sealBenchmarkAccounting(record) };
}
