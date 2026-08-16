import { createHash } from "node:crypto";
import {
  compareCodeUnitStrings,
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import type { Demo1EvidenceCheck, Demo1EvidenceRef, Demo1EvidenceStatus } from "./demo1-prerun.js";

export const DEMO1_TASK_EVIDENCE_SCHEMA = "jinn.demo1.task-evidence.v1" as const;
export const DEMO1_TASK_EVIDENCE_POLICY_ID = "demo1-outcome-blind-task-evidence@1" as const;
export const DEMO1_TASK_EVIDENCE_CHECKS = [
  "domainCompatible",
  "goldPatchPasses",
  "emptyPatchFails",
  "compatibleTaskLicense",
  "instructionLeakageAbsent",
  "conflictingInstructionFileAbsent",
  "contentGoldPatchCollisionAbsent",
] as const;

export const DEMO1_PERMISSIVE_TASK_LICENSES = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "PSF-2.0",
  "Python-2.0",
  "Unlicense",
] as const;

export const DEMO1_CONFLICTING_INSTRUCTION_PATHS = [
  "CLAUDE.md",
  "AGENTS.md",
  "SKILL.md",
  ".cursorrules",
] as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FRONTEND_EXT = /\.(?:css|html?|jsx?|less|sass|scss|svelte|tsx?|vue)$/iu;
const FRONTEND_TERMS = /\b(?:accessibility|button|color|form|layout|menu|modal|navigation|page|responsive|screen|style|theme|typography|user interface|view|visual)\b/iu;
const BRAND_TERMS = /\b(?:brand|branding|brand identity|color palette|corporate identity|design system|theme|typography|visual identity)\b/iu;
const MECHANISM_TERMS = /\b(?:AGENTS\.md|CLAUDE\.md|SKILL\.md|ignore previous|system prompt)\b/iu;
const AGENT_DIRECTIVE = /(?:\b(?:agent|assistant|tool|you|your)\b.{0,80}\b(?:do|do not|don't|follow|ignore|must|open|read|run|should|use)\b)|(?:\b(?:do|do not|don't|follow|ignore|must|open|read|run|should|use)\b.{0,80}\b(?:agent|assistant|tool|you|your)\b)/iu;
const DIFF_OR_COMMIT = /(?:^|\n)(?:diff --git|@@ )|https?:\/\/github\.com\/[^\s]+\/commit\/[0-9a-f]{7,40}\b/iu;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{7,}/gu;

const encoder = new TextEncoder();

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalBytes(left)).equals(Buffer.from(canonicalBytes(right)));
}

function exactString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnitStrings);
}

function patchPaths(...patches: readonly string[]): string[] {
  const paths: string[] = [];
  for (const patch of patches) {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++ b/") && line.length > 6) paths.push(line.slice(6).split("\t", 1)[0]!);
    }
  }
  return sortedUnique(paths);
}

function longTokens(value: string): string[] {
  return sortedUnique([...(value.matchAll(IDENTIFIER))].map((match) => match[0]!.toLowerCase()));
}

function changedTokens(goldPatch: string, testPatch: string, failToPass: readonly string[]): string[] {
  const changedLines = `${goldPatch}\n${testPatch}`.split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
    .join("\n");
  return sortedUnique([
    ...longTokens(changedLines),
    ...longTokens(patchPaths(goldPatch, testPatch).join("\n")),
    ...longTokens(failToPass.join("\n")),
  ]);
}

export interface Demo1TaskEvidenceUniverseTask {
  readonly taskId: string;
  readonly repository: string;
  readonly dataset: string;
  readonly split: string;
  readonly baseCommit: string;
  readonly rowHash: string;
  readonly imageDigest: string;
  readonly imageName: string;
  readonly problemStatement: string;
  readonly goldPatch: string;
  readonly testPatch: string;
  readonly failToPass: readonly string[];
}

export interface Demo1TaskEvidenceCandidate {
  readonly repositoryPath: string;
  readonly description: string;
  readonly sourceMd: string;
}

export interface Demo1TaskExternalEvidence {
  readonly goldPatchPasses?: Demo1EvidenceCheck;
  readonly emptyPatchFails?: Demo1EvidenceCheck;
  readonly compatibleTaskLicense?: Demo1EvidenceCheck;
  readonly conflictingInstructionFileAbsent?: Demo1EvidenceCheck;
}

