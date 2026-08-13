import { createHash } from "node:crypto";
import {
  compareCodeUnitStrings,
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import { generateDemo1InstructionArtifacts } from "../venue/demo1-claude.js";
import {
  DEMO1_PINNED_SKILLS_SOURCE,
  type Demo1PinnedCandidateSource,
} from "./demo1-prerun-source.js";

export const DEMO1_PRE_RUN_FREEZE_SCHEMA = "jinn.demo1.pre-run-freeze.v2" as const;
export const DEMO1_SKILLS_SOURCE_URL = DEMO1_PINNED_SKILLS_SOURCE.repositoryUrl;
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
export const DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR = {
  tasks: 5,
  repositories: 2,
  basis: "paired-delta@1 requires minN=5 paired tasks and at least two source clusters",
} as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const POOLS = ["suitability", "rehearsal", "official"] as const;

export type Demo1EvidenceStatus = "match" | "mismatch" | "unverifiable";
export type Demo1Pool = typeof POOLS[number];

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

export interface Demo1AuthenticatedCandidateSource {
  readonly repositoryPath: string;
  readonly folderTree: string;
  readonly skill: {
    readonly path: string;
    readonly gitBlob: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly name: string;
    readonly description: string;
  };
  readonly license: null | {
    readonly path: string;
    readonly gitBlob: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly status: "compatible" | "incompatible";
    readonly spdxId: string;
  };
}

export interface Demo1CandidateInput {
  readonly repositoryPath: string;
  /** Authenticated summary obtained from the exact path/blob entries of the pinned Git tree. */
  readonly source: Demo1AuthenticatedCandidateSource;
  /** Required only if this candidate becomes the pre-E2 winner; verified against source identity. */
  readonly skillMdBase64?: string;
  readonly standalone: Demo1EvidenceCheck;
  readonly tasks: readonly Demo1TaskEligibilityInput[];
}

export interface Demo1PreRunFreezeInput {
  readonly source: {
    readonly authentication: typeof DEMO1_PINNED_SKILLS_SOURCE.authentication;
    readonly repositoryUrl: typeof DEMO1_PINNED_SKILLS_SOURCE.repositoryUrl;
    readonly commit: typeof DEMO1_PINNED_SKILLS_SOURCE.commit;
    readonly commitTree: typeof DEMO1_PINNED_SKILLS_SOURCE.commitTree;
    readonly skillsTree: typeof DEMO1_PINNED_SKILLS_SOURCE.skillsTree;
  };
  readonly exclusions: { readonly documentSkills: typeof DEMO1_DOCUMENT_SKILL_PATHS };
  readonly outcomeBlindTaskChecks: typeof DEMO1_OUTCOME_BLIND_TASK_CHECKS;
  readonly transform: {
    readonly id: typeof DEMO1_INSTRUCTION_TRANSFORM_ID;
    readonly specSha256: string;
  };
  readonly poolRequirements: {
    readonly suitability: { readonly tasks: number; readonly repositories: number };
    readonly rehearsal: { readonly tasks: number; readonly repositories: number };
    readonly officialFeasibilityFloor: typeof DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR;
  };
  readonly officialDesign: {
    readonly status: "pending-e2";
    readonly arms: 3;
    readonly cellCeiling: 600;
    readonly targetPower: "0.80";
    readonly targetEffectPercentagePoints: "21";
    readonly exactCapacity: null;
    readonly winnerLockedBeforeE2: true;
    readonly insufficientWinnerCapacityDisposition: "stop-with-evidence-no-candidate-switch";
  };
  readonly candidates: readonly Demo1CandidateInput[];
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
  readonly sourceAuthenticated: true;
  readonly upstreamSkillMd: {
    readonly path: string;
    readonly gitBlob: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly upstreamName: string;
  readonly upstreamDescription: string;
  readonly license: Demo1AuthenticatedCandidateSource["license"];
  readonly standalone: Demo1EvidenceCheck;
  readonly tasks: readonly Demo1TaskInventory[];
  readonly eligibleTaskCount: number;
  readonly eligibleRepositoryCount: number;
  readonly preE2Ready: boolean;
  readonly rejectionReasons: readonly string[];
}

interface SelectedTask {
  readonly taskId: string;
  readonly repository: string;
  readonly taskSha256: string;
  readonly selectionRankSha256: string;
}

export interface Demo1PreRunFreezeDerived {
  readonly status: "ready" | "stop";
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
      readonly path: string;
      readonly gitBlob: string;
      readonly sha256: string;
      readonly bytes: number;
    };
    readonly transform: {
      readonly id: typeof DEMO1_INSTRUCTION_TRANSFORM_ID;
      readonly specSha256: string;
    };
    readonly sourceMd: { readonly sha256: string; readonly content: string };
    readonly skillMd: { readonly sha256: string; readonly content: string };
    readonly claudeMd: { readonly sha256: string; readonly content: string };
    readonly selectedPools: {
      readonly suitability: readonly SelectedTask[];
      readonly rehearsal: readonly SelectedTask[];
      readonly officialFeasibility: readonly SelectedTask[];
    };
    /** E2 may choose only a prefix/subset of this frozen order and may never switch candidates. */
    readonly officialTaskOrder: readonly SelectedTask[];
  };
  readonly stopReasons: readonly string[];
}

