/**
 * /v1/status loop-completion + impl-state commit cadence (#959).
 *
 * Two read-only rollups that previously required `railway ssh` + a throwaway
 * SQLite script (`measure-learning.sh`):
 *
 *  - `gatherLoopCompletion` aggregates `gating.phasesCompleted` across every
 *    `task_runs.solution_outputs_json` — how far the engine loop got, and how
 *    many runs completed the full self-improvement loop.
 *  - `gatherImplStateCadence` reports per-repo commit count + last commit under
 *    the impl-state root.
 *
 * Both degrade to zeroes / an empty list on malformed / missing inputs — the
 * status endpoint must never throw because of these additions.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/store.js';
import { TaskRunPersistence } from '../harnesses/engine/persistence.js';

/** Phases the engine self-improvement loop walks; counted in `phaseCounts`. */
const FULL_LOOP_PHASES = ['improve', 'memory-consolidation'] as const;

export interface LoopCompletionStatus {
  /** Total task_runs rows scanned. */
  total: number;
  /** Rows with a non-null delivery_tx_hash. */
  delivered: number;
  /** Rows whose parsed gating.phasesCompleted had at least one phase. */
  withGating: number;
  /** Rows whose phases include 'execute'. */
  reachedExecute: number;
  /** Rows whose phases include 'improve'. */
  reachedImprove: number;
  /** Rows whose phases include 'memory-consolidation'. */
  reachedMemoryConsolidation: number;
  /** Rows whose phases include BOTH 'improve' AND 'memory-consolidation'. */
  fullLoop: number;
  /** phase -> count of rows whose phases include it. */
  phaseCounts: Record<string, number>;
}

export interface ImplStateRepoCadence {
  /** Directory name of the repo under the impl-state root. */
  name: string;
  /** `git rev-list --count HEAD`. */
  commits: number;
  /** Last commit metadata, or null when the repo has no commits / git failed. */
  lastCommit: { hash: string; subject: string; timestamp: number; date: string } | null;
}

export interface ImplStateCadenceStatus {
  /** One entry per git repo found directly under the impl-state root. */
  repos: ImplStateRepoCadence[];
  /** Present only when the root scan itself failed (degraded read). */
  error?: string;
}

/**
 * Aggregate loop-completion across all task_runs. A row's phases come from
 * `JSON.parse(solution_outputs_json).gating.phasesCompleted` (an array;
 * absent/malformed ⇒ `[]`). Never throws — malformed JSON yields `[]` for that
 * row, a store read failure yields an all-zero rollup.
 */
export function gatherLoopCompletion(store: Store): LoopCompletionStatus {
  const empty: LoopCompletionStatus = {
    total: 0,
    delivered: 0,
    withGating: 0,
    reachedExecute: 0,
    reachedImprove: 0,
    reachedMemoryConsolidation: 0,
    fullLoop: 0,
    phaseCounts: {},
  };

  let rows: Array<{ solutionOutputsJson: string | null; deliveryTxHash: string | null }>;
  try {
    rows = new TaskRunPersistence(store.db).getGatingRows();
  } catch {
    return empty;
  }

  const phaseCounts: Record<string, number> = {};
  const acc = { ...empty, phaseCounts };
  for (const row of rows) {
    acc.total += 1;
    if (row.deliveryTxHash) acc.delivered += 1;

    const phases = parsePhases(row.solutionOutputsJson);
    if (phases.length > 0) acc.withGating += 1;
    for (const phase of new Set(phases)) {
      phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
    }
    if (phases.includes('execute')) acc.reachedExecute += 1;
    if (phases.includes('improve')) acc.reachedImprove += 1;
    if (phases.includes('memory-consolidation')) acc.reachedMemoryConsolidation += 1;
    if (FULL_LOOP_PHASES.every((p) => phases.includes(p))) acc.fullLoop += 1;
  }
  return acc;
}

function parsePhases(solutionOutputsJson: string | null): string[] {
  if (!solutionOutputsJson) return [];
  try {
    const s = JSON.parse(solutionOutputsJson) as { gating?: { phasesCompleted?: unknown } };
    const phases = s.gating?.phasesCompleted;
    return Array.isArray(phases) ? phases.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Report per-repo commit cadence under the impl-state root. Each immediate
 * subdirectory containing a `.git` entry is a repo; non-repos are skipped.
 * An absent / empty / unreadable root yields an empty list. A git failure on
 * one repo degrades that repo's `commits` to 0 and `lastCommit` to null
 * without aborting the scan.
 */
export function gatherImplStateCadence(implStateDirRoot: string | undefined): ImplStateCadenceStatus {
  if (!implStateDirRoot || !existsSync(implStateDirRoot)) {
    return { repos: [] };
  }

  let entries: string[];
  try {
    entries = readdirSync(implStateDirRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    return { repos: [], error: err instanceof Error ? err.message : String(err) };
  }

  const repos: ImplStateRepoCadence[] = [];
  for (const name of entries) {
    const repoDir = join(implStateDirRoot, name);
    if (!existsSync(join(repoDir, '.git'))) continue;
    repos.push({ name, ...readRepoCadence(repoDir) });
  }
  return { repos };
}

function readRepoCadence(repoDir: string): Omit<ImplStateRepoCadence, 'name'> {
  let commits = 0;
  let lastCommit: ImplStateRepoCadence['lastCommit'] = null;
  try {
    const count = git(repoDir, ['rev-list', '--count', 'HEAD']).trim();
    commits = Number.parseInt(count, 10);
    if (!Number.isFinite(commits)) commits = 0;
  } catch {
    return { commits: 0, lastCommit: null };
  }
  try {
    // %H hash, %ct committer unix timestamp, %cI committer ISO date, %s subject.
    // Subject is last so it can contain the separator without ambiguity.
    const raw = git(repoDir, ['log', '-1', '--format=%H%x1f%ct%x1f%cI%x1f%s', 'HEAD']);
    const [hash, ts, iso, ...subjectParts] = raw.split('\x1f');
    if (hash) {
      lastCommit = {
        hash: hash.trim(),
        timestamp: Number.parseInt(ts ?? '', 10) || 0,
        date: (iso ?? '').trim(),
        subject: subjectParts.join('\x1f').replace(/\n$/, ''),
      };
    }
  } catch {
    // Keep the commit count we already have; leave lastCommit null.
  }
  return { commits, lastCommit };
}

/** Read-only `git -C <repo> …`. Bounded buffer; throws on git failure. */
function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
}
