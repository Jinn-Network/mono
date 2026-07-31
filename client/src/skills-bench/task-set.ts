/**
 * Custom, per-skill authored task sets (spec §2.2 of
 * docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md, v0.2). A
 * `SkillTaskSetV1` is a pinned repo/commit/image per task plus a four-part
 * requirement document (background/requirement/fileOps/acceptance) that
 * never names the skill under test, one or more deterministic pytest
 * verifier files, and a known-good reference patch. Loader + hashing mirror
 * slate.ts's canonical-JSON pattern; validation encodes the spec rules that
 * make a task set eligible to grade at all.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskRequirement {
  background: string;
  requirement: string;
  fileOps: string;
  acceptance: string;
}

/** Zero-inference both-directions gradeability receipt (spec §2.3), written
 *  by validate-task-set.ts. Deliberately excluded from `hashTaskSet` — it is
 *  a derived receipt produced AFTER hashing, and including it would mean
 *  every re-validation mints a new set identity. */
export interface GradeabilityReceipt {
  status: 'pass';
  checkedAt: string;
  referenceMs: number;
  emptyMs: number;
  gradeLogDigest: string;
}

export interface SkillTaskV1 {
  id: string;
  repo: string;
  commit: string;
  image: string;
  requirement: TaskRequirement;
  /** Paths relative to the task-set directory. */
  verifierFiles: string[];
  /** Path relative to the task-set directory. */
  referencePatchFile: string;
  timeoutMs?: number;
  gradeability?: GradeabilityReceipt;
}

export interface SkillTaskSetV1 {
  version: 'skill-task-set.v1';
  skill: string;
  domain: string;
  tasks: SkillTaskV1[];
  sha256: string;
}

export class TaskSetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskSetValidationError';
  }
}

