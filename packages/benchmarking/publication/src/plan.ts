import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_PUBLICATION_EXTENSION,
  MATRIX_ASSEMBLY_PROCEDURE,
  MATRIX_ASSEMBLY_PROCEDURE_VERSION,
  MATRIX_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_RECORD_KIND,
  parseBenchmarkAccounting,
  parseMatrix,
  parseRun,
  parseSignedReportRecord,
  readMatrixPublicationExtension,
  readRunPublicationExtension,
  serializeCanonicalJson,
} from "@jinn-network/benchmarking-records";
import { sha256, validatePublicationPlan, type PublicationPlan } from "@jinn-network/record-publication";
import type {
  BenchmarkPublicationPlanInput,
  NeutralPublicationMember,
  PublicationArtifactInput,
  PublicationRecordInput,
} from "./types.js";

function hasKind(input: PublicationRecordInput | PublicationArtifactInput): input is PublicationRecordInput { return "kind" in input; }
function requiresDependencies(input: PublicationRecordInput | PublicationArtifactInput, dependencies: readonly string[]): readonly string[] {
  return [...new Set([...(input.dependsOn ?? []), ...dependencies])].sort();
}
function record(input: PublicationRecordInput, dependencies: readonly string[] = []): NeutralPublicationMember {
  if (sha256(input.bytes) !== input.digest) throw new Error(`exact bytes fail digest for ${input.id}`);
  const origin = input.authority.mode === "origin-reference";
  return {
    id: input.id, kind: input.kind, digest: input.digest, bytes: input.bytes, mediaType: input.mediaType,
    authority: origin ? { mode: "origin-reference", origin: input.authority.origin } : { mode: input.authority.mode },
    ...(origin ? { actions: ["verify-origin", ...(input.authority.mirror ? ["mirror" as const] : [])] } : { actions: ["store" as const, "announce" as const], announcementTimestamp: input.announcementTimestamp }),
    dependsOn: requiresDependencies(input, dependencies),
  };
}
function artifact(input: PublicationArtifactInput, dependencies: readonly string[] = []): NeutralPublicationMember {
  if (sha256(input.bytes) !== input.digest) throw new Error(`exact bytes fail digest for ${input.id}`);
  return { id: input.id, role: input.role, digest: input.digest, bytes: input.bytes, mediaType: input.mediaType, actions: [input.mirror ? "mirror" : "store"], dependsOn: requiresDependencies(input, dependencies) };
}
function member(input: PublicationRecordInput | PublicationArtifactInput, dependencies: readonly string[] = []): NeutralPublicationMember {
  return hasKind(input) ? record(input, dependencies) : artifact(input, dependencies);
}
function exactJsonEqual(left: unknown, right: unknown): boolean {
  const leftBytes = serializeCanonicalJson(left as never);
  const rightBytes = serializeCanonicalJson(right as never);
  return leftBytes.length === rightBytes.length && leftBytes.every((byte, index) => byte === rightBytes[index]);
}
function assertExactDigest(input: PublicationRecordInput | PublicationArtifactInput): void {
  if (sha256(input.bytes) !== input.digest) throw new Error(`exact bytes fail digest for ${input.id}`);
}
function digestHex(input: PublicationRecordInput | PublicationArtifactInput): string { return input.digest.slice("sha256:".length); }
function parseSemanticClosure(input: BenchmarkPublicationPlanInput): void {
  const runInput = input.registration.find((candidate) => candidate.id === input.runId);
  if (runInput === undefined || !hasKind(runInput) || runInput.kind !== RUN_RECORD_KIND) throw new Error("runId must identify the Run registration record");
  assertExactDigest(runInput);
  let run;
  try { run = parseRun(runInput.bytes); } catch { throw new Error("Run publication member does not contain exact Run bytes"); }
  const runExtension = readRunPublicationExtension(run);
  for (const required of runExtension?.registrationArtifacts ?? []) {
    const found = input.registration.find((candidate) => !hasKind(candidate)
      && candidate.role === required.role && candidate.digest === `sha256:${required.artifact.digest.sha256}`);
    if (found === undefined) throw new Error(`Run registration artifact ${required.role}/${required.artifact.digest.sha256} is missing from registration`);
    assertExactDigest(found);
  }

  if (input.accounting.accounting.kind !== BENCHMARK_ACCOUNTING_RECORD_KIND) throw new Error("accounting stage must contain BenchmarkAccounting");
  assertExactDigest(input.accounting.accounting);
  let accounting;
  try { accounting = parseBenchmarkAccounting(input.accounting.accounting.bytes); } catch { throw new Error("accounting member does not contain exact BenchmarkAccounting bytes"); }
  if (accounting.run.digest.sha256 !== digestHex(runInput)) throw new Error("BenchmarkAccounting does not bind the selected exact Run");

  if (input.accounting.matrix.kind !== MATRIX_RECORD_KIND) throw new Error("accounting stage must contain Matrix");
  assertExactDigest(input.accounting.matrix);
  let matrix;
  try { matrix = parseMatrix(input.accounting.matrix.bytes); } catch { throw new Error("matrix member does not contain exact Matrix bytes"); }
  if (matrix.assembly.procedure !== MATRIX_ASSEMBLY_PROCEDURE || matrix.assembly.version !== MATRIX_ASSEMBLY_PROCEDURE_VERSION) {
    throw new Error("benchmark publication requires Matrix assembly v2");
  }
  if (matrix.run.digest.sha256 !== digestHex(runInput)) throw new Error("Matrix does not bind the selected exact Run");
  const matrixExtension = readMatrixPublicationExtension(matrix);
  if (matrixExtension?.accounting.digest.sha256 !== digestHex(input.accounting.accounting)) throw new Error("Matrix accounting extension does not bind exact BenchmarkAccounting bytes");
  if (!exactJsonEqual(matrix.closeBoundary, accounting.closeBoundary)) throw new Error("Matrix and BenchmarkAccounting closeBoundary must match exactly");

  if (input.report === undefined) return;
  if (input.report.record.kind !== REPORT_V2_RECORD_KIND) throw new Error("report stage accepts only signed Report v2");
  assertExactDigest(input.report.record);
  let signed;
  try { signed = parseSignedReportRecord(input.report.record.bytes); } catch { throw new Error("report member does not contain an exact signed Report v2 envelope"); }
  if (signed.recordDigest !== input.report.record.digest) throw new Error("signed Report v2 envelope digest does not match its publication descriptor");
  const matrixDigest = digestHex(input.accounting.matrix);
  if (signed.payload.subjects.length !== 1 || signed.payload.subjects[0]!.digest.sha256 !== matrixDigest) {
    throw new Error("signed Report v2 subject must bind the selected exact Matrix");
  }
  const extension = signed.payload[BENCHMARK_PUBLICATION_EXTENSION] as Record<string, unknown> | undefined;
  const publicRegistration = extension?.["publicRegistration"] as Record<string, unknown> | undefined;
  const perSubject = publicRegistration?.["perSubject"];
  if (!Array.isArray(perSubject) || perSubject.length !== 1) throw new Error("signed Report v2 requires one publication disclosure for its Matrix subject");
  const disclosure = perSubject[0] as Record<string, unknown>;
  const accountingDescriptor = disclosure["accounting"] as { digest?: { sha256?: unknown } } | undefined;
  if (disclosure["subjectSha256"] !== matrixDigest || accountingDescriptor?.digest?.sha256 !== digestHex(input.accounting.accounting)) {
    throw new Error("signed Report v2 publication extension does not bind the selected Matrix and BenchmarkAccounting");
  }
  if (disclosure["status"] !== accounting.publicRegistration.status) throw new Error("signed Report v2 publication status does not match BenchmarkAccounting");
}

