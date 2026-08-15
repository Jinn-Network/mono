/**
 * /v1/status loop-completion + impl-state commit cadence (#959).
 *
 * Two read-only rollups that previously required `railway ssh` + a throwaway
 * SQLite script (`measure-learning.sh`):
 *
 *  - `gatherLoopCompletion` aggregates `gating.phasesCompleted` across every
 *    persisted run (extracted in SQL, not by parsing the full solution blob) —
 *    how far the engine loop got, and how many runs completed the full
 *    self-improvement loop.
 *  - `gatherImplStateCadence` reports per-repo commit count + last-commit
 *    cadence (count + short hash + timestamp) under the impl-state root. The
 *    LLM-authored commit subject is deliberately not surfaced on this un-authed
 *    endpoint.
 *
 * Both degrade to zeroes / an empty list on malformed / missing inputs — the
 * status endpoint must never throw because of these additions.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRunReadModel } from '../types/task-run-read-model.js';

/** Phases the engine self-improvement loop walks; counted in `phaseCounts`. */
const FULL_LOOP_PHASES = ['improve', 'memory-consolidation'] as const;

export interface LoopCompletionStatus {
  /** Total persisted-run rows scanned. */
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
  /**
   * Last commit cadence, or null when the repo has no commits / git failed.
   * Deliberately excludes the commit subject: the impl-state commits are
   * LLM-authored (learner promoter/consolidator messages) and can carry task
   * content / file paths / cross-operator material, and `/v1/status` is
   * un-authed. Count + short hash + timestamp is all the AC asked for.
   */
  lastCommit: { shortHash: string; timestamp: number; date: string } | null;
}

export interface ImplStateCadenceStatus {
  /** One entry per git repo found directly under the impl-state root. */
  repos: ImplStateRepoCadence[];
  /** Present only when the root scan itself failed (degraded read). */
  error?: string;
}

/** Short-TTL memo budget for the loop-completion rollup (#999). Matches the
 *  balance-cache TTL on the same `/v1/status` assemble path. */
export const LOOP_COMPLETION_TTL_MS = 30_000;

type LoopCompletionCacheEntry = { at: number; value: LoopCompletionStatus };

/** Per-db identity → last rollup. Keyed by object identity (prefer `store.db`);
 *  never by the ephemeral `taskRunReadModel()` instance. */
const loopCompletionCache = new WeakMap<object, LoopCompletionCacheEntry>();

/**
 * Aggregate loop-completion across all persisted runs. A row's phases come from the
 * `gating.phasesCompleted` array, which `getGatingRows` extracts in SQL via
 * `json_extract` so the fat `solution_outputs_json` blob never leaves SQLite
 * (this endpoint is hard-polled ~1.5s by the SPA). `phasesJson` is the JSON
 * text of that array (absent path / malformed ⇒ `[]`). Never throws — a
 * malformed array yields `[]` for that row, a store read failure yields an
 * all-zero rollup.
 *
 * Optional `opts.cacheKey` (production: `store.db`) memoizes the finished
 * rollup for `opts.ttlMs ?? LOOP_COMPLETION_TTL_MS`. On hit, skips
 * `getGatingRows` entirely. Omit `cacheKey` to always recompute (unit fakes).
 * `now` / `ttlMs` are test seams only.
 */
export function gatherLoopCompletion(
  runs: TaskRunReadModel,
  opts?: { cacheKey?: object; now?: number; ttlMs?: number },
): LoopCompletionStatus {
  const cacheKey = opts?.cacheKey;
  const ttlMs = opts?.ttlMs ?? LOOP_COMPLETION_TTL_MS;
  const now = opts?.now ?? Date.now();

  if (cacheKey) {
    const hit = loopCompletionCache.get(cacheKey);
    if (hit && now - hit.at < ttlMs) {
      return hit.value;
    }
  }

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

  let rows: Array<{ phasesJson: string | null; deliveredTxHash: string | null }>;
  try {
    rows = runs.getGatingRows();
  } catch {
    return empty;
  }

  const phaseCounts: Record<string, number> = {};
  const acc = { ...empty, phaseCounts };
  for (const row of rows) {
    acc.total += 1;
    if (row.deliveredTxHash) acc.delivered += 1;

    const phases = parsePhases(row.phasesJson);
    if (phases.length > 0) acc.withGating += 1;
    for (const phase of new Set(phases)) {
      phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
    }
    if (phases.includes('execute')) acc.reachedExecute += 1;
    if (phases.includes('improve')) acc.reachedImprove += 1;
    if (phases.includes('memory-consolidation')) acc.reachedMemoryConsolidation += 1;
    if (FULL_LOOP_PHASES.every((p) => phases.includes(p))) acc.fullLoop += 1;
  }

  if (cacheKey) {
    loopCompletionCache.set(cacheKey, { at: now, value: acc });
  }
  return acc;
}

/** Parse the JSON text of `gating.phasesCompleted` (null/malformed ⇒ `[]`). */
function parsePhases(phasesJson: string | null): string[] {
  if (!phasesJson) return [];
  try {
    const phases = JSON.parse(phasesJson) as unknown;
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
    // %h short hash, %ct committer unix timestamp, %cI committer ISO date.
    // Subject (%s) is deliberately NOT fetched — see ImplStateRepoCadence.lastCommit.
    const raw = git(repoDir, ['log', '-1', '--format=%h%x1f%ct%x1f%cI', 'HEAD']);
    const [shortHash, ts, iso] = raw.trim().split('\x1f');
    if (shortHash) {
      lastCommit = {
        shortHash: shortHash.trim(),
        timestamp: Number.parseInt(ts ?? '', 10) || 0,
        date: (iso ?? '').trim(),
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
