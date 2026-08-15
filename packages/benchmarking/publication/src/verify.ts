import {
  checkPublicRegistrationOrder,
  cellIdempotencyKey,
  compareCodeUnitStrings,
  documentDigest,
  parseCellKey,
  type BenchmarkAccountingRecord,
} from "@jinn-network/benchmarking-records";
import { SubmissionRecordSchema, sealSubmission } from "@jinn-network/task-execution-protocol";
import type { BenchmarkAccountingVerificationInput, NamedPublicationVerification, PublicationCheck, TriState } from "./types.js";

function aggregate(checks: readonly PublicationCheck[]): TriState {
  if (checks.some((check) => check.status === "fail")) return "fail";
  return checks.some((check) => check.status === "indeterminate") ? "indeterminate" : "pass";
}
function check(name: string, condition: boolean, detail: string): PublicationCheck {
  return condition ? { name, status: "pass" } : { name, status: "fail", detail };
}
function descriptorDigests(accounting: BenchmarkAccountingRecord): string[] {
  return accounting.cells.flatMap((cell) => cell.dispatches.flatMap((dispatch) => [
    dispatch.submission.record.digest.sha256,
    ...(dispatch.observations === undefined ? [] : [dispatch.observations.digest.sha256]),
    ...(dispatch.delivery === undefined ? [] : [dispatch.delivery.record.digest.sha256]),
    ...dispatch.evidence.map((reference) => reference.record.digest.sha256),
    ...dispatch.evaluations.map((reference) => reference.record.digest.sha256),
    ...dispatch.correlations.map((reference) => reference.artifact.digest.sha256),
    ...dispatch.nativeArtifacts.flatMap((reference) => reference.artifact === undefined ? [] : [reference.artifact.digest.sha256]),
  ]));
}

function structuralChecks(input: BenchmarkAccountingVerificationInput): PublicationCheck[] {
  const cells = input.accounting.cells.map((cell) => cell.cellKey);
  const expected = [...input.expectedCellKeys].sort(compareCodeUnitStrings);
  const actual = [...cells].sort(compareCodeUnitStrings);
  const checks: PublicationCheck[] = [
    check("expected-cell-completeness", JSON.stringify(expected) === JSON.stringify(actual), "accounting cells do not equal the sealed Run expected-cell set"),
    check("publisher-owner-delegate-structure", input.accounting.publisherAuthority.kind !== "run-owner" || input.accounting.publisher === input.runOwner, "run-owner publisher does not equal Run owner"),
  ];
  for (const cell of input.accounting.cells) {
    checks.push(check("dispatch-index-completeness", cell.dispatches.every((dispatch, index) => dispatch.index === index + 1), `cell ${cell.cellKey} has missing or reordered dispatch indices`));
  }
  return checks;
}

function submissionChecks(input: BenchmarkAccountingVerificationInput): PublicationCheck[] {
  if (input.submissions === undefined) return [{ name: "submission-run-cell-arm-replicate-dispatch-consistency", status: "indeterminate", detail: "exact Submission bytes were not supplied" }];
  const checks: PublicationCheck[] = [];
  for (const cell of input.accounting.cells) for (const dispatch of cell.dispatches) {
    const digest = `sha256:${dispatch.submission.record.digest.sha256}` as const;
    const supplied = input.submissions.get(digest);
    if (supplied === undefined) { checks.push({ name: "submission-run-cell-arm-replicate-dispatch-consistency", status: "indeterminate", detail: `Submission ${digest} is unavailable` }); continue; }
    if (documentDigest(supplied.bytes) !== digest) { checks.push({ name: "submission-reference-digest", status: "fail", detail: `Submission ${digest} bytes do not match their descriptor` }); continue; }
    let submission;
    try {
      submission = SubmissionRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(supplied.bytes)));
      const canonical = sealSubmission(submission);
      if (canonical.length !== supplied.bytes.length || !canonical.every((byte, index) => byte === supplied.bytes[index])) throw new Error("not exact canonical bytes");
    }
    catch { checks.push({ name: "submission-run-cell-arm-replicate-dispatch-consistency", status: "fail", detail: `Submission ${digest} is not structurally valid` }); continue; }
    const annotations = submission.annotations;
    let valid = false;
    try {
      const coordinate = parseCellKey(cell.cellKey);
      const annotatedCoordinate = parseCellKey(String(annotations?.cellKey));
      valid = submission.attempts?.maxTotal === 1 && submission.attempts.maxConcurrent === 1
        && annotations?.run === `sha256:${input.accounting.run.digest.sha256}` && annotations.cellKey === cell.cellKey
        && annotations.armId === coordinate.armId && annotatedCoordinate.armId === coordinate.armId
        && annotatedCoordinate.replicate === coordinate.replicate
        && submission.idempotencyKey === cellIdempotencyKey(`sha256:${input.accounting.run.digest.sha256}`, cell.cellKey, dispatch.index);
    } catch { valid = false; }
    checks.push(check("submission-run-cell-arm-replicate-dispatch-consistency", valid, `Submission ${digest} does not bind one attempt, Run, cell, arm, replicate, and dispatch index`));
  }
  return checks;
}

