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

/**
 * Discrimination-gate receipt (spec §2.4), written by screen-task-set.ts.
 * A baseline-only (no skill) sweep over `attempts` repeats: `keep: true`
 * means the baseline failed at least once (proven headroom for a skill to
 * change the outcome); `keep: false` covers both "baseline passed every
 * repeat" (no headroom) and "an attempt was ungradeable" (the task-set
 * author's fail-loud signal — see `ScreeningSummary` below, which is where
 * that distinction is recorded; the receipt shape itself is fixed to these
 * five fields per spec).
 *
 * Deliberately excluded from `hashTaskSet` for the same reason as
 * `GradeabilityReceipt`: it is a derived receipt produced AFTER hashing, so
 * including it would mint a new set identity on every re-screen. Set
 * membership does not change when a task is screened out — it stays in the
 * file with `keep: false`, so the screen is auditable.
 */
export interface ScreeningReceipt {
  baselinePasses: number;
  attempts: number;
  keep: boolean;
  screenedAt: string;
  model: string;
}

/** Set-level rollup of one screening pass, written alongside the per-task
 *  receipts. Also excluded from `hashTaskSet` (same reasoning as above). */
export interface ScreeningSummary {
  screenedAt: string;
  model: string;
  repeats: number;
  passThreshold: number;
  kept: string[];
  droppedNoHeadroom: string[];
  /** Fail-loud listing (spec §2.4 discussion in the v0.2 plan): tasks that
   *  passed the zero-inference gradeability gate but produced an ungradeable
   *  outcome during the baseline solve sweep. Worth investigating — a
   *  verifier that grades fine on the reference/empty patches but not on a
   *  real agent transcript is a latent verifier bug. */
  droppedUngradeable: string[];
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
  screening?: ScreeningReceipt;
}

