#!/usr/bin/env tsx
/**
 * Live session-echo borrowed-image verification — production wiring, real Docker.
 *
 * Seeds one MineableTraceRecord, resolves findSourceInstanceForRepo, runs
 * mineSessionEchoes with PythonEvalRunner + HttpHfFetcher (publish: false),
 * and classifies admit / empirical-dead / other / infra-blocked.
 *
 * Usage:
 *   yarn task-creator:session-echo-live
 *
 * Optional env:
 *   JINN_SESSION_ECHO_LIVE_REPO — default conan-io/conan
 *     (sympy/sympy is held-out on current mint slates — refuses before Docker)
 *   JINN_SESSION_ECHO_LIVE_MODE — borrow-mismatch (default) | borrow-aligned
 *   JINN_SWE_REBENCH_V2_STATE_DIR — operator validated-pool root
 *     (default ~/.jinn-client/swe-rebench-v2)
 */

import { copyFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';
import { createEvidenceAdapter } from '@jinn-network/core';
import type { ContributionCandidateV1, EpisodeV1 } from '@jinn-network/plugin';
import { mineSessionEchoes } from '../src/solver-types/_swe-rebench-v2-session-echo.js';
import {
  MineableTraceStore,
  type MineableTraceRecord,
} from '../src/solver-types/_swe-rebench-v2-mineable-store.js';
import { findSourceInstanceForRepo } from '../src/solver-types/_swe-rebench-v2-harvest.js';
import { getDefaultMintedPoolStore } from '../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { EVAL_SEMANTICS_VERSION } from '../src/solver-types/_swe-rebench-v2-validated-pool.js';
import {
  defaultStateDir,
  getSweRebenchV2ValidatedPoolStore,
  loadSweRebenchV2Pool,
} from '../src/solver-types/swe-rebench-v2.js';
import type { PoolTask } from '../src/solver-types/_swe-rebench-v2-pool.js';
import {
  defaultSweRebenchV2EvaluatorImplStateDir,
  inspectCurrentSweRebenchV2EvaluatorEnableContract,
  type CurrentSweRebenchV2EvaluatorEnableContract,
} from '../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { HttpHfFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { createGitHubPublicRepoChecker } from '../src/solver-types/_swe-rebench-v2-guards.js';
import { loadConfig } from '../src/config.js';
import {
  classifySessionEchoLiveResult,
  dockerPreflightError,
  readSessionEchoLivePriorSummary,
  resolveSessionEchoLiveResultWrite,
  seedIsolatedValidatedPool,
  sessionEchoLiveProcessExitCode,
  type SessionEchoLiveMode,
} from '../src/solver-types/_swe-rebench-v2-session-echo-live-classify.js';

const REPO = process.env.JINN_SESSION_ECHO_LIVE_REPO ?? 'conan-io/conan';
const MODE_RAW = process.env.JINN_SESSION_ECHO_LIVE_MODE ?? 'borrow-mismatch';

function fail(msg: string): never {
  console.error(`[session-echo-live] FAIL: ${msg}`);
  process.exit(1);
}

function requireDocker(): void {
  const error = dockerPreflightError((args, options) =>
    spawnSync('docker', args, options));
  if (error) fail(error);
}

export function requireCurrentEvaluatorEnableContract(
  contract: CurrentSweRebenchV2EvaluatorEnableContract,
): string {
  if (!contract.ok) {
    throw new Error(`${contract.reason}. ${contract.nextStep}`);
  }
  return contract.upstreamRepoDir;
}

function parseMode(raw: string): SessionEchoLiveMode {
  if (raw === 'borrow-mismatch' || raw === 'borrow-aligned') return raw;
  fail(`JINN_SESSION_ECHO_LIVE_MODE must be borrow-mismatch|borrow-aligned (got ${raw})`);
}

function candidateFromRecord(value: MineableTraceRecord): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId: value.sourceId,
    repositorySlug: value.repo,
    baseCommit: value.baseCommit,
    acceptedDiff: value.acceptedDiff,
    testRuns: value.testRuns.map((run) => ({ command: run.cmd, exitCode: run.exitCode, at: run.at })),
    intermediateFailureDiffs: value.intermediateFailureDiffs,
    skillEvents: value.skillEvents.map((event) => ({ skillRef: event.skill, action: event.action })),
    publishMinedTasksConsent: value.publishMinedTasksConsent,
    createdAt: value.createdAt,
  };
}