async function fileDigest(dir: string, relPath: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, relPath));
  } catch (err) {
    throw new TaskSetValidationError(
      `task-set file missing or unreadable: '${relPath}' under ${dir} (${(err as Error).message})`,
    );
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * sha256 over set membership + requirement text + verifier-file bytes +
 * reference-patch bytes (via their own digests, read fresh from `dir`) —
 * mirrors slate.ts's canonical-JSON hashing. On-disk tampering with a
 * verifier file, the reference patch, or the requirement text changes this
 * hash even though set.json's byte-for-byte task-object fields might not
 * otherwise reveal it. `gradeability` is intentionally excluded (see the
 * doc comment on {@link GradeabilityReceipt}).
 */
export async function hashTaskSet(
  dir: string,
  set: Pick<SkillTaskSetV1, 'version' | 'skill' | 'domain' | 'tasks'>,
): Promise<string> {
  const tasks = await Promise.all(set.tasks.map(async (t) => ({
    id: t.id,
    repo: t.repo,
    commit: t.commit,
    image: t.image,
    requirement: t.requirement,
    verifierFiles: t.verifierFiles,
    verifierFileHashes: await Promise.all(t.verifierFiles.map((vf) => fileDigest(dir, vf))),
    referencePatchFile: t.referencePatchFile,
    referencePatchHash: await fileDigest(dir, t.referencePatchFile),
    timeoutMs: t.timeoutMs ?? null,
  })));
  const canonical = JSON.stringify({ version: set.version, skill: set.skill, domain: set.domain, tasks });
  return createHash('sha256').update(canonical).digest('hex');
}

const REQUIREMENT_PARTS: (keyof TaskRequirement)[] = ['background', 'requirement', 'fileOps', 'acceptance'];

function validateTask(set: Pick<SkillTaskSetV1, 'skill'>, task: SkillTaskV1): void {
  if (!task.id) throw new TaskSetValidationError('task missing id');
  if (!task.repo) throw new TaskSetValidationError(`task ${task.id} missing repo`);
  if (!task.commit) throw new TaskSetValidationError(`task ${task.id} missing commit`);
  if (!task.image) throw new TaskSetValidationError(`task ${task.id} missing image`);
  if (!task.referencePatchFile) throw new TaskSetValidationError(`task ${task.id} missing referencePatchFile`);
  if (!Array.isArray(task.verifierFiles) || task.verifierFiles.length === 0) {
    throw new TaskSetValidationError(
      `task ${task.id} has no verifierFiles — a task with zero verifiers can never be graded`,
    );
  }
  const req = task.requirement;
  for (const part of REQUIREMENT_PARTS) {
    if (!req || typeof req[part] !== 'string' || !req[part].trim()) {
      throw new TaskSetValidationError(
        `task ${task.id} requirement.${part} is missing — all 4 parts (background/requirement/` +
        `fileOps/acceptance) are required (spec §2.2)`,
      );
    }
  }
  const skillName = set.skill.trim().toLowerCase();
  if (skillName) {
    for (const part of REQUIREMENT_PARTS) {
      if (req[part].toLowerCase().includes(skillName)) {
        throw new TaskSetValidationError(
          `task ${task.id} requirement.${part} names the skill under test ('${set.skill}') — the ` +
          `requirement must never name the skill (spec §2.2): an agent told to "use ${set.skill}" ` +
          `measures instruction-following, not the skill`,
        );
      }
    }
  }
}

/** Validates the spec rules that make a task set eligible to author verifiers
 *  against at all. Does NOT check gradeability (that is validate-task-set.ts's
 *  job) or on-disk hash integrity (that is `loadTaskSet`'s job). */
export function validateTaskSet(set: SkillTaskSetV1): void {
  if (set.version !== 'skill-task-set.v1') {
    throw new TaskSetValidationError(`unsupported task-set version '${set.version}'`);
  }
  if (!set.skill) throw new TaskSetValidationError('task set missing skill');
  if (!set.domain) throw new TaskSetValidationError('task set missing domain');
  if (!Array.isArray(set.tasks) || set.tasks.length === 0) {
    throw new TaskSetValidationError('task set has no tasks');
  }
  const seen = new Set<string>();
  for (const task of set.tasks) {
    if (seen.has(task.id)) throw new TaskSetValidationError(`duplicate task id '${task.id}'`);
    seen.add(task.id);
    validateTask(set, task);
  }
}

/** Load `<dir>/set.json`, validate it (spec rules), and verify its declared
 *  `sha256` against a fresh hash of the referenced files — fail loud on any
 *  mismatch (set.json or a verifier/reference-patch file was edited without
 *  re-hashing). */
export async function loadTaskSet(dir: string): Promise<SkillTaskSetV1> {
  const raw = await readFile(join(dir, 'set.json'), 'utf8');
  const set = JSON.parse(raw) as SkillTaskSetV1;
  validateTaskSet(set);
  const expected = await hashTaskSet(dir, set);
  if (expected !== set.sha256) {
    throw new TaskSetValidationError(
      `task-set sha256 mismatch at ${dir}: set.json declares ${set.sha256} but recomputed ${expected} — ` +
      `set.json or a referenced verifier/reference-patch file was edited without re-hashing`,
    );
  }
  return set;
}

export function isTaskGradeabilityPassing(task: SkillTaskV1): boolean {
  return task.gradeability?.status === 'pass';
}

/** The zero-inference gradeability gate (spec §2.3), enforced BEFORE any
 *  solve spend. Fail-loud, manifest-guard style: refuses the whole set if
 *  even one task lacks a passing gradeability receipt. Extracted here (not
 *  inlined in run-bench.ts) so the refusal logic is unit-testable without a
 *  CLI invocation. */
export function assertTaskSetGradeable(set: SkillTaskSetV1): void {
  const ungraded = set.tasks.filter((t) => !isTaskGradeabilityPassing(t));
  if (ungraded.length > 0) {
    throw new Error(
      `task-set '${set.skill}' has ${ungraded.length}/${set.tasks.length} task(s) without a passing ` +
      `gradeability receipt (${ungraded.map((t) => t.id).join(', ')}) — run validate-task-set.ts ` +
      `before any solve spend`,
    );
  }
}