export interface SkillTaskSetV1 {
  version: 'skill-task-set.v1';
  skill: string;
  domain: string;
  tasks: SkillTaskV1[];
  sha256: string;
  screeningSummary?: ScreeningSummary;
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

/**
 * Run-bench-side leak check, distinct from `validateTask`'s check above.
 * `validateTask` only guards the task-set's own declared `skill` field — but
 * a real run is driven by an `--arms` file whose treatment-arm `name` can
 * differ from (or be additional to) `set.skill`. Fails loud, case-
 * insensitive, same reasoning: an agent told to "use <armName>" measures
 * instruction-following, not the skill. The literal arm name `baseline` is
 * exempt (a rig convention, not a skill identity — "the baseline behavior"
 * appearing in prose is not a leak).
 */
export function assertNoArmNameLeak(set: Pick<SkillTaskSetV1, 'tasks'>, armNames: string[]): void {
  const names = [...new Set(armNames.map((n) => n.trim()).filter((n) => n && n.toLowerCase() !== 'baseline'))];
  if (names.length === 0) return;
  for (const task of set.tasks) {
    for (const part of REQUIREMENT_PARTS) {
      const text = task.requirement[part].toLowerCase();
      for (const name of names) {
        if (text.includes(name.toLowerCase())) {
          throw new TaskSetValidationError(
            `task ${task.id} requirement.${part} names arm '${name}' — the requirement must never name ` +
            `a mounted skill's arm (spec §2.2): an agent told to "use ${name}" measures instruction-` +
            `following, not the skill`,
          );
        }
      }
    }
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

// ---------------------------------------------------------------------------
// Discrimination gate (spec §2.4) — pure selection rule + set-level helpers.
// The zero-inference solve/grade work that PRODUCES the outcomes below lives
// in screen-task-set.ts (it drives run-bench.ts); everything here is pure so
// the rule itself is unit-testable without Docker/claude.
// ---------------------------------------------------------------------------

/** Fraction of baseline repeats that may pass before a task is considered to
 *  have no headroom. `1` (the default) matches the spec's literal rule:
 *  KEEP unless the baseline passed EVERY repeat. A caller may tighten this
 *  (e.g. `0.5`) to also drop tasks the baseline mostly-but-not-always
 *  solves; loosening above `1` is not meaningful and is rejected. */
export const DEFAULT_SCREENING_PASS_THRESHOLD = 1;

export interface ScreeningDecision {
  keep: boolean;
  baselinePasses: number;
  attempts: number;
  /** True if any baseline attempt for this task graded as unscorable
   *  (`passed === null`). Always forces `keep: false`, regardless of
   *  `passThreshold` — an ungradeable baseline attempt is not a headroom
   *  signal in either direction. */
  ungradeable: boolean;
}

/**
 * Selection rule (spec §2.4): given one task's baseline outcomes across
 * `--repeats` attempts (`true`/`false` = graded pass/fail, `null` =
 * ungradeable, matching `BenchOutcome.passed`'s convention):
 *
 * - any `null` outcome → `keep: false`, `ungradeable: true` (fail-loud —
 *   the task passed the pre-solve gradeability gate but produced an
 *   ungradeable result on a real attempt; investigate, don't silently drop)
 * - otherwise, baseline pass rate `< passThreshold` → `keep: true`
 *   (headroom exists)
 * - otherwise (baseline passed at/above `passThreshold`, e.g. every repeat
 *   at the default threshold of 1) → `keep: false` (no headroom)
 */
export function decideScreening(
  outcomes: (boolean | null)[],
  passThreshold: number = DEFAULT_SCREENING_PASS_THRESHOLD,
): ScreeningDecision {
  if (outcomes.length === 0) {
    throw new TaskSetValidationError('decideScreening requires at least one baseline outcome');
  }
  if (!(passThreshold > 0) || passThreshold > 1) {
    throw new TaskSetValidationError(`passThreshold must be in (0, 1], got ${passThreshold}`);
  }
  const ungradeable = outcomes.some((o) => o === null);
  const attempts = outcomes.length;
  const baselinePasses = outcomes.filter((o) => o === true).length;
  const keep = !ungradeable && baselinePasses / attempts < passThreshold;
  return { keep, baselinePasses, attempts, ungradeable };
}

/** Renders a `ScreeningDecision` into the on-disk receipt shape (spec §3
 *  deliverable): exactly `{ baselinePasses, attempts, keep, screenedAt,
 *  model }` — no `ungradeable` field, by design (see `ScreeningReceipt`'s
 *  doc comment). */
export function buildScreeningReceipt(
  outcomes: (boolean | null)[],
  opts: { model: string; passThreshold?: number; screenedAt?: string },
): ScreeningReceipt {
  const decision = decideScreening(outcomes, opts.passThreshold);
  return {
    baselinePasses: decision.baselinePasses,
    attempts: decision.attempts,
    keep: decision.keep,
    screenedAt: opts.screenedAt ?? new Date().toISOString(),
    model: opts.model,
  };
}

export function isTaskScreenedKeep(task: Pick<SkillTaskV1, 'screening'>): boolean {
  return task.screening?.keep === true;
}

/** Builds the set-level `ScreeningSummary` directly from the per-task
 *  decisions (not by reverse-engineering the persisted receipts — a
 *  dropped-and-ungradeable task can have the same `baselinePasses`/`attempts`
 *  shape as a dropped-no-headroom task, so the `ungradeable` distinction
 *  must come from the decision, not the receipt). */
export function summarizeScreeningDecisions(
  decisions: { taskId: string; decision: ScreeningDecision }[],
  opts: { model: string; repeats: number; passThreshold?: number; screenedAt: string },
): ScreeningSummary {
  const kept: string[] = [];
  const droppedNoHeadroom: string[] = [];
  const droppedUngradeable: string[] = [];
  for (const { taskId, decision } of decisions) {
    if (decision.ungradeable) droppedUngradeable.push(taskId);
    else if (decision.keep) kept.push(taskId);
    else droppedNoHeadroom.push(taskId);
  }
  return {
    screenedAt: opts.screenedAt,
    model: opts.model,
    repeats: opts.repeats,
    passThreshold: opts.passThreshold ?? DEFAULT_SCREENING_PASS_THRESHOLD,
    kept,
    droppedNoHeadroom,
    droppedUngradeable,
  };
}

/** Applies computed screening receipts + the set-level summary onto a task
 *  set, returning a new `SkillTaskSetV1`. Pure — the caller writes the
 *  result to disk. Task-set membership is never changed: a dropped task
 *  keeps its slot in `tasks`, just with `screening.keep === false`. */
export function applyScreeningResults(
  set: SkillTaskSetV1,
  receipts: Map<string, ScreeningReceipt>,
  summary: ScreeningSummary,
): SkillTaskSetV1 {
  return {
    ...set,
    tasks: set.tasks.map((t) => {
      const receipt = receipts.get(t.id);
      return receipt ? { ...t, screening: receipt } : t;
    }),
    screeningSummary: summary,
  };
}

/**
 * Measured (multi-arm) run-bench task filter (spec item 2 of the v0.2
 * discrimination-gate work): only `screening.keep === true` tasks are
 * eligible for a real paired run, with two escape hatches —
 *
 * - a task set that carries NO screening receipts at all (nobody has run
 *   screen-task-set.ts against it yet) is not hard-blocked: screening is
 *   strongly recommended (enforced by the runbook) but not required, so
 *   this logs a one-line warning and returns every task unfiltered.
 * - `includeScreenedOut: true` (run-bench.ts's `--include-screened-out`)
 *   overrides the filter entirely, with a loud warning that the resulting
 *   measurement is not interpretable per spec §2.4.
 *
 * Throws if screening receipts ARE present but every task was screened out
 * and the caller did not pass `includeScreenedOut` — there would be nothing
 * left to measure.
 */
export function selectTasksForMeasurement(
  tasks: SkillTaskV1[],
  opts: { includeScreenedOut: boolean; warn?: (message: string) => void },
): SkillTaskV1[] {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const anyScreened = tasks.some((t) => t.screening !== undefined);
  if (!anyScreened) {
    warn(
      '[bench] task set carries no screening receipts — proceeding UNSCREENED. Screening (spec §2.4, ' +
      'screen-task-set.ts) is strongly recommended and enforced by the runbook, but not hard-required here.',
    );
    return tasks;
  }
  if (opts.includeScreenedOut) {
    warn(
      `[bench] --include-screened-out set — running all ${tasks.length} task(s) regardless of the ` +
      `discrimination gate. Screened-out tasks have no proven baseline headroom; any result on them is ` +
      `NOT interpretable per spec §2.4.`,
    );
    return tasks;
  }
  const kept = tasks.filter((t) => isTaskScreenedKeep(t));
  if (kept.length === 0) {
    throw new Error(
      'every task in this set was screened out (screening.keep === false) — nothing to measure; pass ' +
      '--include-screened-out to override (not recommended) or screen a task set with proven headroom',
    );
  }
  return kept;
}