export interface Demo1TaskEvidenceBuildInput {
  readonly sourceSnapshots: {
    readonly poolCacheSha256: string;
    readonly validatedPoolSha256: string;
    readonly validationSemanticsVersion: string;
  };
  readonly candidates: readonly Demo1TaskEvidenceCandidate[];
  readonly tasks: readonly Demo1TaskEvidenceUniverseTask[];
  readonly externalEvidence?: Readonly<Record<string, Demo1TaskExternalEvidence>>;
}

export interface Demo1TaskEvidenceFact {
  readonly sha256: string;
  readonly fact: {
    readonly candidate: string;
    readonly taskId: string;
    readonly check: typeof DEMO1_TASK_EVIDENCE_CHECKS[number] | "imageDigest";
    readonly status: Demo1EvidenceStatus | "observed";
    readonly detail: string;
    readonly hits: readonly string[];
  };
}

export interface Demo1TaskEvidenceEntry {
  readonly candidate: string;
  readonly taskId: string;
  readonly repository: string;
  readonly dataset: string;
  readonly split: string;
  readonly baseCommit: string;
  readonly rowHash: string;
  readonly taskSha256: string;
  readonly image: { readonly digest: string; readonly name: string; readonly evidence: readonly Demo1EvidenceRef[] };
  readonly checks: Readonly<Record<typeof DEMO1_TASK_EVIDENCE_CHECKS[number], Demo1EvidenceCheck>>;
}

export interface Demo1TaskEvidenceArtifact {
  readonly schema: typeof DEMO1_TASK_EVIDENCE_SCHEMA;
  readonly policy: {
    readonly id: typeof DEMO1_TASK_EVIDENCE_POLICY_ID;
    readonly checks: typeof DEMO1_TASK_EVIDENCE_CHECKS;
    readonly permissiveLicenses: typeof DEMO1_PERMISSIVE_TASK_LICENSES;
    readonly conflictPaths: typeof DEMO1_CONFLICTING_INSTRUCTION_PATHS;
    readonly domainRule: "candidate-specific-presentation-path-and-problem-term@1";
    readonly collisionRule: "eight-character-token-intersection-no-exceptions@1";
  };
  readonly sourceSnapshots: Demo1TaskEvidenceBuildInput["sourceSnapshots"] & {
    readonly privateUniverseSha256: string;
  };
  readonly candidates: readonly {
    readonly repositoryPath: string;
    readonly descriptionSha256: string;
    readonly sourceMdSha256: string;
  }[];
  readonly universe: {
    readonly tasks: number;
    readonly repositories: number;
    readonly taskIds: readonly string[];
  };
  readonly facts: readonly Demo1TaskEvidenceFact[];
  readonly entries: readonly Demo1TaskEvidenceEntry[];
  readonly derived: readonly {
    readonly repositoryPath: string;
    readonly domainCompatibleTasks: number;
    readonly fullyEligibleTasks: number;
    readonly repositoriesWithDomainCompatibleTasks: number;
  }[];
  readonly execution: {
    readonly modelArms: 0;
    readonly previews: 0;
    readonly dockerControls: number;
  };
}

function fact(
  candidate: string,
  taskId: string,
  check: Demo1TaskEvidenceFact["fact"]["check"],
  status: Demo1TaskEvidenceFact["fact"]["status"],
  detail: string,
  hits: readonly string[] = [],
): Demo1TaskEvidenceFact {
  const payload = { candidate, taskId, check, status, detail, hits: sortedUnique(hits) };
  return { sha256: sha256(canonicalBytes(payload)), fact: payload };
}

function ref(value: Demo1TaskEvidenceFact): Demo1EvidenceRef {
  return { uri: `urn:jinn:demo1:task-evidence:${value.sha256}`, sha256: value.sha256 };
}

function checkFromFact(value: Demo1TaskEvidenceFact): Demo1EvidenceCheck {
  if (value.fact.status === "observed") throw new TypeError("observed facts are not checks");
  return { status: value.fact.status, detail: value.fact.detail, evidence: [ref(value)] };
}

