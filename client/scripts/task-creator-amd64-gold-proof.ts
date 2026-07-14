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
 * Hermetic by default (#1683): the known instance's pool task + HF row load
 * from the committed fixture (test/release/tier-2/fixtures/known-instance-hf.json)
 * — zero HF network calls, so a HF datasets-server outage cannot red-gate the
 * proof. The gate proves grading semantics, not HF uptime.
 *
 *   AC1_LIVE_HF=1                            live HF fetch (pre-#1683 behaviour)
 *   yarn task-creator:amd64-gold-proof --record-fixture
 *                                            fetch live from HF and (re)write the
 *                                            committed fixture (no Docker needed)
 *
 * Spec: spec/2026-07-08-task-creator-v0.md §13 AC #1
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  KNOWN_COMMIT,
  KNOWN_INSTANCE_ID,
  KNOWN_REPO,
} from '../test/release/tier-2/fixtures/known-instance.js';
import {
  KNOWN_INSTANCE_HF_FIXTURE_PATH,
  KNOWN_INSTANCE_HF_FIXTURE_SCHEMA,
  loadKnownInstanceHfFixture,
} from '../test/release/tier-2/fixtures/known-instance-hf-fixture.js';
import type { HfFetcher, HfRow } from '../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
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

const LIVE_HF = process.env['AC1_LIVE_HF'] === '1';
const RECORD_FIXTURE = process.argv.includes('--record-fixture');

function fail(msg: string): never {
  console.error(`[ac1-gold-proof] FAIL: ${msg}`);
  process.exit(1);
}

/** Live HF fetch of the known instance: pool row + full datasets-server row. */
async function fetchKnownInstanceLive(): Promise<{ poolTask: PoolTask; hfRow: HfRow }> {
  const pool = await loadSweRebenchV2Pool();
  const poolTask = pool.find((t) => t.instance_id === KNOWN_INSTANCE_ID);
  if (!poolTask) fail(`instance ${KNOWN_INSTANCE_ID} not in HF pool`);
  const hf = new HttpHfFetcher();
  const hfRow = await hf.fetchTaskRow({
    hf_dataset: poolTask.hf_dataset,
    hf_split: poolTask.hf_split,
    instance_id: poolTask.instance_id,
  });
  return { poolTask, hfRow };
}

/** `--record-fixture`: fetch live from HF and (re)write the committed fixture. */
async function recordFixture(): Promise<void> {
  console.log('[ac1-gold-proof] --record-fixture: fetching known-instance row live from HF…');
  const { poolTask, hfRow } = await fetchKnownInstanceLive();
  const fixture = {
    schemaVersion: KNOWN_INSTANCE_HF_FIXTURE_SCHEMA,
    recordedAt: new Date().toISOString(),
    source: 'live HF datasets-server (yarn task-creator:amd64-gold-proof --record-fixture)',
    poolTask,
    hfRow,
  };
  writeFileSync(KNOWN_INSTANCE_HF_FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  // Round-trip through the validator so a bad recording fails loud NOW,
  // not on the next CI run.
  loadKnownInstanceHfFixture();
  console.log(`[ac1-gold-proof] fixture recorded: ${KNOWN_INSTANCE_HF_FIXTURE_PATH}`);
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
  if (RECORD_FIXTURE) {
    // Recording only needs HF network — no amd64/Docker requirement.
    await recordFixture();
    return;
  }

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

  let source: PoolTask;
  let hfRow: HfRow;
  let hf: HfFetcher;
  if (LIVE_HF) {
    console.log('[ac1-gold-proof] AC1_LIVE_HF=1 — fetching known-instance row live from HF');
    ({ poolTask: source, hfRow } = await fetchKnownInstanceLive());
    hf = new HttpHfFetcher();
  } else {
    // Hermetic default: load from the committed fixture; fails loud if the
    // fixture is missing/malformed — never silently falls back to live HF.
    const fixture = loadKnownInstanceHfFixture();
    console.log(
      `[ac1-gold-proof] HF row from committed fixture (recorded ${fixture.recordedAt}); ` +
      'set AC1_LIVE_HF=1 for a live fetch',
    );
    source = fixture.poolTask;
    hfRow = fixture.hfRow;
    // Every row lookup below must resolve through the minted artifact; if the
    // routing ever regresses to a real HF fetch, fail loud instead of
    // touching the network.
    hf = {
      fetchTaskRow: async (args) => {
        throw new Error(
          'hermetic AC1 run attempted an HF fetch ' +
          `(${args.hf_dataset}/${args.hf_split}/${args.instance_id}) — ` +
          'the minted-artifact routing must serve every lookup; use AC1_LIVE_HF=1 for an explicit live run',
        );
      },
    };
  }

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