async function scopeChecks(input: BenchmarkAccountingVerificationInput): Promise<PublicationCheck[]> {
  if (input.scope === undefined) return [{ name: "scope-cutoff-dispatch-completeness", status: "indeterminate", detail: "no authoritative scope enumerator was supplied" }];
  const expected = new Set(input.accounting.cells.flatMap((cell) => cell.dispatches.map((dispatch) => `${cell.cellKey}\u001fsha256:${dispatch.submission.record.digest.sha256}`)));
  const checks: PublicationCheck[] = [];
  const observed = new Set<string>();
  for (const stream of input.accounting.scope.streams) {
    const result = await input.scope.enumerate({ stream, through: stream.through });
    if (result.status !== "complete" || result.dispatches === undefined) { checks.push({ name: "scope-cutoff-dispatch-completeness", status: "indeterminate", detail: result.detail ?? "authoritative stream is unavailable or incomplete" }); continue; }
    for (const dispatch of result.dispatches) observed.add(`${dispatch.cellKey}\u001f${dispatch.submissionDigest}`);
  }
  if (!checks.some((value) => value.status === "indeterminate")) {
    const extra = [...observed].find((dispatch) => !expected.has(dispatch));
    const missing = [...expected].find((dispatch) => !observed.has(dispatch));
    checks.push(extra === undefined && missing === undefined
      ? { name: "scope-cutoff-dispatch-completeness", status: "pass" }
      : { name: "scope-cutoff-dispatch-completeness", status: "fail", detail: extra !== undefined ? `in-scope dispatch ${extra} is omitted from accounting` : `accounted dispatch ${missing} is absent from the authoritative scope` });
  }
  return checks;
}

async function referenceChecks(input: BenchmarkAccountingVerificationInput): Promise<PublicationCheck[]> {
  if (input.references === undefined) return [{ name: "reference-digests-and-artifact-disclosure", status: "indeterminate", detail: "no exact-byte resolver was supplied" }];
  const checks: PublicationCheck[] = [];
  for (const digestHex of descriptorDigests(input.accounting)) {
    const digest = `sha256:${digestHex}` as const;
    const bytes = await input.references.getExact({ digest });
    checks.push(bytes === undefined
      ? { name: "reference-digests-and-artifact-disclosure", status: "indeterminate", detail: `referenced bytes unavailable for ${digest}` }
      : check("reference-digests-and-artifact-disclosure", documentDigest(bytes) === digest, `referenced bytes fail digest ${digest}`));
  }
  for (const dispatch of input.accounting.cells.flatMap((cell) => cell.dispatches)) {
    for (const artifact of dispatch.nativeArtifacts) {
      const valid = artifact.availability === "public" ? artifact.artifact !== undefined : artifact.reason !== undefined && artifact.reason.trim() !== "";
      checks.push(check("reference-digests-and-artifact-disclosure", valid, "native artifact disclosure is incomplete"));
    }
  }
  return checks;
}

/** Tri-state profile verification.  It reports evidence gaps separately instead of claiming a binary verdict. */
export async function verifyBenchmarkAccounting(input: BenchmarkAccountingVerificationInput): Promise<NamedPublicationVerification> {
  const checks = [
    ...structuralChecks(input),
    { name: "public-registration-comparability-and-order", ...checkPublicRegistrationOrder(input.accounting) },
    ...submissionChecks(input),
    ...(await scopeChecks(input)),
    ...(await referenceChecks(input)),
  ];
  if (input.authority !== undefined) checks.push(await input.authority.verify({ publisher: input.accounting.publisher, runOwner: input.runOwner, authority: input.accounting.publisherAuthority, closeAt: input.accounting.closeBoundary.at }));
  else if (input.accounting.publisherAuthority.kind === "authorization") checks.push({ name: "publisher-owner-delegate-structural-authority", status: "indeterminate", detail: "delegate authorization trust resolver was not supplied" });
  return { checks, status: aggregate(checks) };
}
