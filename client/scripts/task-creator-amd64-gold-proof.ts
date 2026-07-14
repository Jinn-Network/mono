#!/usr/bin/env tsx
/**
 * AC #1 — amd64 gold-grade proof for Task Creator v0.
 *
 * Proves one minted instance grades as resolving through the production
 * evaluator path (RoutingHfFetcher + rowHash + image digest pin + Docker
 * gold eval + discrimination check) on native linux/amd64.
 *
 * Usage: yarn task-creator:amd64-gold-proof
 * CI:    .github/workflows/ci.yml → task-creator-amd64-gold-proof job
 *
 * Spec: spec/2026-07-08-task-creator-v0.md §13 AC #1
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  KNOWN_COMMIT,
  KNOWN_INSTANCE_ID,
  KNOWN_REPO,
} from '../test/release/tier-2/fixtures/known-instance.js';
import {
  SweRebenchV2EvaluatorHarness,
  defaultSweRebenchV2EvaluatorImplStateDir,
  readEnabledState,
} from '../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { HttpHfFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { RoutingTaskRowFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js';
import {
  EVAL_SEMANTICS_VERSION,
  ValidatedPoolStore,
  validatePoolInstances,
} from '../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { computeRowHash } from '../src/solver-types/_swe-rebench-v2-substrate.js';
import { loadSweRebenchV2Pool } from '../src/solver-types/swe-rebench-v2.js';
import {
  mintedIpfsDatasetCid,
  type SweRebenchV2MintedPoolArtifact,
} from '../src/solver-types/_swe-rebench-v2-minted-pool.js';
import type { PoolTask } from '../src/solver-types/_swe-rebench-v2-pool.js';

const MINTED_CID = 'bafybeigdyrztac5ieplqnxnvx5c3jy24k3qioqngxd2k4z7q5b6p5d5z5y';
const MINTED_DATASET = mintedIpfsDatasetCid(MINTED_CID);

function fail(msg: string): never {
  console.error(`[ac1-gold-proof] FAIL: ${msg}`);
  process.exit(1);
}

function requireAmd64(): void {
  if (platform() !== 'linux' || arch() !== 'x64') {
    fail(
      `requires native linux/amd64 (got ${platform()}/${arch()}). ` +
      'SWE-rebench images are amd64-only; arm64/QEMU emulation is not admissible for AC #1.',
    );
  }
}

function requireDocker(): void {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (r.status !== 0) fail('Docker daemon not reachable');
}

async function ensureEvaluatorEnabled(): Promise<void> {
  const implStateDir = defaultSweRebenchV2EvaluatorImplStateDir();
  const existing = readEnabledState(implStateDir);
  if (existing?.upstreamRepoDir) return;

  const harness = new SweRebenchV2EvaluatorHarness({ implStateDir });
  const result = await harness.onEnable({ implStateDir, configPath: '' });
  if (result.status !== 'ready') {
    fail(`evaluator enable failed: ${result.status} — ${'message' in result ? result.message : JSON.stringify(result)}`);
  }
  if (!readEnabledState(implStateDir)?.upstreamRepoDir) {
    fail('evaluator state missing after enable');
  }
}

async function main(): Promise<void> {
  requireAmd64();
  requireDocker();

  const implStateDir = defaultSweRebenchV2EvaluatorImplStateDir();
  const enabled = readEnabledState(implStateDir);
  if (!enabled) {
    await ensureEvaluatorEnabled();
  }
  const upstreamRepoDir = readEnabledState(implStateDir)!.upstreamRepoDir;

  console.log(`[ac1-gold-proof] instance=${KNOWN_INSTANCE_ID} semantics=v${EVAL_SEMANTICS_VERSION}`);
  console.log(`[ac1-gold-proof] upstream=${upstreamRepoDir}`);

  const pool = await loadSweRebenchV2Pool();
  const source = pool.find((t) => t.instance_id === KNOWN_INSTANCE_ID);
  if (!source) fail(`instance ${KNOWN_INSTANCE_ID} not in HF pool`);

  const hf = new HttpHfFetcher();
  const hfRow = await hf.fetchTaskRow({
    hf_dataset: source.hf_dataset,
    hf_split: source.hf_split,
    instance_id: source.instance_id,
  });

  const artifact: SweRebenchV2MintedPoolArtifact = {
    schemaVersion: 'swe-rebench-v2-minted-pool.v1',
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    generatedAt: new Date().toISOString(),
    rows: [{
      instance_id: hfRow.instance_id,
      repo: hfRow.repo ?? KNOWN_REPO,
      image_name: hfRow.image_name,
      FAIL_TO_PASS: hfRow.FAIL_TO_PASS,
      PASS_TO_PASS: hfRow.PASS_TO_PASS,
      test_patch: hfRow.test_patch,
      install_config: hfRow.install_config,
      problem_statement: source.problem_statement,
      base_commit: source.base_commit ?? KNOWN_COMMIT,
    }],
  };

  const routingFetcher = new RoutingTaskRowFetcher({
    hf,
    fetchMintedArtifact: async () => artifact,
  });

  const mintedTask: PoolTask = {
    ...source,
    hf_dataset: MINTED_DATASET,
    hf_split: 'minted',
    repo: hfRow.repo ?? KNOWN_REPO,
    base_commit: source.base_commit ?? KNOWN_COMMIT,
    patch: source.patch,
  };

  const routedRow = await routingFetcher.fetchTaskRow({
    hf_dataset: mintedTask.hf_dataset,
    hf_split: mintedTask.hf_split,
    instance_id: mintedTask.instance_id,
  });
  if (routedRow.image_name !== hfRow.image_name) {
    fail(`RoutingTaskRowFetcher image_name drift: ${routedRow.image_name} !== ${hfRow.image_name}`);
  }

  const rowHashInput = {
    hf_dataset: mintedTask.hf_dataset,
    hf_split: mintedTask.hf_split,
    instance_id: mintedTask.instance_id,
    repo: mintedTask.repo ?? routedRow.repo,
    base_commit: mintedTask.base_commit ?? KNOWN_COMMIT,
    image_name: routedRow.image_name,
    patch: mintedTask.patch,
    test_patch: routedRow.test_patch,
    install_config: routedRow.install_config,
    FAIL_TO_PASS: routedRow.FAIL_TO_PASS,
    PASS_TO_PASS: routedRow.PASS_TO_PASS,
  };
  const rowHash = computeRowHash(rowHashInput);
  console.log(`[ac1-gold-proof] rowHash=${rowHash}`);

  const stateDir = mkdtempSync(join(tmpdir(), 'ac1-gold-proof-'));
  try {
    const store = new ValidatedPoolStore({ stateDir: join(stateDir, 'validated') });
    const runner = new PythonEvalRunner({ upstreamRepoDir });

    console.log('[ac1-gold-proof] running minted admission (gold + discrimination)…');
    const summary = await validatePoolInstances(
      [mintedTask],
      {
        fetcher: routingFetcher,
        runner,
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir,
        log: (m) => console.log(m),
      },
      { poolSource: 'minted', force: true },
    );

    const entry = await store.getEntry(KNOWN_INSTANCE_ID, EVAL_SEMANTICS_VERSION);
    if (!entry?.scorable) {
      fail(`admission not scorable: ${entry?.reason ?? 'no entry'}`);
    }
    if (entry.discrimination !== 'pass') {
      fail(`discrimination not pass: ${entry.discrimination ?? 'missing'}`);
    }
    if (entry.rowHash !== rowHash) {
      fail(`rowHash pin drift: stored ${entry.rowHash} !== computed ${rowHash}`);
    }
    if (!entry.imageDigest) {
      fail('imageDigest not pinned on admission entry');
    }

    console.log('[ac1-gold-proof] PASS');
    console.log(JSON.stringify({
      instanceId: KNOWN_INSTANCE_ID,
      scorable: entry.scorable,
      discrimination: entry.discrimination,
      rowHash: entry.rowHash,
      imageDigest: entry.imageDigest,
      checked: summary.checked,
    }, null, 2));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[ac1-gold-proof] ERROR:', err);
  process.exit(1);
});
