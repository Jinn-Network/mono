import { createHash } from 'node:crypto';

import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';
import type { ValidatedPoolEntry } from '../solver-types/_swe-rebench-v2-validated-pool.js';

const QUALITY_ISSUES = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'] as const;

export interface ValidatedCleanTask {
  instance_id: string;
  hf_dataset: string;
  hf_split: string;
  rowHash: string;
  checkedAt: string;
  reason: string;
  qualityCodes: string[];
}

export interface SelectValidatedCleanTasksArgs {
  pool: PoolTask[];
  scorableEntries: Record<string, ValidatedPoolEntry>;
  excludedIds: Set<string>;
  count: number;
  seed: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function qualityAssessments(task: PoolTask): Record<string, unknown>[] | null {
  const meta = task.meta as unknown;
  if (!isObject(meta)) return null;
  const raw = meta['llm_metadata'];
  const assessments = isObject(raw) ? [raw] : raw;
  if (!Array.isArray(assessments) || assessments.length === 0) return null;
  return assessments.every(isObject) ? assessments : null;
}

export function isCleanBenchmarkTask(task: PoolTask): boolean {
  const assessments = qualityAssessments(task);
  if (!assessments) return false;
  return assessments.every((assessment) => {
    if (assessment['code'] !== 'A' || !isObject(assessment['detected_issues'])) return false;
    const issues = assessment['detected_issues'];
    return QUALITY_ISSUES.every((issue) => issues[issue] === false);
  });
}

export function distillationSourceIds(raw: unknown): Set<string> {
  if (!isObject(raw) || !Array.isArray(raw['selected'])) {
    throw new Error('distillation selection must contain a selected array');
  }
  const ids = new Set<string>();
  for (const selected of raw['selected']) {
    if (!isObject(selected) || !Array.isArray(selected['instanceIds'])) {
      throw new Error('distillation selection entry must contain an instanceIds array');
    }
    for (const id of selected['instanceIds']) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('distillation selection instanceIds must contain non-empty strings');
      }
      ids.add(id);
    }
  }
  return ids;
}

function usableValidation(entry: ValidatedPoolEntry | undefined): entry is ValidatedPoolEntry & { rowHash: string } {
  return entry?.scorable === true && typeof entry.rowHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(entry.rowHash);
}

function selectionRank(seed: string, instanceId: string): string {
  return createHash('sha256').update(`${seed}:${instanceId}`).digest('hex');
}

function selectedEntry(task: PoolTask, validation: ValidatedPoolEntry & { rowHash: string }): ValidatedCleanTask {
  const assessments = qualityAssessments(task) ?? [];
  return {
    instance_id: task.instance_id,
    hf_dataset: task.hf_dataset,
    hf_split: task.hf_split,
    rowHash: validation.rowHash,
    checkedAt: validation.checkedAt,
    reason: validation.reason,
    qualityCodes: assessments.map((assessment) => String(assessment['code'])),
  };
}

export function selectValidatedCleanTasks(args: SelectValidatedCleanTasksArgs): ValidatedCleanTask[] {
  if (!Number.isInteger(args.count) || args.count <= 0) {
    throw new Error(`selection count must be a positive integer (got ${args.count})`);
  }
  const eligible = args.pool
    .filter((task) => !args.excludedIds.has(task.instance_id))
    .filter(isCleanBenchmarkTask)
    .flatMap((task) => {
      const validation = args.scorableEntries[task.instance_id];
      return usableValidation(validation) ? [selectedEntry(task, validation)] : [];
    })
    .sort((a, b) => {
      const rank = selectionRank(args.seed, a.instance_id).localeCompare(selectionRank(args.seed, b.instance_id));
      return rank || a.instance_id.localeCompare(b.instance_id);
    });
  if (eligible.length < args.count) {
    throw new Error(`validated clean selection has ${eligible.length} eligible tasks, needs ${args.count}`);
  }
  return eligible.slice(0, args.count);
}

export function verifySelectedTaskAdmission(args: {
  selected: ValidatedCleanTask[];
  pool: PoolTask[];
  scorableEntries: Record<string, ValidatedPoolEntry>;
  excludedIds: Set<string>;
}): void {
  const byId = new Map(args.pool.map((task) => [task.instance_id, task]));
  const seen = new Set<string>();
  for (const selected of args.selected) {
    if (seen.has(selected.instance_id)) throw new Error(`duplicate selected task ${selected.instance_id}`);
    seen.add(selected.instance_id);
    if (args.excludedIds.has(selected.instance_id)) {
      throw new Error(`selected task ${selected.instance_id} is excluded by provenance or an older slate`);
    }
    const task = byId.get(selected.instance_id);
    if (!task) throw new Error(`selected task ${selected.instance_id} is missing from the production pool`);
    if (task.hf_dataset !== selected.hf_dataset) {
      throw new Error(`dataset drift for ${selected.instance_id}: ${selected.hf_dataset} -> ${task.hf_dataset}`);
    }
    if (task.hf_split !== selected.hf_split) {
      throw new Error(`split drift for ${selected.instance_id}: ${selected.hf_split} -> ${task.hf_split}`);
    }
    if (!isCleanBenchmarkTask(task)) throw new Error(`quality metadata is not clean for ${selected.instance_id}`);
    const validation = args.scorableEntries[selected.instance_id];
    if (!usableValidation(validation)) throw new Error(`current validation is missing for ${selected.instance_id}`);
    if (validation.rowHash !== selected.rowHash) {
      throw new Error(`rowHash drift for ${selected.instance_id}: ${selected.rowHash} -> ${validation.rowHash}`);
    }
  }
}
