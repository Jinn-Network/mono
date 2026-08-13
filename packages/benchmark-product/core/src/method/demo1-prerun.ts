import { createHash } from "node:crypto";
import {
  compareCodeUnitStrings,
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import { generateDemo1InstructionArtifacts } from "../venue/demo1-claude.js";

export const DEMO1_PRE_RUN_FREEZE_SCHEMA = "jinn.demo1.pre-run-freeze.v1" as const;
export const DEMO1_SKILLS_SOURCE_URL = "https://github.com/anthropics/skills.git" as const;
export const DEMO1_DOCUMENT_SKILL_PATHS = [
  "skills/docx",
  "skills/pdf",
  "skills/pptx",
  "skills/xlsx",
] as const;
export const DEMO1_OUTCOME_BLIND_TASK_CHECKS = [
  "goldPatchPasses",
  "emptyPatchFails",
  "compatibleTaskLicense",
  "instructionLeakageAbsent",
  "conflictingInstructionFileAbsent",
  "contentGoldPatchCollisionAbsent",
] as const;
export const DEMO1_INSTRUCTION_TRANSFORM_ID = "demo1-literal-instruction-materialization@1" as const;
export const DEMO1_INSTRUCTION_TRANSFORM_SPEC = [
  "Decode upstream SKILL.md as strict UTF-8 with LF line endings.",
  "Read name and description from the leading YAML frontmatter.",
  "source.md is every byte after the closing frontmatter delimiter and its one blank-line separator.",
  "CLAUDE.md is source.md byte-for-byte.",
  "SKILL.md is deterministic name/description frontmatter followed by source.md byte-for-byte.",
].join("\n");

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const GIT_OBJECT = /^[0-9a-f]{40}$/u;
const PATH = /^skills\/[a-z0-9][a-z0-9-]*$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type Demo1EvidenceStatus = "match" | "mismatch" | "unverifiable";
export type Demo1Pool = "suitability" | "rehearsal" | "official";

export interface Demo1EvidenceRef {
  readonly uri: string;
  readonly sha256: string;
}

export interface Demo1EvidenceCheck {
  readonly status: Demo1EvidenceStatus;
  readonly detail?: string;
  readonly evidence: readonly Demo1EvidenceRef[];
}

export interface Demo1TaskEligibilityInput {
  readonly taskId: string;
  readonly repository: string;
  readonly pool: Demo1Pool;
  readonly taskSha256: string;
  readonly image: {
    readonly digest: string;
    readonly evidence: readonly Demo1EvidenceRef[];
  };
  readonly checks: {
    readonly goldPatchPasses: Demo1EvidenceCheck;
    readonly emptyPatchFails: Demo1EvidenceCheck;
    readonly compatibleTaskLicense: Demo1EvidenceCheck;
    readonly instructionLeakageAbsent: Demo1EvidenceCheck;
    readonly conflictingInstructionFileAbsent: Demo1EvidenceCheck;
    readonly contentGoldPatchCollisionAbsent: Demo1EvidenceCheck;
  };
}

export interface Demo1CandidateInput {
  readonly repositoryPath: string;
  readonly skillMd: Uint8Array;
  readonly license?: {
    readonly spdxId: string;
    readonly bytes: Uint8Array;
  };
  readonly standalone: Demo1EvidenceCheck;
  readonly tasks: readonly Demo1TaskEligibilityInput[];
}

export interface Demo1PreRunFreezeInput {
  readonly source: {
    readonly repositoryUrl: string;
    readonly commit: string;
    readonly skillsTree: string;
  };
  readonly poolRequirements: {
    readonly suitability: { readonly tasks: number; readonly repositories: number };
    readonly rehearsal: { readonly tasks: number; readonly repositories: number };
  };
  readonly officialPoolRequirement:
    | { readonly status: "resolved"; readonly tasks: number; readonly repositories: number }
    | { readonly status: "unresolved"; readonly detail: string };
  readonly candidates: readonly Demo1CandidateInput[];
}

interface ParsedDemo1UpstreamSkill {
  readonly name: string;
  readonly description: string;
  readonly sourceMd: Uint8Array;
}

interface CandidateInspection {
  readonly input: Demo1CandidateInput;
  readonly parsed?: ParsedDemo1UpstreamSkill;
  readonly inventory: Demo1CandidateInventory;
  readonly poolOverlap: boolean;
}

export interface Demo1TaskInventory {
  readonly taskId: string;
  readonly repository: string;
  readonly pool: Demo1Pool;
  readonly taskSha256: string;
  readonly imageDigest: string;
  readonly evidence: Readonly<Record<string, Demo1EvidenceCheck | readonly Demo1EvidenceRef[]>>;
  readonly eligible: boolean;
  readonly rejectionReasons: readonly string[];
}

export interface Demo1CandidateInventory {
  readonly repositoryPath: string;
  readonly upstreamSkillMd: { readonly sha256: string; readonly bytes: number };
  readonly upstreamName: string | null;
  readonly upstreamDescription: string | null;
  readonly license: {
    readonly status: "compatible" | "incompatible" | "missing";
    readonly spdxId: string | null;
    readonly sha256: string | null;
    readonly bytes: number | null;
  };
  readonly standalone: Demo1EvidenceCheck;
  readonly tasks: readonly Demo1TaskInventory[];
  readonly eligibleTaskCount: number;
  readonly eligibleRepositoryCount: number;
  readonly rejectionReasons: readonly string[];
}

export interface Demo1PreRunFreeze {
  readonly schema: typeof DEMO1_PRE_RUN_FREEZE_SCHEMA;
  readonly status: "ready" | "stop";
  readonly source: {
    readonly repositoryUrl: typeof DEMO1_SKILLS_SOURCE_URL;
    readonly commit: string;
    readonly skillsTree: string;
  };
  readonly exclusions: { readonly documentSkills: typeof DEMO1_DOCUMENT_SKILL_PATHS };
  readonly outcomeBlindTaskChecks: typeof DEMO1_OUTCOME_BLIND_TASK_CHECKS;
  readonly poolRequirements: Demo1PreRunFreezeInput["poolRequirements"];
  readonly officialPoolRequirement: Demo1PreRunFreezeInput["officialPoolRequirement"];
  readonly selectionBasisSha256: string;
  readonly seeds: {
    readonly procedure: "sha256-first-u32be-nonzero@1";
    readonly resolved: {
      readonly taskSelection: number;
      readonly replicateScheduling: number;
      readonly interleaving: number;
      readonly pairedBootstrap: number;
    };
  };
  readonly candidates: readonly Demo1CandidateInventory[];
  readonly ranking: readonly {
    readonly repositoryPath: string;
    readonly eligibleTaskCount: number;
  }[];
  readonly winner: null | {
    readonly repositoryPath: string;
    readonly upstreamDescription: string;
    readonly upstreamSkillMdSha256: string;
    readonly license: {
      readonly spdxId: "Apache-2.0";
      readonly sha256: string;
      readonly content: string;
    };
    readonly transform: {
      readonly id: typeof DEMO1_INSTRUCTION_TRANSFORM_ID;
      readonly specSha256: string;
    };
    readonly sourceMd: { readonly sha256: string; readonly content: string };
    readonly skillMd: { readonly sha256: string; readonly content: string };
    readonly claudeMd: { readonly sha256: string; readonly content: string };
    readonly selectedPools: Readonly<Record<Demo1Pool, readonly {
      readonly taskId: string;
      readonly repository: string;
      readonly taskSha256: string;
      readonly selectionRankSha256: string;
    }[]>>;
  };
  readonly stopReasons: readonly string[];
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function nonEmpty(value: string, field: string): string {
  if (value.length === 0 || /[\r\n\u0000]/u.test(value)) throw new TypeError(`${field} must be one non-empty line`);
  return value;
}

function parseScalar(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new TypeError(`${field} is missing`);
  if (trimmed.startsWith('"')) {
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
    return value;
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) throw new TypeError(`${field} has malformed single quotes`);
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function frontmatterField(lines: readonly string[], field: string): string {
  const prefix = `${field}:`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index < 0) throw new TypeError(`upstream ${field} is missing`);
  const raw = lines[index]!.slice(prefix.length);
  if (raw.trim() === "|-" || raw.trim() === "|") {
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      if (line.length > 0 && !/^\s/u.test(line)) break;
      block.push(line.startsWith("  ") ? line.slice(2) : line);
    }
    const value = block.join("\n").replace(/\n+$/u, "");
    if (value.length === 0) throw new TypeError(`upstream ${field} is missing`);
    return value;
  }
  return parseScalar(raw, `upstream ${field}`);
}

/** Extracts the upstream-authored metadata and body without newline normalization. */
export function parseDemo1UpstreamSkill(skillMd: Uint8Array): ParsedDemo1UpstreamSkill {
  const text = decoder.decode(skillMd);
  if (text.includes("\r")) throw new TypeError("upstream SKILL.md must use LF line endings");
  if (!text.startsWith("---\n")) throw new TypeError("upstream SKILL.md must start with YAML frontmatter");
  const closing = text.indexOf("\n---\n\n", 4);
  if (closing < 0) throw new TypeError("upstream SKILL.md must have a closing delimiter and one blank-line separator");
  const frontmatter = text.slice(4, closing).split("\n");
  const sourcePrefix = text.slice(0, closing + "\n---\n\n".length);
  const sourceOffset = encoder.encode(sourcePrefix).length;
  const sourceMd = skillMd.slice(sourceOffset);
  if (sourceMd.length === 0) throw new TypeError("upstream SKILL.md instruction body is empty");
  return {
    name: nonEmpty(frontmatterField(frontmatter, "name"), "upstream name"),
    description: frontmatterField(frontmatter, "description"),
    sourceMd,
  };
}

function normalizeEvidenceRefs(refs: readonly Demo1EvidenceRef[], field: string): Demo1EvidenceRef[] {
  const normalized = refs.map((ref) => {
    nonEmpty(ref.uri, `${field} evidence URI`);
    if (!SHA256.test(ref.sha256)) throw new TypeError(`${field} evidence sha256 must be 64 lowercase hex`);
    return { uri: ref.uri, sha256: ref.sha256 };
  }).sort((left, right) => compareCodeUnitStrings(left.uri, right.uri)
    || compareCodeUnitStrings(left.sha256, right.sha256));
  const keys = normalized.map((ref) => `${ref.uri}\u0000${ref.sha256}`);
  if (new Set(keys).size !== keys.length) throw new TypeError(`${field} evidence references must be unique`);
  return normalized;
}

function normalizeCheck(check: Demo1EvidenceCheck, field: string): Demo1EvidenceCheck {
  if (!["match", "mismatch", "unverifiable"].includes(check.status)) {
    throw new TypeError(`${field} has unknown evidence status`);
  }
  const evidence = normalizeEvidenceRefs(check.evidence, field);
  if (check.status === "match" && evidence.length === 0) {
    throw new TypeError(`${field} cannot match without evidence`);
  }
  return {
    status: check.status,
    ...(check.detail === undefined ? {} : { detail: nonEmpty(check.detail, `${field} detail`) }),
    evidence,
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
  return value;
}

function poolRequirement(tasks: number, repositories: number, field: string) {
  const normalized = {
    tasks: positiveInteger(tasks, `${field} task count`),
    repositories: positiveInteger(repositories, `${field} repository count`),
  };
  if (normalized.repositories > normalized.tasks) {
    throw new TypeError(`${field} repository count cannot exceed task count`);
  }
  return normalized;
}

function inspectTask(task: Demo1TaskEligibilityInput): Demo1TaskInventory {
  nonEmpty(task.taskId, "taskId");
  nonEmpty(task.repository, "task repository");
  if (!["suitability", "rehearsal", "official"].includes(task.pool)) throw new TypeError("task pool is invalid");
  if (!SHA256.test(task.taskSha256)) throw new TypeError("taskSha256 must be 64 lowercase hex");
  if (!SHA256_DIGEST.test(task.image.digest)) throw new TypeError("task image digest must be sha256:<64 lowercase hex>");
  const imageEvidence = normalizeEvidenceRefs(task.image.evidence, `${task.taskId} image`);
  const normalizedChecks = Object.fromEntries(DEMO1_OUTCOME_BLIND_TASK_CHECKS.map((criterion) => [
    criterion,
    normalizeCheck(task.checks[criterion], `${task.taskId} ${criterion}`),
  ])) as unknown as Demo1TaskEligibilityInput["checks"];
  const rejectionReasons = [
    ...(imageEvidence.length === 0 ? ["verifiedImageDigest"] : []),
    ...DEMO1_OUTCOME_BLIND_TASK_CHECKS.filter((criterion) => normalizedChecks[criterion].status !== "match"),
  ];
  return {
    taskId: task.taskId,
    repository: task.repository,
    pool: task.pool,
    taskSha256: task.taskSha256,
    imageDigest: task.image.digest,
    evidence: { imageDigest: imageEvidence, ...normalizedChecks },
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

function inspectCandidate(input: Demo1CandidateInput): CandidateInspection {
  if (!PATH.test(input.repositoryPath)) throw new TypeError(`invalid candidate repository path ${input.repositoryPath}`);
  let parsed: ParsedDemo1UpstreamSkill | undefined;
  try {
    parsed = parseDemo1UpstreamSkill(input.skillMd);
  } catch {
    parsed = undefined;
  }
  const license = input.license === undefined
    ? { status: "missing" as const, spdxId: null, sha256: null, bytes: null }
    : {
        status: input.license.spdxId === "Apache-2.0" ? "compatible" as const : "incompatible" as const,
        spdxId: input.license.spdxId,
        sha256: sha256(input.license.bytes),
        bytes: input.license.bytes.length,
      };
  const standalone = normalizeCheck(input.standalone, `${input.repositoryPath} standalone assessment`);
  const tasks = input.tasks.map(inspectTask)
    .sort((left, right) => compareCodeUnitStrings(left.taskId, right.taskId));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new TypeError(`${input.repositoryPath} task ids must be unique`);
  }
  const eligibleTasks = tasks.filter((task) => task.eligible);
  const poolsByRepository = new Map<string, Set<Demo1Pool>>();
  for (const task of eligibleTasks) {
    const pools = poolsByRepository.get(task.repository) ?? new Set<Demo1Pool>();
    pools.add(task.pool);
    poolsByRepository.set(task.repository, pools);
  }
  const poolOverlap = [...poolsByRepository.values()].some((pools) => pools.size > 1);
  const expectedName = input.repositoryPath.slice("skills/".length);
  const rejectionReasons = [
    ...(DEMO1_DOCUMENT_SKILL_PATHS.includes(input.repositoryPath as typeof DEMO1_DOCUMENT_SKILL_PATHS[number])
      ? ["source-available-document-skill"] : []),
    ...(parsed === undefined ? ["upstream-description-missing-or-malformed"] : []),
    ...(parsed !== undefined && parsed.name !== expectedName ? ["upstream-name-path-mismatch"] : []),
    ...(license.status !== "compatible" ? ["missing-compatible-folder-license"] : []),
    ...(standalone.status !== "match" ? ["instructions-not-standalone"] : []),
    ...(eligibleTasks.length === 0 ? ["no-grader-valid-repository-work-tasks"] : []),
    ...(poolOverlap ? ["repository-pool-overlap"] : []),
  ];
  return {
    input,
    parsed,
    poolOverlap,
    inventory: {
      repositoryPath: input.repositoryPath,
      upstreamSkillMd: { sha256: sha256(input.skillMd), bytes: input.skillMd.length },
      upstreamName: parsed?.name ?? null,
      upstreamDescription: parsed?.description ?? null,
      license,
      standalone,
      tasks,
      eligibleTaskCount: eligibleTasks.length,
      eligibleRepositoryCount: new Set(eligibleTasks.map((task) => task.repository)).size,
      rejectionReasons,
    },
  };
}

function resolvedSeed(basisSha256: string, purpose: string): number {
  const digest = createHash("sha256")
    .update(`jinn.demo1.pre-run-seed@1\u0000${purpose}\u0000${basisSha256}`, "utf8")
    .digest();
  const value = digest.readUInt32BE(0);
  return value === 0 ? 1 : value;
}

function taskRank(seed: number, candidatePath: string, task: Demo1TaskInventory): string {
  return sha256(`jinn.demo1.task-selection@1\u0000${seed}\u0000${candidatePath}\u0000${task.pool}\u0000${task.taskId}`);
}

function selectPool(
  tasks: readonly Demo1TaskInventory[],
  count: number,
  minimumRepositories: number,
  seed: number,
  candidatePath: string,
): null | { readonly task: Demo1TaskInventory; readonly rank: string }[] {
  const ranked = tasks
    .map((task) => ({ task, rank: taskRank(seed, candidatePath, task) }))
    .sort((left, right) => compareCodeUnitStrings(left.rank, right.rank)
      || compareCodeUnitStrings(left.task.taskId, right.task.taskId));
  if (ranked.length < count) return null;
  const firstByRepository = new Map<string, typeof ranked[number]>();
  for (const entry of ranked) if (!firstByRepository.has(entry.task.repository)) firstByRepository.set(entry.task.repository, entry);
  const representatives = [...firstByRepository.values()]
    .sort((left, right) => compareCodeUnitStrings(left.rank, right.rank)
      || compareCodeUnitStrings(left.task.repository, right.task.repository));
  if (representatives.length < minimumRepositories || minimumRepositories > count) return null;
  const selected = representatives.slice(0, minimumRepositories);
  const chosen = new Set(selected.map((entry) => entry.task.taskId));
  for (const entry of ranked) {
    if (selected.length >= count) break;
    if (!chosen.has(entry.task.taskId)) {
      selected.push(entry);
      chosen.add(entry.task.taskId);
    }
  }
  return selected.sort((left, right) => compareCodeUnitStrings(left.rank, right.rank)
    || compareCodeUnitStrings(left.task.taskId, right.task.taskId));
}

function sourceEligible(candidate: CandidateInspection): boolean {
  return !candidate.inventory.rejectionReasons.some((reason) => [
    "source-available-document-skill",
    "upstream-description-missing-or-malformed",
    "upstream-name-path-mismatch",
    "missing-compatible-folder-license",
    "instructions-not-standalone",
    "repository-pool-overlap",
  ].includes(reason));
}

export function buildDemo1PreRunFreeze(input: Demo1PreRunFreezeInput): Demo1PreRunFreeze {
  if (input.source.repositoryUrl !== DEMO1_SKILLS_SOURCE_URL) {
    throw new TypeError(`Demo-1 source must remain ${DEMO1_SKILLS_SOURCE_URL}`);
  }
  if (!GIT_OBJECT.test(input.source.commit) || !GIT_OBJECT.test(input.source.skillsTree)) {
    throw new TypeError("source commit and skills tree must be exact 40-character lowercase Git object ids");
  }
  const requirements = {
    suitability: poolRequirement(
      input.poolRequirements.suitability.tasks,
      input.poolRequirements.suitability.repositories,
      "suitability",
    ),
    rehearsal: poolRequirement(
      input.poolRequirements.rehearsal.tasks,
      input.poolRequirements.rehearsal.repositories,
      "rehearsal",
    ),
  };
  const official = input.officialPoolRequirement.status === "resolved"
    ? {
        status: "resolved" as const,
        ...poolRequirement(
          input.officialPoolRequirement.tasks,
          input.officialPoolRequirement.repositories,
          "official",
        ),
      }
    : { status: "unresolved" as const, detail: nonEmpty(input.officialPoolRequirement.detail, "official requirement detail") };
  const inspections = input.candidates.map(inspectCandidate)
    .sort((left, right) => compareCodeUnitStrings(left.inventory.repositoryPath, right.inventory.repositoryPath));
  if (new Set(inspections.map((entry) => entry.inventory.repositoryPath)).size !== inspections.length) {
    throw new TypeError("candidate repository paths must be unique");
  }
  const basisValue = {
    schema: "jinn.demo1.pre-run-selection-basis.v1",
    source: input.source,
    exclusions: { documentSkills: DEMO1_DOCUMENT_SKILL_PATHS },
    outcomeBlindTaskChecks: DEMO1_OUTCOME_BLIND_TASK_CHECKS,
    poolRequirements: requirements,
    officialPoolRequirement: official,
    candidates: inspections.map((entry) => entry.inventory),
  };
  const selectionBasisSha256 = sha256(canonicalBytes(basisValue));
  const resolved = {
    taskSelection: resolvedSeed(selectionBasisSha256, "task-selection"),
    replicateScheduling: resolvedSeed(selectionBasisSha256, "replicate-scheduling"),
    interleaving: resolvedSeed(selectionBasisSha256, "interleaving"),
    pairedBootstrap: resolvedSeed(selectionBasisSha256, "paired-bootstrap"),
  };
  const selections = new Map<string, Readonly<Record<Demo1Pool, ReturnType<typeof selectPool>>>>();
  for (const candidate of inspections) {
    const eligible = candidate.inventory.tasks.filter((task) => task.eligible);
    selections.set(candidate.inventory.repositoryPath, {
      suitability: selectPool(eligible.filter((task) => task.pool === "suitability"), requirements.suitability.tasks, requirements.suitability.repositories, resolved.taskSelection, candidate.inventory.repositoryPath),
      rehearsal: selectPool(eligible.filter((task) => task.pool === "rehearsal"), requirements.rehearsal.tasks, requirements.rehearsal.repositories, resolved.taskSelection, candidate.inventory.repositoryPath),
      official: official.status === "resolved"
        ? selectPool(eligible.filter((task) => task.pool === "official"), official.tasks, official.repositories, resolved.taskSelection, candidate.inventory.repositoryPath)
        : null,
    });
  }
  const readyCandidates = inspections.filter((candidate) => {
    const selected = selections.get(candidate.inventory.repositoryPath)!;
    return sourceEligible(candidate)
      && official.status === "resolved"
      && selected.suitability !== null
      && selected.rehearsal !== null
      && selected.official !== null;
  }).sort((left, right) => right.inventory.eligibleTaskCount - left.inventory.eligibleTaskCount
    || compareCodeUnitStrings(left.inventory.repositoryPath, right.inventory.repositoryPath));
  const winnerCandidate = readyCandidates[0];
  const winner = winnerCandidate === undefined ? null : (() => {
    const parsed = winnerCandidate.parsed!;
    const license = winnerCandidate.input.license!;
    const artifacts = generateDemo1InstructionArtifacts(parsed.sourceMd, {
      name: parsed.name,
      description: parsed.description,
    });
    const selected = selections.get(winnerCandidate.inventory.repositoryPath)! as Record<Demo1Pool, NonNullable<ReturnType<typeof selectPool>>>;
    const selectedPools = Object.fromEntries((["suitability", "rehearsal", "official"] as const).map((pool) => [
      pool,
      selected[pool].map((entry) => ({
        taskId: entry.task.taskId,
        repository: entry.task.repository,
        taskSha256: entry.task.taskSha256,
        selectionRankSha256: entry.rank,
      })),
    ])) as Demo1PreRunFreeze["winner"] extends { selectedPools: infer T } ? T : never;
    return {
      repositoryPath: winnerCandidate.inventory.repositoryPath,
      upstreamDescription: parsed.description,
      upstreamSkillMdSha256: winnerCandidate.inventory.upstreamSkillMd.sha256,
      license: {
        spdxId: "Apache-2.0" as const,
        sha256: sha256(license.bytes),
        content: Buffer.from(license.bytes).toString("base64"),
      },
      transform: {
        id: DEMO1_INSTRUCTION_TRANSFORM_ID,
        specSha256: sha256(DEMO1_INSTRUCTION_TRANSFORM_SPEC),
      },
      sourceMd: { sha256: sha256(parsed.sourceMd), content: Buffer.from(parsed.sourceMd).toString("base64") },
      skillMd: { sha256: artifacts.skill.digest.sha256, content: artifacts.skill.content },
      claudeMd: { sha256: artifacts.baseline.digest.sha256, content: artifacts.baseline.content },
      selectedPools,
    };
  })();
  const stopReasons = [
    ...(official.status === "unresolved" ? ["official-pool-requirement-unresolved"] : []),
    ...(readyCandidates.length === 0 ? ["no-candidate-supports-disjoint-suitability-rehearsal-official-pools"] : []),
  ];
  const candidateInventories = inspections.map((candidate) => {
    const selected = selections.get(candidate.inventory.repositoryPath)!;
    const capacityRejections = candidate.inventory.eligibleTaskCount === 0 ? [] : [
        ...(selected.suitability === null ? ["insufficient-suitability-pool"] : []),
        ...(selected.rehearsal === null ? ["insufficient-rehearsal-pool"] : []),
        ...(official.status === "resolved" && selected.official === null ? ["insufficient-official-pool"] : []),
      ];
    return {
      ...candidate.inventory,
      rejectionReasons: [...new Set([...candidate.inventory.rejectionReasons, ...capacityRejections])],
    };
  });
  return {
    schema: DEMO1_PRE_RUN_FREEZE_SCHEMA,
    status: winner === null ? "stop" : "ready",
    source: {
      repositoryUrl: DEMO1_SKILLS_SOURCE_URL,
      commit: input.source.commit,
      skillsTree: input.source.skillsTree,
    },
    exclusions: { documentSkills: DEMO1_DOCUMENT_SKILL_PATHS },
    outcomeBlindTaskChecks: DEMO1_OUTCOME_BLIND_TASK_CHECKS,
    poolRequirements: requirements,
    officialPoolRequirement: official,
    selectionBasisSha256,
    seeds: { procedure: "sha256-first-u32be-nonzero@1", resolved },
    candidates: candidateInventories,
    ranking: readyCandidates.map((candidate) => ({
      repositoryPath: candidate.inventory.repositoryPath,
      eligibleTaskCount: candidate.inventory.eligibleTaskCount,
    })),
    winner,
    stopReasons,
  };
}

export function canonicalDemo1PreRunFreezeBytes(freeze: Demo1PreRunFreeze): Uint8Array {
  return canonicalBytes(freeze);
}

export function demo1PreRunFreezeDigest(freeze: Demo1PreRunFreeze): string {
  return `sha256:${sha256(canonicalDemo1PreRunFreezeBytes(freeze))}`;
}
