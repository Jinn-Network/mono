import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_RECORD_KIND,
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

/**
 * Maps benchmark-specific closure into the neutral coordinator's exact-byte DAG. The execution
 * coordinator remains responsible for durable stores, authority proof, mirrors, and recovery.
 */
export function buildBenchmarkPublicationPlan(input: BenchmarkPublicationPlanInput): PublicationPlan {
  if (input.registration.length === 0) throw new Error("registration requires at least one member");
  const run = input.registration.find((candidate) => candidate.id === input.runId);
  if (run === undefined || !hasKind(run) || run.kind !== RUN_RECORD_KIND) throw new Error("runId must identify the Run registration record");
  if (input.accounting.accounting.kind !== BENCHMARK_ACCOUNTING_RECORD_KIND) throw new Error("accounting stage must contain BenchmarkAccounting");
  if (input.accounting.matrix.kind !== MATRIX_RECORD_KIND) throw new Error("accounting stage must contain Matrix");
  if (input.report?.record.kind !== undefined && input.report.record.kind !== REPORT_V2_RECORD_KIND) throw new Error("report stage accepts only signed Report v2");
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
