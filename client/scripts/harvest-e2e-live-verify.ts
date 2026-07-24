#!/usr/bin/env tsx
/**
 * Live harvest e2e verification — production wiring, real Docker + IPFS.
 *
 * Prepares harvest cursor on a known fix-shaped sympy commit, runs one harvest
 * tick with the same deps as `main.ts`, and asserts runbook pass criteria.
 *
 * Usage:
 *   yarn task-creator:harvest-e2e-live
 *
 * Optional env:
 *   JINN_HARVEST_REPO_PATH  — local clone (default: ~/.jinn-client/harvest-repos/sympy)
 *   JINN_HARVEST_FIX_COMMIT — fix commit to harvest (default: sympy elliptic-curve fix)
 *   JINN_SWE_REBENCH_V2_STATE_DIR — override state dir (default: ~/.jinn-client/swe-rebench-v2)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHarvestTick } from '../src/daemon/harvest-loop.js';
import { readEnabledState, defaultSweRebenchV2EvaluatorImplStateDir } from '../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { HttpHfFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { RoutingTaskRowFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js';
import { createGitHubPublicRepoChecker } from '../src/solver-types/_swe-rebench-v2-guards.js';
import { HarvestStateStore } from '../src/solver-types/_swe-rebench-v2-harvest-state.js';
import { loadMintedPoolTasks, getDefaultMintedPoolStore } from '../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { syntheticClaimBlocked } from '../src/solver-types/_swe-rebench-v2-synthetic-claim.js';
import { resolveMintedTaskDeliveryRate } from '../src/solver-types/_swe-rebench-v2-escrow.js';
import { DEFAULT_SYNTHETIC_ESCROW_PARAMS, escrowInputsFromPatch } from '../src/solver-types/_swe-rebench-v2-harvest.js';
import {
  defaultStateDir,
  getSweRebenchV2ValidatedPoolStore,
  loadSweRebenchV2Pool,
} from '../src/solver-types/swe-rebench-v2.js';
import { loadConfig } from '../src/config.js';

const REPO = process.env.JINN_HARVEST_REPO ?? 'sympy/sympy';
const DEFAULT_FIX = '1d66a549775161d2d18a2d71f5117f7f978900a7';
const DEFAULT_REPO_PATH = join(homedir(), '.jinn-client', 'harvest-repos', 'sympy');

function fail(msg: string): never {
  console.error(`[harvest-e2e-live] FAIL: ${msg}`);
  process.exit(1);
}

function requireDocker(): void {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (r.status !== 0) fail('Docker daemon not reachable');
}

function parentCommit(repoPath: string, fixCommit: string): string {
  const r = spawnSync('git', ['-C', repoPath, 'rev-parse', `${fixCommit}^`], { encoding: 'utf8' });
  if (r.status !== 0) fail(`cannot resolve parent of ${fixCommit}: ${r.stderr}`);
  return r.stdout.trim();
}

async function main(): Promise<void> {
  requireDocker();

  const repoPath = process.env.JINN_HARVEST_REPO_PATH ?? DEFAULT_REPO_PATH;
  const fixCommit = process.env.JINN_HARVEST_FIX_COMMIT ?? DEFAULT_FIX;
  if (!existsSync(join(repoPath, '.git'))) {
    fail(`missing git clone at ${repoPath} — clone https://github.com/sympy/sympy.git first`);
  }

  const implStateDir = defaultSweRebenchV2EvaluatorImplStateDir();
  const enabled = readEnabledState(implStateDir);
  if (!enabled?.upstreamRepoDir || !existsSync(enabled.upstreamRepoDir)) {
    fail('swe-rebench-v2 evaluator not enabled — run `jinn harnesses enable swe-rebench-v2-evaluator`');
  }

  const stateDir = process.env.JINN_SWE_REBENCH_V2_STATE_DIR ?? defaultStateDir();
  const validatedPath = join(stateDir, 'validated-pool.json');
  if (!existsSync(validatedPath)) {
    fail(`missing validated pool at ${validatedPath}`);
  }

  const snapshot = parentCommit(repoPath, fixCommit);
  const harvestState = new HarvestStateStore({ stateDir });
  await harvestState.setLastScannedCommit(REPO, snapshot);
  console.log(`[harvest-e2e-live] cursor ${REPO}@${snapshot.slice(0, 8)} → fix ${fixCommit.slice(0, 8)}`);

  const config = loadConfig();
  const earningRaw = existsSync(join(homedir(), '.jinn-client', 'earning', 'earning_state.json'))
    ? JSON.parse(readFileSync(join(homedir(), '.jinn-client', 'earning', 'earning_state.json'), 'utf8'))
    : null;
  const minterSafe: string | undefined =
    earningRaw?.fleet_safe_address ??
    earningRaw?.services?.find((s: { step?: string }) => s.step === 'complete')?.safe_address;

  const validatedStore = getSweRebenchV2ValidatedPoolStore(stateDir);
  const mintedStore = getDefaultMintedPoolStore(stateDir);
  const runner = new PythonEvalRunner({ upstreamRepoDir: enabled.upstreamRepoDir });

  console.log('[harvest-e2e-live] running harvest tick (real Docker eval — may take several minutes on arm64)…');
  const started = Date.now();
  const result = await runHarvestTick({
    intervalMs: 60_000,
    stateDir,
    repos: [{ path: repoPath, repo: REPO }],
    limitPerRepo: 1,
    limitPerTick: 3,
    publish: true,
    minterSafe,
    harvestState,
    validatedStore,
    loadPool: loadSweRebenchV2Pool,
    mintDeps: {
      stateDir,
      ipfsRegistryUrl: config.ipfsRegistryUrl,
      ipfsGatewayUrl: config.ipfsGatewayUrl,
      validatedStore,
      mintedStore,
      hfFetcher: new HttpHfFetcher(),
      runner,
      upstreamRepoDir: enabled.upstreamRepoDir,
      publicRepoChecker: createGitHubPublicRepoChecker({ token: process.env.GITHUB_TOKEN }),
    },
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[harvest-e2e-live] tick done in ${elapsed}s:`, JSON.stringify(result));

  if (result.admitted.length === 0) {
    fail(`no candidates admitted — rejected=${JSON.stringify(result.rejected)} skipped=${JSON.stringify(result.skipped)}`);
  }

  const publishedCid = await mintedStore.getPublishedArtifactCid(
    (await import('../src/solver-types/_swe-rebench-v2-validated-pool.js')).EVAL_SEMANTICS_VERSION,
  );
  if (!publishedCid) fail('minted pool missing published artifact CID after publish=true');

  const poolTasks = await loadMintedPoolTasks(mintedStore);
  if (poolTasks.length === 0) fail('loadMintedPoolTasks returned empty after admission');

  const admittedId = result.admitted[0]!;
  const task = poolTasks.find((t) => t.instance_id === admittedId) ?? poolTasks[0]!;
  const routingFetcher = new RoutingTaskRowFetcher({
    hf: new HttpHfFetcher(),
    fetchMintedArtifact: async (cid) => {
      const { fetchFromIpfs } = await import('../src/adapters/mech/ipfs.js');
      const raw = await fetchFromIpfs(config.ipfsGatewayUrl, cid);
      const { parseMintedPoolArtifact } = await import('../src/harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js');
      return parseMintedPoolArtifact(raw);
    },
  });
  const row = await routingFetcher.fetchTaskRow({
    hf_dataset: task.hf_dataset,
    hf_split: task.hf_split,
    instance_id: task.instance_id,
  });
  if (row.FAIL_TO_PASS.length === 0) fail('resolved row has empty FAIL_TO_PASS');

  if (minterSafe) {
    const entry = await mintedStore.getEntry(task.instance_id, (await import('../src/solver-types/_swe-rebench-v2-validated-pool.js')).EVAL_SEMANTICS_VERSION);
    const blocked = syntheticClaimBlocked(entry?.provenance, minterSafe);
    if (!blocked) fail('expected minter self-claim to be blocked');
    console.log(`[harvest-e2e-live] synthetic claim blocked: ${blocked}`);
  }

  const baseRate = 1_000_000_000_000_000_000n;
  const weighted = resolveMintedTaskDeliveryRate(baseRate, {
    syntheticEscrow: true,
    syntheticEscrowInputs: escrowInputsFromPatch(task.patch ?? '', row.FAIL_TO_PASS),
    syntheticEscrowParams: DEFAULT_SYNTHETIC_ESCROW_PARAMS,
  });
  if (weighted <= baseRate) fail('expected complexity-weighted escrow > base rate');

  const summary = {
    admitted: result.admitted,
    publishedCid,
    instance_id: task.instance_id,
    hf_dataset: task.hf_dataset,
    fail_to_pass: row.FAIL_TO_PASS.length,
    weightedEscrowWei: weighted.toString(),
    elapsedSec: elapsed,
  };
  const outPath = join(stateDir, 'harvest-e2e-live-result.json');
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log('[harvest-e2e-live] PASS', JSON.stringify(summary, null, 2));
  console.log(`[harvest-e2e-live] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[harvest-e2e-live] error:', err);
  process.exit(1);
});
