/**
 * Daemon harvest loop — commit-echo mining from configured local repos.
 * Spec §5.2; plan: end-to-end harvest slice.
 */

import { spawnSync } from 'node:child_process';
import { discoverCommitEchoCandidates } from '../solver-types/_swe-rebench-v2-commit-echo.js';
import {
  createGitCommitEchoDeps,
  type GitCommitEchoRepoConfig,
} from '../solver-types/_swe-rebench-v2-commit-echo-git.js';
import { HarvestStateStore } from '../solver-types/_swe-rebench-v2-harvest-state.js';
import {
  admitBuiltMintCandidates,
  buildCommitEchoMintCandidate,
  findSourceInstanceForRepo,
  type HarvestMintDeps,
} from '../solver-types/_swe-rebench-v2-harvest.js';
import {
  EVAL_SEMANTICS_VERSION,
  ValidatedPoolStore,
} from '../solver-types/_swe-rebench-v2-validated-pool.js';
import { loadSweRebenchV2Pool } from '../solver-types/swe-rebench-v2.js';
import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';
import type { Store } from '../store/store.js';
import { emitEvent } from '../observability/emit-event.js';
import { recordLoopTick } from './loop-heartbeat.js';

export interface HarvestRepoConfig {
  path: string;
  repo: string;
  remote?: string;
}

export interface HarvestLoopConfig {
  intervalMs: number;
  stateDir: string;
  repos: HarvestRepoConfig[];
  limitPerRepo: number;
  publish: boolean;
  minterSafe?: string;
  mintDeps: Omit<HarvestMintDeps, 'publish' | 'minterSafe'>;
  loadPool?: () => Promise<PoolTask[]>;
  validatedStore?: ValidatedPoolStore;
  harvestState?: HarvestStateStore;
  isDockerAvailable?: () => boolean;
  store?: Store;
  now?: () => number;
}

export interface HarvestTickResult {
  discovered: number;
  admitted: string[];
  rejected: Array<{ instance_id: string; reason: string }>;
  skipped: string[];
}

function defaultDockerCheck(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

export async function runHarvestTick(config: HarvestLoopConfig): Promise<HarvestTickResult> {
  const dockerOk = (config.isDockerAvailable ?? defaultDockerCheck)();
  if (!dockerOk) {
    return { discovered: 0, admitted: [], rejected: [], skipped: ['docker-unavailable'] };
  }

  const validatedStore = config.validatedStore ?? new ValidatedPoolStore({ stateDir: config.stateDir });
  const harvestState = config.harvestState ?? new HarvestStateStore({ stateDir: config.stateDir });
  const scorableIds = await validatedStore.getScorableIds(EVAL_SEMANTICS_VERSION);
  if (!scorableIds || scorableIds.size === 0) {
    return { discovered: 0, admitted: [], rejected: [], skipped: ['no-validated-pool'] };
  }

  const pool = await (config.loadPool ?? loadSweRebenchV2Pool)();
  const admitted: string[] = [];
  const rejected: Array<{ instance_id: string; reason: string }> = [];
  const skipped: string[] = [];
  let discovered = 0;

  for (const repoCfg of config.repos) {
    const repoState = await harvestState.getRepo(repoCfg.repo);
    const snapshot = repoState?.lastScannedCommit ?? '';
    const gitDeps = createGitCommitEchoDeps(repoCfg as GitCommitEchoRepoConfig);
    const candidates = await discoverCommitEchoCandidates(
      [{ repo: repoCfg.repo, snapshotCommit: snapshot }],
      gitDeps,
      { limitPerRepo: config.limitPerRepo },
    );
    discovered += candidates.length;

    let lastCommit = snapshot;
    for (const candidate of candidates) {
      lastCommit = candidate.fix_commit;
      if (harvestState.isRejected(repoState, candidate.instance_id)) {
        skipped.push(candidate.instance_id);
        continue;
      }

      const source = findSourceInstanceForRepo(pool, scorableIds, candidate.repo);
      if (!source) {
        const reason = `no admitted source instance for repo ${candidate.repo}`;
        rejected.push({ instance_id: candidate.instance_id, reason });
        await harvestState.recordRejected(repoCfg.repo, candidate.instance_id, reason);
        continue;
      }

      const builtResult = await buildCommitEchoMintCandidate({
        candidate,
        source,
        fetcher: config.mintDeps.hfFetcher,
        runner: config.mintDeps.runner,
        minterSafe: config.minterSafe,
      });
      if (!builtResult.built) {
        const reason = builtResult.reason ?? 'build-failed';
        rejected.push({ instance_id: candidate.instance_id, reason });
        await harvestState.recordRejected(repoCfg.repo, candidate.instance_id, reason);
        continue;
      }

      const mintResult = await admitBuiltMintCandidates([builtResult.built], {
        ...config.mintDeps,
        publish: config.publish,
        minterSafe: config.minterSafe,
      });
      for (const id of mintResult.admitted) admitted.push(id);
      for (const r of mintResult.rejected) {
        rejected.push(r);
        await harvestState.recordRejected(repoCfg.repo, r.instance_id, r.reason);
      }
      if (config.store) {
        for (const id of mintResult.admitted) {
          emitEvent(config.store, {
            kind: 'harvest_admitted',
            requestId: id,
            outcome: 'ok',
            detail: `commit-echo ${candidate.repo}@${candidate.fix_commit.slice(0, 8)}`,
          }, 'harvest-loop');
        }
      }
    }

    if (lastCommit && lastCommit !== snapshot) {
      await harvestState.setLastScannedCommit(repoCfg.repo, lastCommit);
    }
  }

  return { discovered, admitted, rejected, skipped };
}

export async function resolveHarvestRepoConfigs(
  repos: Array<{ path: string; repo?: string; remote?: string }>,
): Promise<HarvestRepoConfig[]> {
  const { resolveHarvestRepoSlug } = await import('../solver-types/_swe-rebench-v2-commit-echo-git.js');
  const out: HarvestRepoConfig[] = [];
  for (const r of repos) {
    let repo = r.repo;
    if (!repo) {
      repo = (await resolveHarvestRepoSlug(r.path, r.remote ?? 'origin')) ?? undefined;
    }
    if (!repo) {
      console.warn(`[harvest] skipping ${r.path}: cannot resolve owner/repo slug`);
      continue;
    }
    out.push({ path: r.path, repo, ...(r.remote ? { remote: r.remote } : {}) });
  }
  return out;
}

export class HarvestLoop {
  private stopped = false;

  constructor(private readonly config: HarvestLoopConfig) {}

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<HarvestTickResult> {
    const result = await runHarvestTick(this.config);
    if (this.config.store) {
      recordLoopTick(this.config.store, 'harvest');
      if (result.admitted.length > 0 || result.rejected.length > 0) {
        console.log(
          `[harvest-loop] tick: discovered=${result.discovered} admitted=${result.admitted.length} rejected=${result.rejected.length}`,
        );
      }
    }
    return result;
  }

  async run(): Promise<void> {
    if (this.config.intervalMs <= 0) return;
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (err) {
        console.error(
          '[harvest-loop] tick failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      }
      await new Promise<void>((r) => setTimeout(r, this.config.intervalMs));
    }
  }
}
