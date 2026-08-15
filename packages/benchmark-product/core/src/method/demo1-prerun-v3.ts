import { createHash } from "node:crypto";
import {
  compareCodeUnitStrings,
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import {
  DEMO1_PRE_RUN_FREEZE_SCHEMA,
  authenticateDemo1CandidateInstructionSource,
  buildDemo1PreRunFreeze,
  type Demo1CandidateInput,
  type Demo1Pool,
  type Demo1PreRunFreeze,
  type Demo1PreRunFreezeInput,
  type Demo1TaskEligibilityInput,
} from "./demo1-prerun.js";
import {
  DEMO1_TASK_EVIDENCE_CHECKS,
  DEMO1_TASK_EVIDENCE_SCHEMA,
  canonicalDemo1TaskEvidenceBytes,
  demo1TaskEvidenceDigest,
  verifyDemo1TaskEvidenceArtifact,
  type Demo1TaskEvidenceArtifact,
  type Demo1TaskEvidenceEntry,
} from "./demo1-task-evidence.js";

export const DEMO1_PRE_RUN_FREEZE_V3_SCHEMA = "jinn.demo1.pre-run-freeze.v3" as const;
export const DEMO1_POOL_PARTITION_POLICY = "repository-disjoint-objective-partition@1" as const;

const SHA256 = /^[0-9a-f]{64}$/u;

type CandidateWithoutTasks = Omit<Demo1CandidateInput, "tasks">;
type MethodWithoutCandidates = Omit<Demo1PreRunFreezeInput, "candidates">;

export interface Demo1PreRunFreezeV3Input {
  readonly supersedes: {
    readonly schema: typeof DEMO1_PRE_RUN_FREEZE_SCHEMA;
    readonly sha256: string;
  };
  readonly method: MethodWithoutCandidates;
  readonly candidates: readonly CandidateWithoutTasks[];
  readonly taskEvidence: Demo1TaskEvidenceArtifact;
}

export interface Demo1PreRunFreezeV3SelectedTask {
  readonly taskId: string;
  readonly repository: string;
  readonly taskSha256: string;
  readonly selectionRankSha256: string;
}

interface Demo1PreRunFreezeV3Partition {
  readonly suitability: readonly Demo1PreRunFreezeV3SelectedTask[];
  readonly rehearsal: readonly Demo1PreRunFreezeV3SelectedTask[];
  readonly officialFeasibility: readonly Demo1PreRunFreezeV3SelectedTask[];
  readonly officialTaskOrder: readonly Demo1PreRunFreezeV3SelectedTask[];
}

export interface Demo1PreRunFreezeV3CandidateInventory {
  readonly repositoryPath: string;
  readonly sourceEligible: boolean;
  readonly sourceRejectionReasons: readonly string[];
  readonly taskEvidencePresent: boolean;
  readonly domainCompatibleTaskCount: number;
  readonly domainCompatibleRepositoryCount: number;
  readonly fullyEligibleTaskCount: number;
  readonly fullyEligibleRepositoryCount: number;
  readonly staticCapacityPossible: boolean;
  readonly preE2Ready: boolean;
  readonly rejectionReasons: readonly string[];
  readonly selectedPools: null | Demo1PreRunFreezeV3Partition;
}

export interface Demo1PreRunFreezeV3 {
  readonly schema: typeof DEMO1_PRE_RUN_FREEZE_V3_SCHEMA;
  readonly inputs: Demo1PreRunFreezeV3Input;
  readonly derived: {
    readonly status: "ready" | "stop";
    readonly taskEvidenceSha256: string;
    readonly selectionBasisSha256: string;
    readonly seeds: {
      readonly procedure: "sha256-first-u32be-nonzero@1";
      readonly taskSelection: number;
    };
    readonly poolPartitionPolicy: typeof DEMO1_POOL_PARTITION_POLICY;
    readonly candidates: readonly Demo1PreRunFreezeV3CandidateInventory[];
    readonly ranking: readonly {
      readonly repositoryPath: string;
      readonly fullyEligibleTaskCount: number;
    }[];
    readonly winner: null | (NonNullable<Demo1PreRunFreeze["derived"]["winner"]> & {
      readonly taskEvidenceSha256: string;
      readonly poolPartitionPolicy: typeof DEMO1_POOL_PARTITION_POLICY;
    });
    readonly stopReasons: readonly string[];
  };
  readonly execution: {
    readonly modelArms: 0;
    readonly previews: 0;
    readonly dockerControls: number;
    readonly rehearsalCells: 0;
    readonly officialCells: 0;
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalBytes(left)).equals(Buffer.from(canonicalBytes(right)));
}

function seedFromBasis(basis: string): number {
  const bytes = createHash("sha256")
    .update(`jinn.demo1.pre-run-v3-seed@1\u0000task-selection\u0000${basis}`, "utf8")
    .digest();
  return bytes.readUInt32BE(0) || 1;
}

function rank(seed: number, candidate: string, repository: string, taskId = ""): string {
  return sha256(`jinn.demo1.pre-run-v3-rank@1\u0000${seed}\u0000${candidate}\u0000${repository}\u0000${taskId}`);
}

function selectTasks(
  entries: readonly Demo1TaskEvidenceEntry[],
  count: number,
  repositories: readonly string[],
  seed: number,
  candidate: string,
): null | Demo1PreRunFreezeV3SelectedTask[] {
  const allowed = new Set(repositories);
  const ranked = entries.filter((entry) => allowed.has(entry.repository))
    .map((entry) => ({ entry, rank: rank(seed, candidate, entry.repository, entry.taskId) }))
    .sort((left, right) => compareCodeUnitStrings(left.rank, right.rank)
      || compareCodeUnitStrings(left.entry.taskId, right.entry.taskId));
  const first = repositories.map((repository) => ranked.find((item) => item.entry.repository === repository));
  if (first.some((item) => item === undefined) || ranked.length < count) return null;
  const selected = first as Array<typeof ranked[number]>;
  const seen = new Set(selected.map((item) => item.entry.taskId));
  for (const item of ranked) {
    if (selected.length >= count) break;
    if (!seen.has(item.entry.taskId)) {
      selected.push(item);
      seen.add(item.entry.taskId);
    }
  }
  if (selected.length !== count) return null;
  return selected.map(({ entry, rank: selectionRankSha256 }) => ({
    taskId: entry.taskId,
    repository: entry.repository,
    taskSha256: entry.taskSha256,
    selectionRankSha256,
  })).sort((left, right) => compareCodeUnitStrings(left.selectionRankSha256, right.selectionRankSha256)
    || compareCodeUnitStrings(left.taskId, right.taskId));
}

/**
 * Partitions tasks without a caller-provided pool label. Repositories are indivisible. The
 * official pair uses the lowest-capacity qualifying pair that still leaves a feasible rehearsal;
 * this conserves the broadest repositories for the ten-task rehearsal while remaining fully
 * deterministic and outcome blind.
 */
function partitionTasks(
  entries: readonly Demo1TaskEvidenceEntry[],
  seed: number,
  candidate: string,
  requirements: Demo1PreRunFreezeInput["poolRequirements"],
): null | Demo1PreRunFreezeV3Partition {
  const byRepository = new Map<string, Demo1TaskEvidenceEntry[]>();
  for (const entry of entries) {
    const rows = byRepository.get(entry.repository) ?? [];
    rows.push(entry);
    byRepository.set(entry.repository, rows);
  }
  const repositories = [...byRepository].map(([repository, rows]) => ({
    repository,
    count: rows.length,
    rank: rank(seed, candidate, repository),
  }));
  const requiredRepositories = requirements.suitability.repositories
    + requirements.rehearsal.repositories
    + requirements.officialFeasibilityFloor.repositories;
  const requiredTasks = requirements.suitability.tasks
    + requirements.rehearsal.tasks
    + requirements.officialFeasibilityFloor.tasks;
  if (repositories.length < requiredRepositories || entries.length < requiredTasks) return null;

  const officialPairs: Array<{ repositories: readonly string[]; count: number; rank: string }> = [];
  for (let left = 0; left < repositories.length; left += 1) {
    for (let right = left + 1; right < repositories.length; right += 1) {
      const pair = [repositories[left]!, repositories[right]!];
      if (pair.length !== requirements.officialFeasibilityFloor.repositories
        || pair[0]!.count + pair[1]!.count < requirements.officialFeasibilityFloor.tasks) continue;
      const excluded = new Set(pair.map((entry) => entry.repository));
      const remaining = repositories.filter((entry) => !excluded.has(entry.repository))
        .sort((a, b) => b.count - a.count || compareCodeUnitStrings(a.rank, b.rank));
      const rehearsal = remaining.slice(0, requirements.rehearsal.repositories);
      const suitability = remaining.slice(requirements.rehearsal.repositories,
        requirements.rehearsal.repositories + requirements.suitability.repositories);
      if (rehearsal.length !== requirements.rehearsal.repositories
        || rehearsal.reduce((sum, entry) => sum + entry.count, 0) < requirements.rehearsal.tasks
        || suitability.length !== requirements.suitability.repositories) continue;
      officialPairs.push({
        repositories: pair.map((entry) => entry.repository).sort(compareCodeUnitStrings),
        count: pair[0]!.count + pair[1]!.count,
        rank: sha256(pair.map((entry) => entry.rank).sort(compareCodeUnitStrings).join("\u0000")),
      });
    }
  }
  const official = officialPairs.sort((left, right) => left.count - right.count
    || compareCodeUnitStrings(left.rank, right.rank))[0];
  if (official === undefined) return null;
  const officialSet = new Set(official.repositories);
  const remaining = repositories.filter((entry) => !officialSet.has(entry.repository))
    .sort((left, right) => right.count - left.count || compareCodeUnitStrings(left.rank, right.rank));
  const rehearsalRepositories = remaining.slice(0, requirements.rehearsal.repositories).map((entry) => entry.repository);
  const rehearsalSet = new Set(rehearsalRepositories);
  const suitabilityRepositories = remaining.filter((entry) => !rehearsalSet.has(entry.repository))
    .sort((left, right) => compareCodeUnitStrings(left.rank, right.rank))
    .slice(0, requirements.suitability.repositories).map((entry) => entry.repository);
  const officialTasks = selectTasks(entries, requirements.officialFeasibilityFloor.tasks, official.repositories, seed, candidate);
  const rehearsalTasks = selectTasks(entries, requirements.rehearsal.tasks, rehearsalRepositories, seed, candidate);
  const suitabilityTasks = selectTasks(entries, requirements.suitability.tasks, suitabilityRepositories, seed, candidate);
  if (officialTasks === null || rehearsalTasks === null || suitabilityTasks === null) return null;
  const officialOrder = entries.filter((entry) => officialSet.has(entry.repository))
    .map((entry) => ({
      taskId: entry.taskId,
      repository: entry.repository,
      taskSha256: entry.taskSha256,
      selectionRankSha256: rank(seed, candidate, entry.repository, entry.taskId),
    })).sort((left, right) => compareCodeUnitStrings(left.selectionRankSha256, right.selectionRankSha256)
      || compareCodeUnitStrings(left.taskId, right.taskId));
  return {
    suitability: suitabilityTasks,
    rehearsal: rehearsalTasks,
    officialFeasibility: officialTasks,
    officialTaskOrder: officialOrder,
  };
}

function entryToV2Task(entry: Demo1TaskEvidenceEntry, pool: Demo1Pool): Demo1TaskEligibilityInput {
  return {
    taskId: entry.taskId,
    repository: entry.repository,
    pool,
    taskSha256: entry.taskSha256,
    image: { digest: entry.image.digest, evidence: entry.image.evidence },
    checks: {
      goldPatchPasses: entry.checks.goldPatchPasses,
      emptyPatchFails: entry.checks.emptyPatchFails,
      compatibleTaskLicense: entry.checks.compatibleTaskLicense,
      instructionLeakageAbsent: entry.checks.instructionLeakageAbsent,
      conflictingInstructionFileAbsent: entry.checks.conflictingInstructionFileAbsent,
      contentGoldPatchCollisionAbsent: entry.checks.contentGoldPatchCollisionAbsent,
    },
  };
}

function normalizeInputs(input: Demo1PreRunFreezeV3Input): {
  readonly inputs: Demo1PreRunFreezeV3Input;
  readonly sourceFreeze: Demo1PreRunFreeze;
} {
  if (input.supersedes.schema !== DEMO1_PRE_RUN_FREEZE_SCHEMA || !SHA256.test(input.supersedes.sha256)) {
    throw new TypeError("v3 supersession identity is invalid");
  }
  verifyDemo1TaskEvidenceArtifact(input.taskEvidence);
  const sourceFreeze = buildDemo1PreRunFreeze({
    ...input.method,
    candidates: input.candidates.map((candidate) => ({ ...candidate, tasks: [] })),
  });
  const candidates = sourceFreeze.inputs.candidates.map(({ tasks: _tasks, ...candidate }) => candidate);
  const { candidates: _normalizedCandidates, ...method } = sourceFreeze.inputs;
  const byPath = new Map(candidates.map((candidate) => [candidate.repositoryPath, candidate]));
  for (const evidenceCandidate of input.taskEvidence.candidates) {
    const candidate = byPath.get(evidenceCandidate.repositoryPath);
    if (candidate === undefined) throw new TypeError("task evidence names a candidate outside the pinned source inventory");
    const parsed = authenticateDemo1CandidateInstructionSource(candidate);
    if (sha256(parsed.description) !== evidenceCandidate.descriptionSha256
      || sha256(parsed.sourceMd) !== evidenceCandidate.sourceMdSha256) {
      throw new TypeError(`${candidate.repositoryPath} task-evidence source bytes do not match the pinned candidate`);
    }
  }
  return {
    sourceFreeze,
    inputs: {
      supersedes: { ...input.supersedes },
      method,
      candidates,
      taskEvidence: JSON.parse(Buffer.from(canonicalDemo1TaskEvidenceBytes(input.taskEvidence)).toString("utf8")) as Demo1TaskEvidenceArtifact,
    } as Demo1PreRunFreezeV3Input,
  };
}

function sourceRejections(freeze: Demo1PreRunFreeze, candidate: string): string[] {
  const ignored = new Set([
    "no-grader-valid-repository-work-tasks",
    "insufficient-suitability-pool",
    "insufficient-rehearsal-pool",
    "insufficient-official-feasibility-pool",
  ]);
  return freeze.derived.candidates.find((entry) => entry.repositoryPath === candidate)!.rejectionReasons
    .filter((reason) => !ignored.has(reason));
}

function eligible(entry: Demo1TaskEvidenceEntry): boolean {
  return DEMO1_TASK_EVIDENCE_CHECKS.every((name) => entry.checks[name].status === "match")
    && entry.image.evidence.length > 0;
}

function staticallyEligible(entry: Demo1TaskEvidenceEntry): boolean {
  const checks = [
    "domainCompatible",
    "compatibleTaskLicense",
    "instructionLeakageAbsent",
    "conflictingInstructionFileAbsent",
    "contentGoldPatchCollisionAbsent",
  ] as const;
  return checks.every((name) => entry.checks[name].status === "match")
    && entry.image.evidence.length > 0;
}

function materializeV2(
  inputs: Demo1PreRunFreezeV3Input,
  winnerPath: string,
  partition: Demo1PreRunFreezeV3Partition,
): Demo1PreRunFreeze {
  const candidateEntries = inputs.taskEvidence.entries.filter((entry) => entry.candidate === winnerPath);
  const byId = new Map(candidateEntries.map((entry) => [entry.taskId, entry]));
  const tasks = [
    ...partition.suitability.map((entry) => entryToV2Task(byId.get(entry.taskId)!, "suitability")),
    ...partition.rehearsal.map((entry) => entryToV2Task(byId.get(entry.taskId)!, "rehearsal")),
    ...partition.officialTaskOrder.map((entry) => entryToV2Task(byId.get(entry.taskId)!, "official")),
  ];
  return buildDemo1PreRunFreeze({
    ...inputs.method,
    candidates: inputs.candidates.map((candidate) => ({
      ...candidate,
      tasks: candidate.repositoryPath === winnerPath ? tasks : [],
    })),
  });
}

export function buildDemo1PreRunFreezeV3(input: Demo1PreRunFreezeV3Input): Demo1PreRunFreezeV3 {
  const { inputs, sourceFreeze } = normalizeInputs(input);
  const taskEvidenceSha256 = demo1TaskEvidenceDigest(inputs.taskEvidence);
  const selectionBasisSha256 = sha256(canonicalBytes(inputs));
  const taskSelection = seedFromBasis(selectionBasisSha256);
  const candidates: Demo1PreRunFreezeV3CandidateInventory[] = inputs.candidates.map((candidate) => {
    const sourceRejectionReasons = sourceRejections(sourceFreeze, candidate.repositoryPath);
    const entries = inputs.taskEvidence.entries.filter((entry) => entry.candidate === candidate.repositoryPath);
    const domain = entries.filter((entry) => entry.checks.domainCompatible.status === "match");
    const staticEntries = entries.filter(staticallyEligible);
    const full = entries.filter(eligible);
    const staticPartition = partitionTasks(staticEntries, taskSelection, candidate.repositoryPath, inputs.method.poolRequirements);
    const selectedPools = partitionTasks(full, taskSelection, candidate.repositoryPath, inputs.method.poolRequirements);
    const rejectionReasons = [
      ...sourceRejectionReasons,
      ...(entries.length === 0 ? ["candidate-not-in-task-evidence-policy"] : []),
      ...(entries.length > 0 && staticPartition === null ? ["insufficient-static-domain-capacity"] : []),
      ...(staticPartition !== null && selectedPools === null ? ["incomplete-dynamic-task-evidence"] : []),
    ];
    return {
      repositoryPath: candidate.repositoryPath,
      sourceEligible: sourceRejectionReasons.length === 0,
      sourceRejectionReasons,
      taskEvidencePresent: entries.length > 0,
      domainCompatibleTaskCount: domain.length,
      domainCompatibleRepositoryCount: new Set(domain.map((entry) => entry.repository)).size,
      fullyEligibleTaskCount: full.length,
      fullyEligibleRepositoryCount: new Set(full.map((entry) => entry.repository)).size,
      staticCapacityPossible: staticPartition !== null,
      preE2Ready: sourceRejectionReasons.length === 0 && selectedPools !== null,
      rejectionReasons: [...new Set(rejectionReasons)],
      selectedPools,
    };
  });
  const ranking = candidates.filter((candidate) => candidate.preE2Ready)
    .sort((left, right) => right.fullyEligibleTaskCount - left.fullyEligibleTaskCount
      || compareCodeUnitStrings(left.repositoryPath, right.repositoryPath))
    .map((candidate) => ({
      repositoryPath: candidate.repositoryPath,
      fullyEligibleTaskCount: candidate.fullyEligibleTaskCount,
    }));
  const winnerInventory = candidates.find((candidate) => candidate.repositoryPath === ranking[0]?.repositoryPath);
  const winner = winnerInventory?.selectedPools === null || winnerInventory === undefined ? null : (() => {
    const v2 = materializeV2(inputs, winnerInventory.repositoryPath, winnerInventory.selectedPools);
    if (v2.derived.winner === null || v2.derived.winner.repositoryPath !== winnerInventory.repositoryPath) {
      throw new TypeError("v3/v2 winner materialization disagreement");
    }
    return {
      ...v2.derived.winner,
      taskEvidenceSha256,
      poolPartitionPolicy: DEMO1_POOL_PARTITION_POLICY,
    };
  })();
  const staticCandidates = candidates.filter((candidate) => candidate.sourceEligible && candidate.taskEvidencePresent);
  const stopReasons = winner === null
    ? staticCandidates.every((candidate) => !candidate.staticCapacityPossible)
      ? ["no-candidate-meets-static-domain-capacity"]
      : ["no-candidate-has-complete-task-evidence"]
    : [];
  return {
    schema: DEMO1_PRE_RUN_FREEZE_V3_SCHEMA,
    inputs,
    derived: {
      status: winner === null ? "stop" : "ready",
      taskEvidenceSha256,
      selectionBasisSha256,
      seeds: { procedure: "sha256-first-u32be-nonzero@1", taskSelection },
      poolPartitionPolicy: DEMO1_POOL_PARTITION_POLICY,
      candidates,
      ranking,
      winner,
      stopReasons,
    },
    execution: {
      modelArms: 0,
      previews: 0,
      dockerControls: inputs.taskEvidence.execution.dockerControls,
      rehearsalCells: 0,
      officialCells: 0,
    },
  };
}

export function verifyDemo1PreRunFreezeV3(freeze: Demo1PreRunFreezeV3): void {
  if (freeze.schema !== DEMO1_PRE_RUN_FREEZE_V3_SCHEMA) throw new TypeError("pre-run v3 schema mismatch");
  const rebuilt = buildDemo1PreRunFreezeV3(freeze.inputs);
  if (!canonicalEqual(rebuilt, freeze)) throw new TypeError("pre-run v3 fields do not recompute from canonical inputs");
}

export function canonicalDemo1PreRunFreezeV3Bytes(freeze: Demo1PreRunFreezeV3): Uint8Array {
  verifyDemo1PreRunFreezeV3(freeze);
  return canonicalBytes(freeze);
}

export function demo1PreRunFreezeV3Digest(freeze: Demo1PreRunFreezeV3): string {
  return `sha256:${sha256(canonicalDemo1PreRunFreezeV3Bytes(freeze))}`;
}

/** Supplies the unchanged E2 implementation only after v3 has independently earned READY. */
export function demo1PreRunFreezeV3AsV2(freeze: Demo1PreRunFreezeV3): Demo1PreRunFreeze {
  verifyDemo1PreRunFreezeV3(freeze);
  const winner = freeze.derived.candidates.find((candidate) => candidate.repositoryPath === freeze.derived.winner?.repositoryPath);
  if (winner?.selectedPools === null || winner === undefined) throw new TypeError("a STOP freeze cannot authorize E2");
  return materializeV2(freeze.inputs, winner.repositoryPath, winner.selectedPools);
}