function episodeForRecord(value: MineableTraceRecord): EpisodeV1 {
  const candidate = candidateFromRecord(value);
  return {
    schemaVersion: 'jinn.episode.v1',
    episodeId: value.sourceId,
    retrievalVisible: false,
    session: { sessionId: value.sourceId, capturedAt: value.createdAt, kind: 'user' },
    origin: { writer: 'session-echo-live-verify', build: '1' },
    task: {
      summary: 'session-echo borrowed-image live verify fixture',
      distributionTags: ['coding'],
      repositorySlug: value.repo,
      baseCommit: value.baseCommit,
    },
    trajectory: [{
      spanId: 'span', parentSpanId: null, kind: 'jinn.agent_turn', name: 'turn:user',
      startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: {}, redactedKeys: [],
    }],
    environment: {
      harness: { name: 'session-echo-live-verify', version: '1' },
      model: 'n/a',
      tools: [],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verificationStrength: 'tests-passed' },
    cost: { durationMs: 1 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
    contributionCandidate: candidate,
  };
}

function pickDonor(pool: PoolTask[], scorableIds: Set<string>, repo: string, sourceId: string): PoolTask {
  const normalized = repo.toLowerCase();
  for (const task of pool) {
    if ((task.repo ?? '').toLowerCase() !== normalized) continue;
    if (!scorableIds.has(task.instance_id)) continue;
    if (task.instance_id === sourceId) continue;
    if (!task.patch || task.patch.trim().length === 0) continue;
    return task;
  }
  fail(`need a second scorable ${repo} instance with a gold patch for borrow-mismatch (only source=${sourceId})`);
}

async function main(): Promise<void> {
  requireDocker();
  const mode = parseMode(MODE_RAW);

  const implStateDir = defaultSweRebenchV2EvaluatorImplStateDir();
  let upstreamRepoDir: string;
  try {
    upstreamRepoDir = requireCurrentEvaluatorEnableContract(
      inspectCurrentSweRebenchV2EvaluatorEnableContract(implStateDir),
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const operatorStateDir = process.env.JINN_SWE_REBENCH_V2_STATE_DIR ?? defaultStateDir();
  const validatedPath = join(operatorStateDir, 'validated-pool.json');
  if (!existsSync(validatedPath)) {
    fail(`missing validated pool at ${validatedPath}`);
  }

  const outPath = join(operatorStateDir, 'session-echo-live-result.json');

  const operatorValidatedStore = getSweRebenchV2ValidatedPoolStore(operatorStateDir);
  const scorableIds = await operatorValidatedStore.getScorableIds(EVAL_SEMANTICS_VERSION);
  if (!scorableIds || scorableIds.size === 0) {
    fail('validated pool has no scorable ids');
  }

  console.log('[session-echo-live] loading SWE-rebench historical pool (HF; may take a minute)…');
  let pool: PoolTask[];
  try {
    pool = await loadSweRebenchV2Pool();
  } catch (err) {
    fail(`loadSweRebenchV2Pool failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const source = findSourceInstanceForRepo(pool, scorableIds, REPO);
  if (!source) {
    fail(`no admitted source instance for repo ${REPO}`);
  }

  const hfFetcher = new HttpHfFetcher();
  const sourceRow = await hfFetcher.fetchTaskRow({
    hf_dataset: source.hf_dataset,
    hf_split: source.hf_split,
    instance_id: source.instance_id,
  });

  let acceptedDiff: string;
  let baseCommit: string;
  let donorInstanceId: string | null = null;
  if (mode === 'borrow-aligned') {
    if (!source.patch || !source.patch.trim()) {
      fail(`borrow-aligned requires source.patch on pool task ${source.instance_id}`);
    }
    acceptedDiff = source.patch;
    baseCommit = source.base_commit ?? 'unknown-base';
  } else {
    const donor = pickDonor(pool, scorableIds, REPO, source.instance_id);
    acceptedDiff = donor.patch!;
    baseCommit = donor.base_commit ?? source.base_commit ?? 'unknown-base';
    donorInstanceId = donor.instance_id;
  }

  const workDir = mkdtempSync(join(tmpdir(), 'session-echo-live-'));
  const episodesDir = join(workDir, 'episodes');
  const validatedStore = getSweRebenchV2ValidatedPoolStore(
    seedIsolatedValidatedPool(validatedPath, workDir, copyFileSync),
  );

  const record: MineableTraceRecord = {
    sourceId: `session-echo-live-${Date.now()}`,
    kind: 'harness-session',
    repo: REPO,
    baseCommit,
    acceptedDiff,
    testRuns: [],
    intermediateFailureDiffs: [],
    skillEvents: [],
    publishMinedTasksConsent: false,
    createdAt: new Date().toISOString(),
  };

  const evidence = createEvidenceAdapter({ capturesDir: episodesDir });
  const put = await evidence.put(episodeForRecord(record));
  if (put.status !== 'ok') fail(`episode put failed: ${JSON.stringify(put)}`);

  const mineableStore = new MineableTraceStore({ stateDir: workDir, episodesDir });
  await mineableStore.append(record);
  const mintedStore = getDefaultMintedPoolStore(workDir);

  const config = loadConfig();
  const runner = new PythonEvalRunner({ upstreamRepoDir });

  console.log('[session-echo-live] fixture', JSON.stringify({
    mode,
    repo: REPO,
    sourceInstanceId: source.instance_id,
    borrowedImage: sourceRow.image_name,
    donorInstanceId,
    workDir,
  }));
  console.log('[session-echo-live] running mineSessionEchoes (real Docker — may take many minutes on arm64)…');

  const started = Date.now();
  let tick;
  let infraError: string | undefined;
  try {
    tick = await mineSessionEchoes({
      stateDir: workDir,
      ipfsRegistryUrl: config.ipfsRegistryUrl,
      ipfsGatewayUrl: config.ipfsGatewayUrl,
      validatedStore,
      mintedStore,
      hfFetcher,
      runner,
      upstreamRepoDir,
      publicRepoChecker: createGitHubPublicRepoChecker({ token: process.env.GITHUB_TOKEN }),
      publish: false,
      mineableStore,
      pool,
    });
  } catch (err) {
    infraError = err instanceof Error ? err.message : String(err);
    tick = { discovered: 0, admitted: [] as string[], rejected: [] as Array<{ instance_id: string; reason: string }>, skipped: [] as string[] };
  }
  const elapsedSec = Number(((Date.now() - started) / 1000).toFixed(1));

  const classified = classifySessionEchoLiveResult({
    mode,
    admitted: tick.admitted,
    rejected: tick.rejected,
    infraError,
  });

  const prior = readSessionEchoLivePriorSummary(outPath);
  const writePlan = resolveSessionEchoLiveResultWrite({
    canonicalPath: outPath,
    classified,
    prior,
  });

  const summary = {
    mode,
    repo: REPO,
    hostArch: process.arch,
    sourceInstanceId: source.instance_id,
    borrowedImage: sourceRow.image_name,
    donorInstanceId,
    discovered: tick.discovered,
    admitted: tick.admitted,
    rejected: tick.rejected,
    skipped: tick.skipped,
    classification: classified.classification,
    hypothesisHolds: classified.hypothesisHolds,
    redFlag: classified.redFlag ?? null,
    infraError: infraError ?? null,
    elapsedSec,
    workDir,
    resultPath: writePlan.resultPath,
    preservedPriorGradedSoR: writePlan.preservedPriorGradedSoR,
  };
  writeFileSync(writePlan.resultPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log('[session-echo-live] RESULT', JSON.stringify(summary, null, 2));
  console.log(`[session-echo-live] wrote ${writePlan.resultPath}`);
  if (writePlan.preservedPriorGradedSoR) {
    console.error(
      `[session-echo-live] preserved prior graded SoR at ${outPath}; infra-blocked attempt written to ${writePlan.resultPath}`,
    );
  }
  if (classified.redFlag) {
    console.error(`[session-echo-live] RED FLAG: ${classified.redFlag}`);
  }

  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);

  const exitCode = sessionEchoLiveProcessExitCode(classified);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('[session-echo-live] error:', err);
    process.exit(1);
  });
}