/**
 * Maps benchmark-specific closure into the neutral coordinator's exact-byte DAG. The execution
 * coordinator remains responsible for durable stores, authority proof, mirrors, and recovery.
 */
export function buildBenchmarkPublicationPlan(input: BenchmarkPublicationPlanInput): PublicationPlan {
  if (input.registration.length === 0) throw new Error("registration requires at least one member");
  parseSemanticClosure(input);
  const registrationIds = input.registration.map((candidate) => candidate.id);
  const registration = input.registration.map((candidate) => member(candidate, candidate.id === input.runId ? registrationIds.filter((id) => id !== input.runId) : []));
  const accountingSupporting = (input.accounting.members ?? []).map((candidate) => member(candidate, [input.runId]));
  const accountingDependencies = [input.runId, ...accountingSupporting.map((candidate) => candidate.id)];
  const accounting = record(input.accounting.accounting, accountingDependencies);
  const matrix = record(input.accounting.matrix, [input.accounting.accounting.id, ...accountingSupporting.map((candidate) => candidate.id)]);
  const accountingMembers = [...accountingSupporting, accounting, matrix];
  const stages: Array<PublicationPlan["stages"][number]> = [{ stage: "registration", members: registration }, { stage: "accounting", members: accountingMembers }];
  if (input.report !== undefined) {
    const supporting = (input.report.members ?? []).map((candidate) => member(candidate, [input.accounting.matrix.id]));
    stages.push({ stage: "report", members: [...supporting, record(input.report.record, [input.accounting.matrix.id, ...supporting.map((candidate) => candidate.id)])] });
  }
  const plan: PublicationPlan = { id: input.id, stages };
  validatePublicationPlan(plan);
  return plan;
}
