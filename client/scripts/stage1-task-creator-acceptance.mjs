#!/usr/bin/env node
/**
 * Stage 1 daemon-side acceptance over the contribution candidate written by
 * the stock Python host. External evaluation/publication services are local
 * fakes; the task-creator miner, stores, privacy projection and jinn-layer
 * history binary are the real build.
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
const layerBin = resolve(requiredEnv('JINN_LAYER_BIN'));
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
const mineableStore = new MineableTraceStore({ stateDir: contributionStateDir });
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

function candidate(sourceId, overrides = {}) {
  return {
    sourceId,
    kind: 'harness-session',
    repo: REPO,
    baseCommit: 'a'.repeat(40),
    acceptedDiff: `SECRET_ACCEPTED_DIFF_${sourceId}`,
    testRuns: [],
    intermediateFailureDiffs: [`SECRET_FAILURE_${sourceId}`],
    skillEvents: [{ skill: `SECRET_SKILL_${sourceId}`, action: 'loaded' }],
    publishMinedTasksConsent: true,
    createdAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

try {
  await stat(layerBin);
  let records = await mineableStore.list();
  assert.equal(records.length, 2, 'daemon did not read the two Python-written candidates');
  const shareOff = records.find((row) => row.recordId === result.shareOffRecordId);
  const shareOn = records.find((row) => row.recordId === result.shareOnRecordId);
  assert.ok(shareOff && shareOn);
  assert.equal(shareOff.publicationState, 'disabled');
  assert.equal(shareOn.publicationState, 'queued');
  assert.equal(shareOff.candidate.sourceId, result.shareOffRecordId);
  assert.equal(shareOn.candidate.sourceId, result.shareOnRecordId);
  // The Python driver declares which of its sessions carried each candidate
  // (shareOn/shareOffSessionId) — look the sessions up by that declared id,
  // then verify the store linkage independently via episodeId. Selecting by
  // episodeId instead would make the linkage assertion tautological.
  const shareOffSession = result.sessions.find(
    (row) => row.sessionId === result.shareOffSessionId,
  );
  const shareOnSession = result.sessions.find(
    (row) => row.sessionId === result.shareOnSessionId,
  );
  assert.ok(shareOffSession && shareOnSession);
  assert.equal(shareOff.candidate.sourceId, shareOffSession.episodeId);
  assert.equal(shareOn.candidate.sourceId, shareOnSession.episodeId);

  // With no publication sidecar, both records still mint locally and nothing
  // leaves the machine. The share-enabled record remains durably queued.
  const localTick = await mineSessionEchoes(deps(successfulRunner(), { publish: false }));
  assert.equal(localTick.admitted.length, 2);
  assert.equal(uploads.length, 0);
  assert.deepEqual(await mineableStore.get(result.shareOffRecordId).then((row) => ({
    localState: row?.localState,
    publicationState: row?.publicationState,
  })), { localState: 'minted', publicationState: 'disabled' });
  assert.deepEqual(await mineableStore.get(result.shareOnRecordId).then((row) => ({
    localState: row?.localState,
    publicationState: row?.publicationState,
  })), { localState: 'minted', publicationState: 'queued' });

  const queuedHistory = await layerJson('history', '--json');
  assert.equal(queuedHistory.contractVersion, 1);
  assert.equal(queuedHistory.status, 'degraded');
  assert.match(queuedHistory.reason ?? '', /predate activity or eligibility/);
  const queuedHistoryText = JSON.stringify(queuedHistory);
  assert.match(queuedHistoryText, /queued/);
  const queuedEntry = queuedHistory.value.entries.find(
    (entry) => entry.sessionId === shareOnSession.sessionId,
  );
  assert.ok(queuedEntry);
  assert.equal(queuedEntry.capturedAt, shareOnSession.capturedAt);
  assert.equal(queuedEntry.contributionState.status, 'queued');

  // Once the acknowledged candidate has a publication worker, D5 is checked
  // immediately before the one outbound public-task artifact.
  const publicChecks = [];
  const publishTick = await mineSessionEchoes(deps(successfulRunner(), {
    publish: true,
    isPublic: async (repo) => {
      publicChecks.push(repo);
      return true;
    },
  }));
  assert.ok(publishTick.admitted.length >= 1);
  assert.deepEqual(publicChecks, [REPO]);
  assert.equal(uploads.length, 1);
  const published = await mineableStore.get(result.shareOnRecordId);
  assert.equal(published?.localState, 'minted');
  assert.equal(published?.publicationState, 'published');
  assert.equal(published?.publicationRef, 'ipfs://bafyStage1Published');

  const outbound = uploads[0].body.toString('utf8');
  for (const record of records) {
    assert.ok(!outbound.includes(record.candidate.sourceId));
    assert.ok(!outbound.includes(record.candidate.acceptedDiff));
    for (const failure of record.candidate.intermediateFailureDiffs) {
      assert.ok(!outbound.includes(failure));
    }
    for (const skill of record.candidate.skillEvents) {
      assert.ok(!outbound.includes(skill.skillRef));
    }
  }
  assert.ok(!outbound.includes('LEGACY_RAW_TRACE_SENTINEL'));

  const publishedHistory = await layerJson('history', '--json');
  const publishedHistoryText = JSON.stringify(publishedHistory);
  assert.match(publishedHistoryText, /published/);
  const publishedEntry = publishedHistory.value.entries.find(
    (entry) => entry.sessionId === shareOnSession.sessionId,
  );
  assert.equal(publishedEntry?.capturedAt, shareOnSession.capturedAt);
  assert.equal(publishedEntry?.contributionState.status, 'published');
  assert.equal(publishedEntry?.contributionState.anchorRef, 'ipfs://bafyStage1Published');
  assert.ok(!publishedHistoryText.includes('SECRET_ACCEPTED_DIFF'));
  await assert.rejects(
    () => mineableStore.veto(result.shareOnRecordId),
    /published and immutable/,
  );

  await mineableStore.append(candidate('stage1-veto-candidate'));
  assert.equal((await mineableStore.get('stage1-veto-candidate'))?.publicationState, 'queued');
  await mineableStore.veto('stage1-veto-candidate');
  const uploadsBeforeVetoTick = uploads.length;
  const vetoTick = await mineSessionEchoes(deps(successfulRunner(), { publish: true }));
  assert.equal(vetoTick.discovered, 1);
  assert.equal(vetoTick.admitted.length, 1, 'veto must not suppress useful local minting');
  assert.equal(uploads.length, uploadsBeforeVetoTick);
  assert.deepEqual(await mineableStore.get('stage1-veto-candidate').then((row) => ({
    localState: row?.localState,
    publicationState: row?.publicationState,
  })), { localState: 'minted', publicationState: 'vetoed' });

  await mineableStore.append(candidate('stage1-private-candidate'));
  const privateChecks = [];
  const privateTick = await mineSessionEchoes(deps(successfulRunner(), {
    publish: true,
    isPublic: async (repo) => {
      privateChecks.push(repo);
      return false;
    },
  }));
  assert.deepEqual(privateChecks, [REPO]);
  assert.match(privateTick.rejected[0]?.reason ?? '', /not public/);
  assert.equal(uploads.length, uploadsBeforeVetoTick);
  assert.deepEqual(await mineableStore.get('stage1-private-candidate').then((row) => ({
    localState: row?.localState,
    publicationState: row?.publicationState,
  })), { localState: 'minted', publicationState: 'queued' });

  await mineableStore.append(candidate('stage1-sidecar-absent'));
  await mineSessionEchoes(deps(successfulRunner(), { publish: false }));
  assert.deepEqual(await mineableStore.get('stage1-sidecar-absent').then((row) => ({
    localState: row?.localState,
    publicationState: row?.publicationState,
  })), { localState: 'minted', publicationState: 'queued' });
  assert.equal(uploads.length, uploadsBeforeVetoTick);

  const contributionLedger = await layerJson('contribution', 'ledger', '--json');
  const contributionLedgerText = JSON.stringify(contributionLedger);
  assert.match(contributionLedgerText, /vetoed/);
  assert.match(contributionLedgerText, /queued/);

  const disabled = await layerJson('contribution', 'disable', '--json');
  assert.equal(disabled.contractVersion, 1);
  assert.equal(disabled.status, 'ok');
  assert.equal((await mineableStore.get('stage1-private-candidate'))?.publicationState, 'disabled');
  assert.equal((await mineableStore.get('stage1-sidecar-absent'))?.publicationState, 'disabled');
  assert.equal((await mineableStore.get('stage1-veto-candidate'))?.publicationState, 'vetoed');

  const legacy = await readFile(result.legacyPending, 'utf8');
  assert.equal(legacy, '{"raw":"LEGACY_RAW_TRACE_SENTINEL"}\n');
  console.log('TASK CREATOR ACCEPTANCE PASS');
} finally {
  await new Promise((resolveClose, rejectClose) => publicationServer.close((error) => {
    if (error) rejectClose(error);
    else resolveClose();
  }));
}