function externalOrUnverifiable(
  candidate: string,
  taskId: string,
  name: "goldPatchPasses" | "emptyPatchFails" | "compatibleTaskLicense" | "conflictingInstructionFileAbsent",
  external: Demo1EvidenceCheck | undefined,
): { readonly check: Demo1EvidenceCheck; readonly facts: readonly Demo1TaskEvidenceFact[] } {
  if (external !== undefined) {
    if (!["match", "mismatch", "unverifiable"].includes(external.status)) {
      throw new TypeError(`${candidate}/${taskId} ${name} has an unknown status`);
    }
    if (external.status === "match" && external.evidence.length === 0) {
      throw new TypeError(`${candidate}/${taskId} ${name} cannot match without evidence`);
    }
    for (const source of external.evidence) {
      exactString(source.uri, `${candidate}/${taskId} ${name} evidence URI`);
      if (!SHA256.test(source.sha256)) throw new TypeError(`${candidate}/${taskId} ${name} evidence digest is invalid`);
    }
    const value = fact(
      candidate,
      taskId,
      name,
      external.status,
      external.detail ?? "externally measured under the frozen task-evidence policy",
      external.evidence.map((source) => `${source.uri}#sha256=${source.sha256}`),
    );
    return { check: checkFromFact(value), facts: [value] };
  }
  const value = fact(candidate, taskId, name, "unverifiable", "not run after the deterministic domain-capacity screen");
  return { check: checkFromFact(value), facts: [value] };
}

function domainAssessment(candidate: Demo1TaskEvidenceCandidate, task: Demo1TaskEvidenceUniverseTask) {
  const paths = patchPaths(task.goldPatch, task.testPatch);
  const presentationPaths = paths.filter((path) => FRONTEND_EXT.test(path));
  const problem = task.problemStatement;
  const domain = candidate.repositoryPath === "skills/frontend-design"
    ? FRONTEND_TERMS.test(problem) && presentationPaths.length > 0
    : candidate.repositoryPath === "skills/brand-guidelines"
      ? BRAND_TERMS.test(problem) && presentationPaths.length > 0
      : false;
  return {
    status: domain ? "match" as const : "mismatch" as const,
    detail: domain
      ? "problem and changed presentation paths match the frozen candidate-specific domain rule"
      : "task does not match the frozen candidate-specific presentation domain rule",
    hits: presentationPaths,
  };
}

function instructionAssessment(task: Demo1TaskEvidenceUniverseTask) {
  const hits = [
    ...(MECHANISM_TERMS.test(task.problemStatement) ? ["mechanism-or-system-prompt-term"] : []),
    ...(AGENT_DIRECTIVE.test(task.problemStatement) ? ["agent-directed-imperative"] : []),
  ];
  return {
    status: hits.length === 0 ? "match" as const : "mismatch" as const,
    detail: hits.length === 0 ? "no frozen instruction-leakage pattern matched" : "problem statement matched an instruction-leakage pattern",
    hits,
  };
}

function collisionAssessment(candidate: Demo1TaskEvidenceCandidate, task: Demo1TaskEvidenceUniverseTask) {
  const paths = patchPaths(task.goldPatch, task.testPatch);
  const problemPathHits = paths.filter((path) => task.problemStatement.includes(path));
  const sourceTokens = new Set(longTokens(`${candidate.description}\n${candidate.sourceMd}`));
  const goldTokens = changedTokens(task.goldPatch, task.testPatch, task.failToPass);
  const tokenHits = goldTokens.filter((token) => sourceTokens.has(token));
  const hits = sortedUnique([
    ...(DIFF_OR_COMMIT.test(task.problemStatement) ? ["problem-contains-diff-or-commit-link"] : []),
    ...problemPathHits.map((path) => `problem-contains-changed-path:${path}`),
    ...tokenHits.map((token) => `candidate-gold-token:${token}`),
  ]);
  return {
    status: hits.length === 0 ? "match" as const : "mismatch" as const,
    detail: hits.length === 0
      ? "no problem-solution or candidate-gold collision matched the frozen rule"
      : "problem-solution or candidate-gold collision matched the frozen rule",
    hits,
  };
}

