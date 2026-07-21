/**
 * The distill run log (#1535): one JSON line per own-captures run, appended on
 * every terminal outcome (ok / partial / empty). This is the history behind
 * `distill runs` and the `lastRun` field of `distill status` — without it a
 * completed run's only trace was the staged/installed skills themselves.
 *
 * Mirrors the ledger's shape discipline: append-only JSONL, corrupt-line
 * tolerant reads (a bad line is skipped, never fatal).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** One recorded run — the `run_end` facts plus when it started. */
export interface DistillRunRecord {
  runId: string;
  startedAt: string;
  durationMs: number;
  outcome: 'ok' | 'partial' | 'empty';
  clusterCount: number;
  published: string[];
  rejectedCount: number;
  errorCount: number;
  installed: string[];
  distillModel: string;
}

/** The default run log, alongside the layer's other operator state. */
export const DEFAULT_DISTILL_RUNS_PATH = join(
  homedir(),
  '.jinn-client',
  'harness-layer',
  'distill-runs.jsonl',
);

/** Append one run record, creating the parent directory if needed. */
export function appendDistillRun(record: DistillRunRecord, path: string = DEFAULT_DISTILL_RUNS_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n', { encoding: 'utf-8' });
}

/** Read up to `limit` runs, newest-first. Corrupt lines are skipped. */
export function readDistillRuns(limit: number, path: string = DEFAULT_DISTILL_RUNS_PATH): DistillRunRecord[] {
  if (!existsSync(path)) return [];
  const records: DistillRunRecord[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as DistillRunRecord;
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.outcome === 'string') {
        records.push(parsed);
      }
    } catch {
      // Tolerate a corrupt line — the log must never brick the CLI.
    }
  }
  return records.reverse().slice(0, limit);
}
