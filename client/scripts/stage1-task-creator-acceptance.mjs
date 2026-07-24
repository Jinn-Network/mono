#!/usr/bin/env node
/**
 * Daemon-side acceptance over the contribution candidates written by the
 * stock Python host. In the Stage 2 parked era the production daemon does not
 * mine session echoes; this harness exercises the dormant resolver-backed
 * miner explicitly while proving that the reference queue remains payload-free
 * and every host-created candidate is publication-disabled.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { mineSessionEchoes } from '../dist/solver-types/_swe-rebench-v2-session-echo.js';
import { MineableTraceStore } from '../dist/solver-types/_swe-rebench-v2-mineable-store.js';
import {
  EVAL_SEMANTICS_VERSION,
  ValidatedPoolStore,
} from '../dist/solver-types/_swe-rebench-v2-validated-pool.js';
import { MintedPoolStore } from '../dist/solver-types/_swe-rebench-v2-minted-pool.js';

const execFileAsync = promisify(execFile);
const work = resolve(requiredEnv('JINN_STAGE1_WORK'));
const contributionStateDir = resolve(requiredEnv('JINN_MINEABLE_STATE_DIR'));
const episodesDir = resolve(requiredEnv('JINN_LAYER_EPISODES_DIR'));
const layerBin = resolve(requiredEnv('JINN_STAGE1_LAYER_BIN'));
const result = JSON.parse(await readFile(join(work, 'stock-product-result.json'), 'utf8'));

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

const REPO = 'acme/widget';
const SOURCE_INSTANCE = 'acme__widget-1';
const SOURCE_TASK = {
  instance_id: SOURCE_INSTANCE,
  hf_dataset: 'nebius/SWE-rebench-leaderboard',
  hf_split: '2024_06',
  repo: REPO,
  base_commit: 'sourcebase123',
  patch: 'source-gold-patch',
  test_patch: 'diff --git a/tests/test_widget.py',
  language: 'python',
};
const SOURCE_HF_ROW = {
  instance_id: SOURCE_INSTANCE,
  repo: REPO,
  image_name: 'acme/widget:img',
  FAIL_TO_PASS: ['tests/test_widget.py::test_fix'],
  PASS_TO_PASS: ['tests/test_widget.py::test_other'],
  test_patch: 'diff --git a/tests/test_widget.py',
  install_config: {
    test_cmd: 'pytest tests/test_widget.py',
    log_parser: 'parse_log_pytest',
    install: ['pip install -e .'],
  },
};

function successfulRunner() {
  let call = 0;
  return {
    async runEval() {
      const phase = call++ % 4;
      if (phase === 0 || phase === 3) {
        return {
          passed: ['tests/test_widget.py::test_other'],
          failed: ['tests/test_widget.py::test_fix'],
          passed_match: false,
        };
      }
      return {
        passed: ['tests/test_widget.py::test_fix', 'tests/test_widget.py::test_other'],
        failed: [],
        passed_match: true,
        ...(phase === 2 ? { imageDigest: `sha256:${'d'.repeat(64)}` } : {}),
      };
    },
  };
}

const uploads = [];
const publicationServer = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    if (request.method === 'POST' && request.url?.startsWith('/api/v0/add')) {
      uploads.push({ url: request.url, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"Hash":"bafyStage1Published"}\n');
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
});
await new Promise((resolveListen) => publicationServer.listen(0, '127.0.0.1', resolveListen));
const address = publicationServer.address();
assert.ok(address && typeof address === 'object');
const publicationUrl = `http://127.0.0.1:${address.port}`;

const daemonStateDir = join(work, 'task-creator-state');
const validatedStore = new ValidatedPoolStore({ stateDir: daemonStateDir });
const mintedStore = new MintedPoolStore({ stateDir: daemonStateDir });
const mineableStore = new MineableTraceStore({ stateDir: contributionStateDir, episodesDir });
await validatedStore.record(SOURCE_INSTANCE, {
  scorable: true,
  reason: 'gold-patch-resolves',
  checkedAt: '2026-07-15T00:00:00.000Z',
  rowHash: 'sha256:stage1',
  imageName: SOURCE_HF_ROW.image_name,
  imageDigest: `sha256:${'e'.repeat(64)}`,
}, EVAL_SEMANTICS_VERSION);

const hfFetcher = {
  async fetchTaskRow(args) {
    assert.equal(args.instance_id, SOURCE_INSTANCE);
    return SOURCE_HF_ROW;
  },
};

function deps(runner, { publish, isPublic = async () => true }) {
  return {
    stateDir: daemonStateDir,
    ipfsRegistryUrl: publicationUrl,
    ipfsGatewayUrl: publicationUrl,
    validatedStore,
    mintedStore,
    hfFetcher,
    runner,
    upstreamRepoDir: daemonStateDir,
    publicRepoChecker: { isPublic },
    minterSafe: '0x00000000000000000000000000000000000000aa',
    operatorSafe: '0x00000000000000000000000000000000000000bb',
    publish,
    mineableStore,
    pool: [SOURCE_TASK],
  };
}

async function layerJson(...args) {
  const { stdout } = await execFileAsync(layerBin, args, {
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

try {
  await stat(layerBin);
  const records = await mineableStore.list();
  assert.equal(records.length, 2, 'daemon did not read the two Python-written candidates');
  const rawQueue = JSON.parse(await readFile(join(contributionStateDir, 'mineable-traces.json'), 'utf8'));
  assert.equal(rawQueue.schemaVersion, 'jinn.contribution-store.v3');
  for (const record of Object.values(rawQueue.records)) {
    assert.ok(!('candidate' in record));
    assert.ok(!('localMetadata' in record));
  }
  const target = records.find((row) => row.recordId === result.targetRecordId);
  const noResult = records.find((row) => row.recordId === result.noResultRecordId);
  assert.ok(target && noResult);
  for (const record of records) {
    assert.equal(record.candidate.publishMinedTasksConsent, false);
    assert.equal(record.publicationState, 'disabled');
    assert.equal(record.candidate.sourceId, record.recordId);
  }
  // The Python driver declares which of its sessions carried each candidate
  // — look the sessions up by that declared id,
  // then verify the store linkage independently via episodeId. Selecting by
  // episodeId instead would make the linkage assertion tautological.
  const targetSession = result.sessions.find(
    (row) => row.sessionId === result.targetSessionId,
  );
  const noResultSession = result.sessions.find(
    (row) => row.sessionId === result.noResultSessionId,
  );
  assert.ok(targetSession && noResultSession);
  assert.equal(target.candidate.sourceId, targetSession.episodeId);
  assert.equal(noResult.candidate.sourceId, noResultSession.episodeId);

  // Exercise the dormant miner directly as a compatibility proof. Production
  // harvest reports sessions-source-parked-stage-2 and never invokes this path.
  const localTick = await mineSessionEchoes(deps(successfulRunner(), { publish: false }));
  assert.equal(localTick.admitted.length, 2);
  assert.equal(uploads.length, 0);
  for (const record of records) {
    assert.deepEqual(await mineableStore.get(record.recordId).then((row) => ({
      localState: row?.localState,
      publicationState: row?.publicationState,
    })), { localState: 'minted', publicationState: 'disabled' });
  }

  const parkedHistory = await layerJson('history', '--json');
  assert.equal(parkedHistory.contractVersion, 1);
  assert.equal(parkedHistory.status, 'degraded');
  assert.match(parkedHistory.reason ?? '', /predate activity or eligibility/);
  const parkedHistoryText = JSON.stringify(parkedHistory);
  assert.doesNotMatch(parkedHistoryText, /preview-required|queued|published/);
  for (const session of [targetSession, noResultSession]) {
    const entry = parkedHistory.value.entries.find(
      (candidateEntry) => candidateEntry.sessionId === session.sessionId,
    );
    assert.ok(entry);
    assert.equal(entry.capturedAt, session.capturedAt);
    assert.equal(entry.contributionState.status, 'minted');
  }
  assert.ok(!parkedHistoryText.includes('SECRET_ACCEPTED_DIFF'));
  assert.ok(!parkedHistoryText.includes('SECRET_PRIVATE_FAILURE_DIFF'));
  assert.ok(!parkedHistoryText.includes('SECRET_LOCAL_SKILL'));
  assert.equal(uploads.length, 0);

  const legacy = await readFile(result.legacyPending, 'utf8');
  assert.equal(legacy, '{"raw":"LEGACY_RAW_TRACE_SENTINEL"}\n');
  console.log('TASK CREATOR ACCEPTANCE PASS');
} finally {
  await new Promise((resolveClose, rejectClose) => publicationServer.close((error) => {
    if (error) rejectClose(error);
    else resolveClose();
  }));
}