function normalizeTask(task: Demo1TaskEvidenceUniverseTask): Demo1TaskEvidenceUniverseTask {
  exactString(task.taskId, "taskId");
  exactString(task.repository, "repository");
  exactString(task.dataset, "dataset");
  exactString(task.split, "split");
  if (!/^[0-9a-f]{40}$/u.test(task.baseCommit)) throw new TypeError(`${task.taskId} baseCommit must be 40 lowercase hex`);
  if (!SHA256_DIGEST.test(task.rowHash)) throw new TypeError(`${task.taskId} rowHash must be sha256:<hex>`);
  if (!SHA256_DIGEST.test(task.imageDigest)) throw new TypeError(`${task.taskId} imageDigest must be sha256:<hex>`);
  exactString(task.imageName, "imageName");
  exactString(task.problemStatement, "problemStatement");
  exactString(task.goldPatch, "goldPatch");
  if (typeof task.testPatch !== "string") throw new TypeError(`${task.taskId} testPatch must be a string`);
  if (!Array.isArray(task.failToPass) || task.failToPass.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${task.taskId} failToPass must contain only non-empty strings`);
  }
  return { ...task, failToPass: sortedUnique(task.failToPass) };
}

function fullyEligible(entry: Demo1TaskEvidenceEntry): boolean {
  return DEMO1_TASK_EVIDENCE_CHECKS.every((name) => entry.checks[name].status === "match")
    && entry.image.evidence.length > 0;
}

export function buildDemo1TaskEvidenceArtifact(input: Demo1TaskEvidenceBuildInput): Demo1TaskEvidenceArtifact {
  for (const digest of [input.sourceSnapshots.poolCacheSha256, input.sourceSnapshots.validatedPoolSha256]) {
    if (!SHA256.test(digest)) throw new TypeError("source snapshot digests must be 64 lowercase hex");
  }
  exactString(input.sourceSnapshots.validationSemanticsVersion, "validationSemanticsVersion");
  const candidates = [...input.candidates]
    .sort((left, right) => compareCodeUnitStrings(left.repositoryPath, right.repositoryPath));
  if (new Set(candidates.map((candidate) => candidate.repositoryPath)).size !== candidates.length) {
    throw new TypeError("candidate repository paths must be unique");
  }
  const tasks = input.tasks.map(normalizeTask)
    .sort((left, right) => compareCodeUnitStrings(left.taskId, right.taskId));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) throw new TypeError("task ids must be unique");

  const privateUniverseSha256 = sha256(canonicalBytes(tasks));
  const facts: Demo1TaskEvidenceFact[] = [];
  const entries: Demo1TaskEvidenceEntry[] = [];
  const controlledTasks = new Set<string>();
  for (const candidate of candidates) {
    for (const task of tasks) {
      const domain = domainAssessment(candidate, task);
      const instruction = instructionAssessment(task);
      const collision = collisionAssessment(candidate, task);
      const domainFact = fact(candidate.repositoryPath, task.taskId, "domainCompatible", domain.status, domain.detail, domain.hits);
      const instructionFact = fact(candidate.repositoryPath, task.taskId, "instructionLeakageAbsent", instruction.status, instruction.detail, instruction.hits);
      const collisionFact = fact(candidate.repositoryPath, task.taskId, "contentGoldPatchCollisionAbsent", collision.status, collision.detail, collision.hits);
      const imageFact = fact(candidate.repositoryPath, task.taskId, "imageDigest", "observed", "exact digest carried by the frozen validated-pool snapshot", [task.imageDigest]);
      const external = input.externalEvidence?.[`${candidate.repositoryPath}\u0000${task.taskId}`];
      const gold = externalOrUnverifiable(candidate.repositoryPath, task.taskId, "goldPatchPasses", external?.goldPatchPasses);
      const empty = externalOrUnverifiable(candidate.repositoryPath, task.taskId, "emptyPatchFails", external?.emptyPatchFails);
      const license = externalOrUnverifiable(candidate.repositoryPath, task.taskId, "compatibleTaskLicense", external?.compatibleTaskLicense);
      const conflict = externalOrUnverifiable(candidate.repositoryPath, task.taskId, "conflictingInstructionFileAbsent", external?.conflictingInstructionFileAbsent);
      facts.push(domainFact, instructionFact, collisionFact, imageFact, ...gold.facts, ...empty.facts, ...license.facts, ...conflict.facts);
      if (external?.goldPatchPasses !== undefined || external?.emptyPatchFails !== undefined) controlledTasks.add(task.taskId);
      const privateTask = {
        taskId: task.taskId,
        repository: task.repository,
        dataset: task.dataset,
        split: task.split,
        baseCommit: task.baseCommit,
        rowHash: task.rowHash,
        imageDigest: task.imageDigest,
        problemStatement: task.problemStatement,
        goldPatch: task.goldPatch,
        testPatch: task.testPatch,
        failToPass: task.failToPass,
      };
      entries.push({
        candidate: candidate.repositoryPath,
        taskId: task.taskId,
        repository: task.repository,
        dataset: task.dataset,
        split: task.split,
        baseCommit: task.baseCommit,
        rowHash: task.rowHash,
        taskSha256: sha256(canonicalBytes(privateTask)),
        image: { digest: task.imageDigest, name: task.imageName, evidence: [ref(imageFact)] },
        checks: {
          domainCompatible: checkFromFact(domainFact),
          goldPatchPasses: gold.check,
          emptyPatchFails: empty.check,
          compatibleTaskLicense: license.check,
          instructionLeakageAbsent: checkFromFact(instructionFact),
          conflictingInstructionFileAbsent: conflict.check,
          contentGoldPatchCollisionAbsent: checkFromFact(collisionFact),
        },
      });
    }
  }
  const derived = candidates.map((candidate) => {
    const candidateEntries = entries.filter((entry) => entry.candidate === candidate.repositoryPath);
    const domainEntries = candidateEntries.filter((entry) => entry.checks.domainCompatible.status === "match");
    return {
      repositoryPath: candidate.repositoryPath,
      domainCompatibleTasks: domainEntries.length,
      fullyEligibleTasks: candidateEntries.filter(fullyEligible).length,
      repositoriesWithDomainCompatibleTasks: new Set(domainEntries.map((entry) => entry.repository)).size,
    };
  });
  return {
    schema: DEMO1_TASK_EVIDENCE_SCHEMA,
    policy: {
      id: DEMO1_TASK_EVIDENCE_POLICY_ID,
      checks: DEMO1_TASK_EVIDENCE_CHECKS,
      permissiveLicenses: DEMO1_PERMISSIVE_TASK_LICENSES,
      conflictPaths: DEMO1_CONFLICTING_INSTRUCTION_PATHS,
      domainRule: "candidate-specific-presentation-path-and-problem-term@1",
      collisionRule: "eight-character-token-intersection-no-exceptions@1",
    },
    sourceSnapshots: { ...input.sourceSnapshots, privateUniverseSha256 },
    candidates: candidates.map((candidate) => ({
      repositoryPath: candidate.repositoryPath,
      descriptionSha256: sha256(encoder.encode(candidate.description)),
      sourceMdSha256: sha256(encoder.encode(candidate.sourceMd)),
    })),
    universe: {
      tasks: tasks.length,
      repositories: new Set(tasks.map((task) => task.repository)).size,
      taskIds: tasks.map((task) => task.taskId),
    },
    facts: facts.sort((left, right) => compareCodeUnitStrings(left.sha256, right.sha256)),
    entries: entries.sort((left, right) => compareCodeUnitStrings(left.candidate, right.candidate)
      || compareCodeUnitStrings(left.taskId, right.taskId)),
    derived,
    execution: { modelArms: 0, previews: 0, dockerControls: controlledTasks.size },
  };
}

export function verifyDemo1TaskEvidenceArtifact(artifact: Demo1TaskEvidenceArtifact): void {
  if (artifact.schema !== DEMO1_TASK_EVIDENCE_SCHEMA) throw new TypeError("task evidence schema mismatch");
  if (artifact.policy.id !== DEMO1_TASK_EVIDENCE_POLICY_ID
    || !canonicalEqual(artifact.policy.checks, DEMO1_TASK_EVIDENCE_CHECKS)
    || !canonicalEqual(artifact.policy.permissiveLicenses, DEMO1_PERMISSIVE_TASK_LICENSES)
    || !canonicalEqual(artifact.policy.conflictPaths, DEMO1_CONFLICTING_INSTRUCTION_PATHS)
    || artifact.policy.domainRule !== "candidate-specific-presentation-path-and-problem-term@1"
    || artifact.policy.collisionRule !== "eight-character-token-intersection-no-exceptions@1") {
    throw new TypeError("task evidence policy mismatch");
  }
  if (artifact.execution.modelArms !== 0 || artifact.execution.previews !== 0
    || !Number.isSafeInteger(artifact.execution.dockerControls) || artifact.execution.dockerControls < 0) {
    throw new TypeError("task-evidence artifacts may not authorize model execution or previews");
  }
  for (const digest of [artifact.sourceSnapshots.poolCacheSha256, artifact.sourceSnapshots.validatedPoolSha256, artifact.sourceSnapshots.privateUniverseSha256]) {
    if (!SHA256.test(digest)) throw new TypeError("task evidence source digest is invalid");
  }
  exactString(artifact.sourceSnapshots.validationSemanticsVersion, "validationSemanticsVersion");
  const candidatePaths = artifact.candidates.map((candidate) => candidate.repositoryPath);
  if (new Set(candidatePaths).size !== candidatePaths.length
    || !canonicalEqual([...candidatePaths].sort(compareCodeUnitStrings), candidatePaths)) {
    throw new TypeError("task evidence candidates are not canonical and unique");
  }
  for (const candidate of artifact.candidates) {
    exactString(candidate.repositoryPath, "task evidence candidate repository path");
    if (!SHA256.test(candidate.descriptionSha256) || !SHA256.test(candidate.sourceMdSha256)) {
      throw new TypeError("task evidence candidate identity is invalid");
    }
  }
  if (!Number.isSafeInteger(artifact.universe.tasks) || artifact.universe.tasks < 0
    || !Number.isSafeInteger(artifact.universe.repositories) || artifact.universe.repositories < 0
    || new Set(artifact.universe.taskIds).size !== artifact.universe.taskIds.length
    || !canonicalEqual([...artifact.universe.taskIds].sort(compareCodeUnitStrings), artifact.universe.taskIds)) {
    throw new TypeError("task evidence universe is not canonical");
  }
  const facts = new Map<string, Demo1TaskEvidenceFact>();
  const orderedFacts = [...artifact.facts].sort((left, right) => compareCodeUnitStrings(left.sha256, right.sha256));
  if (!canonicalEqual(orderedFacts, artifact.facts)) throw new TypeError("task evidence facts are not canonical");
  for (const value of artifact.facts) {
    if (sha256(canonicalBytes(value.fact)) !== value.sha256) throw new TypeError("task evidence fact digest mismatch");
    if (facts.has(value.sha256)) throw new TypeError("duplicate task evidence fact");
    facts.set(value.sha256, value);
  }
  const ordered = [...artifact.entries].sort((left, right) => compareCodeUnitStrings(left.candidate, right.candidate)
    || compareCodeUnitStrings(left.taskId, right.taskId));
  if (!canonicalEqual(ordered, artifact.entries)) throw new TypeError("task evidence entries are not canonical");
  const expectedEntryKeys = candidatePaths.flatMap((candidate) => artifact.universe.taskIds.map((taskId) => `${candidate}\u0000${taskId}`));
  const actualEntryKeys = artifact.entries.map((entry) => `${entry.candidate}\u0000${entry.taskId}`);
  if (!canonicalEqual(expectedEntryKeys, actualEntryKeys)) {
    throw new TypeError("task evidence entries do not cover the exact candidate/task cross product");
  }
  const identitiesByTask = new Map<string, unknown>();
  const referencedFacts = new Set<string>();
  for (const entry of artifact.entries) {
    exactString(entry.candidate, "task evidence candidate");
    exactString(entry.taskId, "task evidence task id");
    exactString(entry.repository, "task evidence repository");
    exactString(entry.dataset, "task evidence dataset");
    exactString(entry.split, "task evidence split");
    exactString(entry.image.name, "task evidence image name");
    if (!/^[0-9a-f]{40}$/u.test(entry.baseCommit) || !SHA256_DIGEST.test(entry.rowHash)
      || !SHA256.test(entry.taskSha256) || !SHA256_DIGEST.test(entry.image.digest)) {
      throw new TypeError("task evidence identity is invalid");
    }
    const identity = {
      repository: entry.repository,
      dataset: entry.dataset,
      split: entry.split,
      baseCommit: entry.baseCommit,
      rowHash: entry.rowHash,
      taskSha256: entry.taskSha256,
      image: { digest: entry.image.digest, name: entry.image.name },
    };
    const priorIdentity = identitiesByTask.get(entry.taskId);
    if (priorIdentity !== undefined && !canonicalEqual(priorIdentity, identity)) {
      throw new TypeError("task identity differs across candidates");
    }
    identitiesByTask.set(entry.taskId, identity);
    if (entry.image.evidence.length !== 1) throw new TypeError("task image must have exactly one evidence fact");
    const imageReference = entry.image.evidence[0]!;
    const imageFact = facts.get(imageReference.sha256);
    if (imageReference.uri !== `urn:jinn:demo1:task-evidence:${imageReference.sha256}`
      || imageFact?.fact.candidate !== entry.candidate || imageFact.fact.taskId !== entry.taskId
      || imageFact.fact.check !== "imageDigest" || imageFact.fact.status !== "observed"
      || !imageFact.fact.hits.includes(entry.image.digest)) {
      throw new TypeError("task image evidence does not bind its candidate, task, and digest");
    }
    referencedFacts.add(imageReference.sha256);
    for (const name of DEMO1_TASK_EVIDENCE_CHECKS) {
      if (!["match", "mismatch", "unverifiable"].includes(entry.checks[name].status)) throw new TypeError("task evidence check status is invalid");
      if (entry.checks[name].evidence.length !== 1) throw new TypeError("task evidence check must have exactly one proof fact");
      const reference = entry.checks[name].evidence[0]!;
      const value = facts.get(reference.sha256);
      if (reference.uri !== `urn:jinn:demo1:task-evidence:${reference.sha256}`
        || value?.fact.candidate !== entry.candidate || value.fact.taskId !== entry.taskId
        || value.fact.check !== name || value.fact.status !== entry.checks[name].status
        || value.fact.detail !== entry.checks[name].detail) {
        throw new TypeError(`${entry.candidate}/${entry.taskId} ${name} evidence does not bind the check`);
      }
      referencedFacts.add(reference.sha256);
    }
  }
  if (referencedFacts.size !== artifact.facts.length) throw new TypeError("task evidence contains unreferenced facts");
  if (artifact.universe.tasks !== identitiesByTask.size
    || artifact.universe.repositories !== new Set([...identitiesByTask.values()]
      .map((identity) => (identity as { repository: string }).repository)).size) {
    throw new TypeError("task evidence universe counts mismatch");
  }
  const expectedDerived = artifact.candidates.map((candidate) => {
    const entries = artifact.entries.filter((entry) => entry.candidate === candidate.repositoryPath);
    const domain = entries.filter((entry) => entry.checks.domainCompatible.status === "match");
    return {
      repositoryPath: candidate.repositoryPath,
      domainCompatibleTasks: domain.length,
      fullyEligibleTasks: entries.filter(fullyEligible).length,
      repositoriesWithDomainCompatibleTasks: new Set(domain.map((entry) => entry.repository)).size,
    };
  });
  if (!canonicalEqual(expectedDerived, artifact.derived)) throw new TypeError("task evidence derived counts mismatch");
  const expectedControls = new Set(artifact.entries
    .filter((entry) => entry.checks.goldPatchPasses.detail !== "not run after the deterministic domain-capacity screen"
      || entry.checks.emptyPatchFails.detail !== "not run after the deterministic domain-capacity screen")
    .map((entry) => entry.taskId)).size;
  if (artifact.execution.dockerControls !== expectedControls) throw new TypeError("task evidence Docker accounting mismatch");
}

export function canonicalDemo1TaskEvidenceBytes(artifact: Demo1TaskEvidenceArtifact): Uint8Array {
  verifyDemo1TaskEvidenceArtifact(artifact);
  return canonicalBytes(artifact);
}

export function demo1TaskEvidenceDigest(artifact: Demo1TaskEvidenceArtifact): string {
  return sha256(canonicalDemo1TaskEvidenceBytes(artifact));
}