export interface Demo1PreRunFreeze {
  readonly schema: typeof DEMO1_PRE_RUN_FREEZE_SCHEMA;
  readonly inputs: Demo1PreRunFreezeInput;
  readonly derived: Demo1PreRunFreezeDerived;
  readonly execution: {
    readonly modelArms: number;
    readonly dockerCells: number;
    readonly previews: number;
    readonly rehearsalCells: number;
    readonly officialCells: number;
  };
}

interface ParsedDemo1UpstreamSkill {
  readonly name: string;
  readonly description: string;
  readonly sourceMd: Uint8Array;
}

interface CandidateInspection {
  readonly input: Demo1CandidateInput;
  readonly inventory: Omit<Demo1CandidateInventory, "preE2Ready" | "rejectionReasons"> & {
    readonly rejectionReasons: readonly string[];
  };
  readonly poolOverlap: boolean;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlob(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\u0000`, "utf8")
    .update(bytes)
    .digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalBytes(left)).equals(Buffer.from(canonicalBytes(right)));
}

function nonEmpty(value: string, field: string): string {
  if (value.length === 0 || /[\r\u0000]/u.test(value)) throw new TypeError(`${field} must be non-empty canonical text`);
  return value;
}

function assertExactKeys(value: object, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort(compareCodeUnitStrings);
  const expected = [...keys].sort(compareCodeUnitStrings);
  if (!canonicalEqual(actual, expected)) throw new TypeError(`${field} has unknown or missing fields`);
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
  const sourceMd = skillMd.slice(encoder.encode(sourcePrefix).length);
  if (sourceMd.length === 0) throw new TypeError("upstream SKILL.md instruction body is empty");
  return {
    name: nonEmpty(frontmatterField(frontmatter, "name"), "upstream name"),
    description: nonEmpty(frontmatterField(frontmatter, "description"), "upstream description"),
    sourceMd,
  };
}

function normalizeEvidenceRefs(refs: readonly Demo1EvidenceRef[], field: string): Demo1EvidenceRef[] {
  const normalized = refs.map((ref) => {
    assertExactKeys(ref, ["uri", "sha256"], `${field} evidence reference`);
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
  assertExactKeys(check, check.detail === undefined ? ["status", "evidence"] : ["status", "detail", "evidence"], field);
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

function expectedCandidate(repositoryPath: string): Demo1PinnedCandidateSource {
  const expected = DEMO1_PINNED_SKILLS_SOURCE.candidates.find((entry) => entry.repositoryPath === repositoryPath);
  if (expected === undefined) throw new TypeError(`candidate ${repositoryPath} is not in the pinned source tree`);
  return expected;
}

function validateCandidateSource(actual: Demo1AuthenticatedCandidateSource): void {
  const expected = expectedCandidate(actual.repositoryPath);
  assertExactKeys(actual, ["repositoryPath", "folderTree", "skill", "license"], `${actual.repositoryPath} source identity`);
  assertExactKeys(actual.skill, ["path", "gitBlob", "sha256", "bytes", "name", "description"], `${actual.repositoryPath} skill identity`);
  const expectedSkill = {
    path: expected.skill.path,
    gitBlob: expected.skill.gitBlob,
    sha256: expected.skill.sha256,
    bytes: expected.skill.bytes,
    name: expected.skill.name,
  };
  const actualSkill = {
    path: actual.skill.path,
    gitBlob: actual.skill.gitBlob,
    sha256: actual.skill.sha256,
    bytes: actual.skill.bytes,
    name: actual.skill.name,
  };
  if (actual.repositoryPath !== expected.repositoryPath
    || actual.folderTree !== expected.folderTree
    || !canonicalEqual(actualSkill, expectedSkill)
    || sha256(nonEmpty(actual.skill.description, `${actual.repositoryPath} description`)) !== expected.skill.descriptionSha256) {
    throw new TypeError(`${actual.repositoryPath} skill identity does not match the pinned Git tree`);
  }
  if (actual.license === null || expected.license === null) {
    if (actual.license !== expected.license) {
      throw new TypeError(`${actual.repositoryPath} folder-license presence does not match the pinned Git tree`);
    }
  } else {
    assertExactKeys(actual.license, ["path", "gitBlob", "sha256", "bytes", "status", "spdxId"], `${actual.repositoryPath} license identity`);
    if (!canonicalEqual(actual.license, expected.license)) {
      throw new TypeError(`${actual.repositoryPath} folder-license identity or compatibility does not match authenticated bytes`);
    }
  }
}

function decodeCanonicalBase64(value: string, field: string): Uint8Array {
  if (value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError(`${field} must be canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new TypeError(`${field} must be canonical base64`);
  return bytes;
}

function authenticatedWinnerSource(candidate: Demo1CandidateInput): ParsedDemo1UpstreamSkill {
  if (candidate.skillMdBase64 === undefined) {
    throw new TypeError(`${candidate.repositoryPath} must include authenticated source bytes before it can become winner`);
  }
  const bytes = decodeCanonicalBase64(candidate.skillMdBase64, `${candidate.repositoryPath} SKILL.md`);
  const identity = candidate.source.skill;
  if (bytes.length !== identity.bytes || sha256(bytes) !== identity.sha256 || gitBlob(bytes) !== identity.gitBlob) {
    throw new TypeError(`${candidate.repositoryPath} SKILL.md bytes do not match the pinned path/blob identity`);
  }
  const parsed = parseDemo1UpstreamSkill(bytes);
  if (parsed.name !== identity.name || parsed.description !== identity.description) {
    throw new TypeError(`${candidate.repositoryPath} parsed metadata does not match authenticated source identity`);
  }
  return parsed;
}

function inspectTask(task: Demo1TaskEligibilityInput): Demo1TaskInventory {
  assertExactKeys(task, ["taskId", "repository", "pool", "taskSha256", "image", "checks"], `${task.taskId} task`);
  nonEmpty(task.taskId, "taskId");
  nonEmpty(task.repository, "task repository");
  if (!POOLS.includes(task.pool)) throw new TypeError("task pool is invalid");
  if (!SHA256.test(task.taskSha256)) throw new TypeError("taskSha256 must be 64 lowercase hex");
  assertExactKeys(task.image, ["digest", "evidence"], `${task.taskId} image`);
  if (!SHA256_DIGEST.test(task.image.digest)) throw new TypeError("task image digest must be sha256:<64 lowercase hex>");
  const imageEvidence = normalizeEvidenceRefs(task.image.evidence, `${task.taskId} image`);
  assertExactKeys(task.checks, DEMO1_OUTCOME_BLIND_TASK_CHECKS, `${task.taskId} checks`);
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

function normalizeTaskInput(task: Demo1TaskEligibilityInput): Demo1TaskEligibilityInput {
  // Inspect first so malformed identities/checks fail before entering the canonical basis.
  inspectTask(task);
  return {
    taskId: task.taskId,
    repository: task.repository,
    pool: task.pool,
    taskSha256: task.taskSha256,
    image: {
      digest: task.image.digest,
      evidence: normalizeEvidenceRefs(task.image.evidence, `${task.taskId} image`),
    },
    checks: Object.fromEntries(DEMO1_OUTCOME_BLIND_TASK_CHECKS.map((criterion) => [
      criterion,
      normalizeCheck(task.checks[criterion], `${task.taskId} ${criterion}`),
    ])) as unknown as Demo1TaskEligibilityInput["checks"],
  };
}

function normalizeCandidateInput(input: Demo1CandidateInput): Demo1CandidateInput {
  assertExactKeys(input, input.skillMdBase64 === undefined
    ? ["repositoryPath", "source", "standalone", "tasks"]
    : ["repositoryPath", "source", "skillMdBase64", "standalone", "tasks"], `${input.repositoryPath} candidate`);
  if (input.repositoryPath !== input.source.repositoryPath) throw new TypeError("candidate/source repository path mismatch");
  validateCandidateSource(input.source);
  const tasks = input.tasks.map(normalizeTaskInput)
    .sort((left, right) => compareCodeUnitStrings(left.taskId, right.taskId));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new TypeError(`${input.repositoryPath} task ids must be unique`);
  }
  if (input.skillMdBase64 !== undefined) decodeCanonicalBase64(input.skillMdBase64, `${input.repositoryPath} SKILL.md`);
  return {
    repositoryPath: input.repositoryPath,
    source: input.source,
    ...(input.skillMdBase64 === undefined ? {} : { skillMdBase64: input.skillMdBase64 }),
    standalone: normalizeCheck(input.standalone, `${input.repositoryPath} standalone assessment`),
    tasks,
  };
}

function inspectCandidate(input: Demo1CandidateInput): CandidateInspection {
  assertExactKeys(input, input.skillMdBase64 === undefined
    ? ["repositoryPath", "source", "standalone", "tasks"]
    : ["repositoryPath", "source", "skillMdBase64", "standalone", "tasks"], `${input.repositoryPath} candidate`);
  if (input.repositoryPath !== input.source.repositoryPath) throw new TypeError("candidate/source repository path mismatch");
  validateCandidateSource(input.source);
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
  const license = input.source.license;
  const rejectionReasons = [
    ...(DEMO1_DOCUMENT_SKILL_PATHS.includes(input.repositoryPath as typeof DEMO1_DOCUMENT_SKILL_PATHS[number])
      ? ["source-available-document-skill"] : []),
    ...(license?.status !== "compatible" || license.spdxId !== "Apache-2.0"
      ? ["missing-compatible-folder-license"] : []),
    ...(standalone.status !== "match" ? ["instructions-not-standalone"] : []),
    ...(eligibleTasks.length === 0 ? ["no-grader-valid-repository-work-tasks"] : []),
    ...(poolOverlap ? ["repository-pool-overlap"] : []),
  ];
  return {
    input,
    poolOverlap,
    inventory: {
      repositoryPath: input.repositoryPath,
      sourceAuthenticated: true,
      upstreamSkillMd: {
        path: input.source.skill.path,
        gitBlob: input.source.skill.gitBlob,
        sha256: input.source.skill.sha256,
        bytes: input.source.skill.bytes,
      },
      upstreamName: input.source.skill.name,
      upstreamDescription: input.source.skill.description,
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

function rankTasks(
  tasks: readonly Demo1TaskInventory[],
  seed: number,
  candidatePath: string,
): { readonly task: Demo1TaskInventory; readonly rank: string }[] {
  return tasks.map((task) => ({ task, rank: taskRank(seed, candidatePath, task) }))
    .sort((left, right) => compareCodeUnitStrings(left.rank, right.rank)
      || compareCodeUnitStrings(left.task.taskId, right.task.taskId));
}

function selectPool(
  tasks: readonly Demo1TaskInventory[],
  count: number,
  minimumRepositories: number,
  seed: number,
  candidatePath: string,
): null | { readonly task: Demo1TaskInventory; readonly rank: string }[] {
  const ranked = rankTasks(tasks, seed, candidatePath);
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

function selectedTask(entry: { readonly task: Demo1TaskInventory; readonly rank: string }): SelectedTask {
  return {
    taskId: entry.task.taskId,
    repository: entry.task.repository,
    taskSha256: entry.task.taskSha256,
    selectionRankSha256: entry.rank,
  };
}

function sourceEligible(candidate: CandidateInspection): boolean {
  return !candidate.inventory.rejectionReasons.some((reason) => [
    "source-available-document-skill",
    "missing-compatible-folder-license",
    "instructions-not-standalone",
    "repository-pool-overlap",
  ].includes(reason));
}

function normalizeSource(source: Demo1PreRunFreezeInput["source"]): Demo1PreRunFreezeInput["source"] {
  assertExactKeys(source, ["authentication", "repositoryUrl", "commit", "commitTree", "skillsTree"], "source");
  const expected = {
    authentication: DEMO1_PINNED_SKILLS_SOURCE.authentication,
    repositoryUrl: DEMO1_PINNED_SKILLS_SOURCE.repositoryUrl,
    commit: DEMO1_PINNED_SKILLS_SOURCE.commit,
    commitTree: DEMO1_PINNED_SKILLS_SOURCE.commitTree,
    skillsTree: DEMO1_PINNED_SKILLS_SOURCE.skillsTree,
  };
  if (!canonicalEqual(source, expected)) throw new TypeError("Demo-1 source identity does not match the product-owned pinned Git tree");
  return expected;
}

function normalizeInputs(input: Demo1PreRunFreezeInput): Demo1PreRunFreezeInput {
  assertExactKeys(input, ["source", "exclusions", "outcomeBlindTaskChecks", "transform", "poolRequirements", "officialDesign", "candidates"], "pre-run inputs");
  const source = normalizeSource(input.source);
  assertExactKeys(input.exclusions, ["documentSkills"], "exclusions");
  if (!canonicalEqual(input.exclusions, { documentSkills: DEMO1_DOCUMENT_SKILL_PATHS })) {
    throw new TypeError("document-skill exclusions must remain product-owned and exact");
  }
  if (!canonicalEqual(input.outcomeBlindTaskChecks, DEMO1_OUTCOME_BLIND_TASK_CHECKS)) {
    throw new TypeError("outcome-blind task checks must remain product-owned and exact");
  }
  const expectedTransform = {
    id: DEMO1_INSTRUCTION_TRANSFORM_ID,
    specSha256: sha256(DEMO1_INSTRUCTION_TRANSFORM_SPEC),
  };
  assertExactKeys(input.transform, ["id", "specSha256"], "transform");
  if (!canonicalEqual(input.transform, expectedTransform)) throw new TypeError("instruction transform identity mismatch");
  assertExactKeys(input.poolRequirements, ["suitability", "rehearsal", "officialFeasibilityFloor"], "pool requirements");
  assertExactKeys(input.poolRequirements.suitability, ["tasks", "repositories"], "suitability requirement");
  assertExactKeys(input.poolRequirements.rehearsal, ["tasks", "repositories"], "rehearsal requirement");
  const suitability = poolRequirement(input.poolRequirements.suitability.tasks, input.poolRequirements.suitability.repositories, "suitability");
  const rehearsal = poolRequirement(input.poolRequirements.rehearsal.tasks, input.poolRequirements.rehearsal.repositories, "rehearsal");
  if (!canonicalEqual(input.poolRequirements.officialFeasibilityFloor, DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR)) {
    throw new TypeError("official feasibility floor must remain the objective paired-delta admissibility floor");
  }
  const expectedOfficialDesign = {
    status: "pending-e2" as const,
    arms: 3 as const,
    cellCeiling: 600 as const,
    targetPower: "0.80" as const,
    targetEffectPercentagePoints: "21" as const,
    exactCapacity: null,
    winnerLockedBeforeE2: true as const,
    insufficientWinnerCapacityDisposition: "stop-with-evidence-no-candidate-switch" as const,
  };
  assertExactKeys(input.officialDesign, ["status", "arms", "cellCeiling", "targetPower", "targetEffectPercentagePoints", "exactCapacity", "winnerLockedBeforeE2", "insufficientWinnerCapacityDisposition"], "official design");
  if (!canonicalEqual(input.officialDesign, expectedOfficialDesign)) {
    throw new TypeError("official design remains pending E2 and may not alter the pre-E2 winner rule");
  }
  const candidates = input.candidates.map(normalizeCandidateInput)
    .sort((left, right) => compareCodeUnitStrings(left.repositoryPath, right.repositoryPath));
  const expectedPaths = DEMO1_PINNED_SKILLS_SOURCE.candidates.map((candidate) => candidate.repositoryPath);
  if (!canonicalEqual(candidates.map((candidate) => candidate.repositoryPath), expectedPaths)) {
    throw new TypeError("candidate inventory must contain every pinned source folder exactly once");
  }
  return {
    source,
    exclusions: { documentSkills: DEMO1_DOCUMENT_SKILL_PATHS },
    outcomeBlindTaskChecks: DEMO1_OUTCOME_BLIND_TASK_CHECKS,
    transform: expectedTransform,
    poolRequirements: {
      suitability,
      rehearsal,
      officialFeasibilityFloor: DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR,
    },
    officialDesign: expectedOfficialDesign,
    candidates,
  };
}

/**
 * Builds one canonical, self-recomputing pre-run artifact. The exact official design is
 * intentionally absent: E2 runs only after this artifact freezes one winner, and may never use
 * its observed outcomes or exact capacity to switch to another candidate.
 */
export function buildDemo1PreRunFreeze(input: Demo1PreRunFreezeInput): Demo1PreRunFreeze {
  const inputs = normalizeInputs(input);
  const inspections = inputs.candidates.map(inspectCandidate);
  const selectionBasisSha256 = sha256(canonicalBytes(inputs));
  const resolved = {
    taskSelection: resolvedSeed(selectionBasisSha256, "task-selection"),
    replicateScheduling: resolvedSeed(selectionBasisSha256, "replicate-scheduling"),
    interleaving: resolvedSeed(selectionBasisSha256, "interleaving"),
    pairedBootstrap: resolvedSeed(selectionBasisSha256, "paired-bootstrap"),
  };
  const requirements = inputs.poolRequirements;
  const selections = new Map<string, {
    readonly suitability: ReturnType<typeof selectPool>;
    readonly rehearsal: ReturnType<typeof selectPool>;
    readonly officialFeasibility: ReturnType<typeof selectPool>;
    readonly officialOrder: ReturnType<typeof rankTasks>;
  }>();
  for (const candidate of inspections) {
    const eligible = candidate.inventory.tasks.filter((task) => task.eligible);
    const officialTasks = eligible.filter((task) => task.pool === "official");
    selections.set(candidate.inventory.repositoryPath, {
      suitability: selectPool(eligible.filter((task) => task.pool === "suitability"), requirements.suitability.tasks, requirements.suitability.repositories, resolved.taskSelection, candidate.inventory.repositoryPath),
      rehearsal: selectPool(eligible.filter((task) => task.pool === "rehearsal"), requirements.rehearsal.tasks, requirements.rehearsal.repositories, resolved.taskSelection, candidate.inventory.repositoryPath),
      officialFeasibility: selectPool(officialTasks, requirements.officialFeasibilityFloor.tasks, requirements.officialFeasibilityFloor.repositories, resolved.taskSelection, candidate.inventory.repositoryPath),
      officialOrder: rankTasks(officialTasks, resolved.taskSelection, candidate.inventory.repositoryPath),
    });
  }
  const candidateInventories: Demo1CandidateInventory[] = inspections.map((candidate) => {
    const selected = selections.get(candidate.inventory.repositoryPath)!;
    const capacityRejections = [
      ...(selected.suitability === null ? ["insufficient-suitability-pool"] : []),
      ...(selected.rehearsal === null ? ["insufficient-rehearsal-pool"] : []),
      ...(selected.officialFeasibility === null ? ["insufficient-official-feasibility-pool"] : []),
    ];
    const rejectionReasons = [...new Set([...candidate.inventory.rejectionReasons, ...capacityRejections])];
    return {
      ...candidate.inventory,
      preE2Ready: sourceEligible(candidate) && capacityRejections.length === 0,
      rejectionReasons,
    };
  });
  const inventoryByPath = new Map(candidateInventories.map((entry) => [entry.repositoryPath, entry]));
  const readyCandidates = inspections.filter((candidate) => inventoryByPath.get(candidate.inventory.repositoryPath)!.preE2Ready)
    .sort((left, right) => right.inventory.eligibleTaskCount - left.inventory.eligibleTaskCount
      || compareCodeUnitStrings(left.inventory.repositoryPath, right.inventory.repositoryPath));
  const winnerCandidate = readyCandidates[0];
  const winner = winnerCandidate === undefined ? null : (() => {
    const parsed = authenticatedWinnerSource(winnerCandidate.input);
    const license = winnerCandidate.input.source.license;
    if (license === null || license.status !== "compatible" || license.spdxId !== "Apache-2.0") {
      throw new TypeError("winner lacks an authenticated compatible Apache-2.0 folder license");
    }
    const artifacts = generateDemo1InstructionArtifacts(parsed.sourceMd, {
      name: parsed.name,
      description: parsed.description,
    });
    const selected = selections.get(winnerCandidate.inventory.repositoryPath)!;
    if (selected.suitability === null || selected.rehearsal === null || selected.officialFeasibility === null) {
      throw new TypeError("internal pre-E2 winner selection disagreement");
    }
    return {
      repositoryPath: winnerCandidate.inventory.repositoryPath,
      upstreamDescription: parsed.description,
      upstreamSkillMdSha256: winnerCandidate.input.source.skill.sha256,
      license: {
        spdxId: "Apache-2.0" as const,
        path: license.path,
        gitBlob: license.gitBlob,
        sha256: license.sha256,
        bytes: license.bytes,
      },
      transform: inputs.transform,
      sourceMd: { sha256: sha256(parsed.sourceMd), content: Buffer.from(parsed.sourceMd).toString("base64") },
      skillMd: { sha256: artifacts.skill.digest.sha256, content: artifacts.skill.content },
      claudeMd: { sha256: artifacts.baseline.digest.sha256, content: artifacts.baseline.content },
      selectedPools: {
        suitability: selected.suitability.map(selectedTask),
        rehearsal: selected.rehearsal.map(selectedTask),
        officialFeasibility: selected.officialFeasibility.map(selectedTask),
      },
      officialTaskOrder: selected.officialOrder.map(selectedTask),
    };
  })();
  return {
    schema: DEMO1_PRE_RUN_FREEZE_SCHEMA,
    inputs,
    derived: {
      status: winner === null ? "stop" : "ready",
      selectionBasisSha256,
      seeds: { procedure: "sha256-first-u32be-nonzero@1", resolved },
      candidates: candidateInventories,
      ranking: readyCandidates.map((candidate) => ({
        repositoryPath: candidate.inventory.repositoryPath,
        eligibleTaskCount: candidate.inventory.eligibleTaskCount,
      })),
      winner,
      stopReasons: winner === null ? ["no-candidate-meets-pre-e2-feasibility-floor"] : [],
    },
    execution: {
      modelArms: 0,
      dockerCells: 0,
      previews: 0,
      rehearsalCells: 0,
      officialCells: 0,
    },
  };
}

/** Recomputes every derived field from the artifact's own canonical inputs. */
export function verifyDemo1PreRunFreeze(freeze: Demo1PreRunFreeze): void {
  assertExactKeys(freeze, ["schema", "inputs", "derived", "execution"], "pre-run freeze");
  if (freeze.schema !== DEMO1_PRE_RUN_FREEZE_SCHEMA) throw new TypeError("pre-run freeze schema mismatch");
  const rebuilt = buildDemo1PreRunFreeze(freeze.inputs);
  if (!canonicalEqual(rebuilt.derived, freeze.derived)) {
    throw new TypeError("pre-run freeze derived fields do not recompute from canonical inputs");
  }
  if (!canonicalEqual(rebuilt.execution, freeze.execution)) {
    throw new TypeError("pre-run freeze execution accounting is not the zero-execution boundary");
  }
}

export function canonicalDemo1PreRunFreezeBytes(freeze: Demo1PreRunFreeze): Uint8Array {
  return canonicalBytes(freeze);
}

export function demo1PreRunFreezeDigest(freeze: Demo1PreRunFreeze): string {
  return `sha256:${sha256(canonicalDemo1PreRunFreezeBytes(freeze))}`;
}
