/**
 * Task-creator integrity guards — public-repo gate, repo-keyed exclusion,
 * synthetic quota, informative-band stop. Spec §7, §10.1, D5.
 */

import { loadActiveHeldOutSlateIds, ACTIVE_HELD_OUT_SLATE_VERSIONS } from './_swe-rebench-v2-held-out-slate.js';
import { loadCapabilitySlateRepos } from '../eval/capability-slate.js';

export const SYNTHETIC_POSTING_QUOTA_FRACTION = 0.25;
export const INFORMATIVE_BAND_LOW = 0.1;
export const INFORMATIVE_BAND_HIGH = 0.9;

export interface RepoDenylist {
  repos: Set<string>;
}

const SWE_REBENCH_V2_SOLVER_TYPE = 'swe-rebench-v2.v1';

/** Union of active held-out slate repos and cap-v0 capability-slate repos (§11). */
export function loadMintRepoDenylist(opts: { capabilitySlatesDir?: string } = {}): RepoDenylist {
  const slateIds = loadActiveHeldOutSlateIds(SWE_REBENCH_V2_SOLVER_TYPE, ACTIVE_HELD_OUT_SLATE_VERSIONS);
  const repos = new Set<string>();
  for (const id of slateIds) {
    const repo = repoFromSweInstanceId(id);
    if (repo) repos.add(repo);
  }
  for (const repo of loadCapabilitySlateRepos(opts.capabilitySlatesDir)) repos.add(repo);
  return { repos };
}

function repoFromSweInstanceId(instanceId: string): string | null {
  const m = /^(.+)__(.+)-\d+$/.exec(instanceId);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function assertRepoAllowedForMint(repo: string, denylist: RepoDenylist): void {
  if (denylist.repos.has(repo)) {
    throw new Error(`mint refused: repo ${repo} is on the held-out denylist`);
  }
}

export interface PublicRepoChecker {
  isPublic(repo: string): Promise<boolean>;
}

/** GitHub API probe. Visibility is deliberately fresh for every call. */
export function createGitHubPublicRepoChecker(opts: {
  fetchImpl?: typeof fetch;
  token?: string;
} = {}): PublicRepoChecker {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async isPublic(repo: string): Promise<boolean> {
      const parts = repo.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
      const [owner, name] = parts as [string, string];
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const res = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        { headers },
      );
      if (!res.ok) return false;
      const body = await res.json().catch(() => null) as unknown;
      return typeof body === 'object' && body !== null &&
        (body as { private?: unknown }).private === false;
    },
  };
}

export async function assertPublicRepoForPublish(
  repo: string,
  checker: PublicRepoChecker,
): Promise<void> {
  if (!(await checker.isPublic(repo))) {
    throw new Error(`publish refused: repo ${repo} is not public (D5)`);
  }
}

export function inInformativeBand(solveRate: number): boolean {
  return solveRate >= INFORMATIVE_BAND_LOW && solveRate <= INFORMATIVE_BAND_HIGH;
}

export function solveRate(passed: number, attempts: number): number {
  if (attempts === 0) return 0;
  return passed / attempts;
}

export function contestedBandDistance(solveRate: number): number {
  return Math.abs(solveRate - 0.5);
}

/** Cap synthetic postings in a batch. */
export function applySyntheticQuota<T extends { synthetic?: boolean }>(
  selected: T[],
  batchSize: number,
): T[] {
  const maxSynthetic = Math.floor(batchSize * SYNTHETIC_POSTING_QUOTA_FRACTION);
  let syntheticCount = 0;
  const out: T[] = [];
  for (const item of selected) {
    if (item.synthetic) {
      if (syntheticCount >= maxSynthetic) continue;
      syntheticCount += 1;
    }
    out.push(item);
    if (out.length >= batchSize) break;
  }
  return out;
}

export interface MintFamilyState {
  family: string;
  attempts: number;
  passes: number;
  halted: boolean;
}

export function updateMintFamilyState(
  state: MintFamilyState,
  passed: boolean,
): MintFamilyState {
  const attempts = state.attempts + 1;
  const passes = state.passes + (passed ? 1 : 0);
  const rate = solveRate(passes, attempts);
  const halted = attempts >= 5 && !inInformativeBand(rate);
  return { ...state, attempts, passes, halted };
}

/** Families outside [10%,90%] solve rate after ≥5 attempts — stop posting. */
export function computeHaltedMintFamilies(
  familyStats: Array<{ family: string; posted: number; successful: number }>,
): Set<string> {
  const byFamily = new Map<string, { posted: number; successful: number }>();
  for (const row of familyStats) {
    const cur = byFamily.get(row.family) ?? { posted: 0, successful: 0 };
    cur.posted += row.posted;
    cur.successful += row.successful;
    byFamily.set(row.family, cur);
  }
  const halted = new Set<string>();
  for (const [family, stats] of byFamily) {
    if (stats.posted >= 5 && !inInformativeBand(solveRate(stats.successful, stats.posted))) {
      halted.add(family);
    }
  }
  return halted;
}
