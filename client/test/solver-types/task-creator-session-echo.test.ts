/**
 * Session-echo miner tests (Task 8) — one test per rule from the task brief:
 *   1. Blinded provenance: instance_id/row/provenance never carry `sourceId`.
 *   2. Provenance blocks both minter and source-solver claims.
 *   3. Publication gate: consented first share requires preview acknowledgement.
 *   4. Repo gates in order: denylist before Docker spend; D5 only on publish path.
 *   5. Dead mints (no FAIL_TO_PASS) are rejected.
 *   6. Mined-or-rejected records are always `markMined`.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mineSessionEchoes, type SessionEchoMintDeps } from '../../src/solver-types/_swe-rebench-v2-session-echo.js';
import {
  enforceStage2ParkedPublication,
  MineableTraceStore,
  type MineableTraceRecord,
} from '../../src/solver-types/_swe-rebench-v2-mineable-store.js';
import { ValidatedPoolStore, EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { MintedPoolStore, loadMintedPoolTasks } from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { MINTED_DATASET_PLACEHOLDER, sessionEchoInstanceId } from '../../src/solver-types/_swe-rebench-v2-harvest.js';
import { loadMintRepoDenylist } from '../../src/solver-types/_swe-rebench-v2-guards.js';
import { syntheticClaimBlocked } from '../../src/solver-types/_swe-rebench-v2-synthetic-claim.js';
import { uploadToIpfs } from '../../src/adapters/mech/ipfs.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import type { EvalRunner, HfFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { createEvidenceAdapter } from '@jinn-network/core';
import type { ContributionCandidateV1, EpisodeV1 } from '@jinn-network/plugin';

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafysessionecho'),
  fetchFromIpfs: vi.fn(),
}));

const REPO = 'acme/widget';
const SOURCE_INSTANCE = 'acme__widget-1';
const MINTER_SAFE = '0x00000000000000000000000000000000000000aa';
const OPERATOR_SAFE = '0x00000000000000000000000000000000000000bb';

const SOURCE_TASK: PoolTask = {
  instance_id: SOURCE_INSTANCE,
  hf_dataset: 'nebius/SWE-rebench-leaderboard',
  hf_split: '2024_06',
  repo: REPO,
  base_commit: 'sourcebase123',
  patch: 'source-gold-patch',
  test_patch: 'diff --git a/tests/test_x.py',
  language: 'python',
};

const SOURCE_HF_ROW = {
  instance_id: SOURCE_INSTANCE,
  repo: REPO,
  image_name: 'acme/widget:img',
  FAIL_TO_PASS: ['tests/test_x.py::test_fix'],
  PASS_TO_PASS: ['tests/test_x.py::test_other'],
  test_patch: 'diff --git a/tests/test_x.py',
  install_config: {
    test_cmd: 'pytest tests/test_x.py',
    log_parser: 'parse_log_pytest',
    install: ['pip install -e .'],
  },
};

function makeRecord(overrides: Partial<MineableTraceRecord> = {}): MineableTraceRecord {
  return {
    sourceId: 'session-secret-do-not-leak-abc123',
    kind: 'harness-session',
    repo: REPO,
    baseCommit: 'basecommit456',
    acceptedDiff: 'diff --git a/src/x.py b/src/x.py\n+fix\n',
    testRuns: [],
    intermediateFailureDiffs: [],
    skillEvents: [],
    publishMinedTasksConsent: true,
    createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
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
    origin: { writer: 'session-echo-test', build: '1' },
    task: {
      summary: 'dormant session echo compatibility test',
      distributionTags: ['coding'],
      repositorySlug: value.repo,
      baseCommit: value.baseCommit,
      ...(value.sourceInstanceId ? { instanceId: value.sourceInstanceId } : {}),
    },
    trajectory: [{
      spanId: 'span', parentSpanId: null, kind: 'jinn.agent_turn', name: 'turn:user',
      startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: {}, redactedKeys: [],
    }],
    environment: {
      harness: { name: 'session-echo-test', version: '1' },
      model: 'test',
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

const hfFetcher: HfFetcher = {
  fetchTaskRow: vi.fn().mockImplementation(async (args: { instance_id: string }) => {
    if (args.instance_id === SOURCE_INSTANCE) return SOURCE_HF_ROW;
    throw new Error(`unexpected hfFetcher.fetchTaskRow(${args.instance_id})`);
  }),
};

/** Standard 4-call sequence: empirical before/after (not dead), gold
 *  admission (with imageDigest so the real `docker image inspect` path is
 *  never hit), discrimination known-bad (must legitimately fail to admit). */
function makeSuccessfulRunner(): EvalRunner {
  return {
    runEval: vi.fn()
      .mockResolvedValueOnce({ passed: ['tests/test_x.py::test_other'], failed: ['tests/test_x.py::test_fix'], passed_match: false })
      .mockResolvedValueOnce({ passed: ['tests/test_x.py::test_fix', 'tests/test_x.py::test_other'], failed: [], passed_match: true })
      .mockResolvedValueOnce({ passed: ['tests/test_x.py::test_fix', 'tests/test_x.py::test_other'], failed: [], passed_match: true, imageDigest: `sha256:${'d'.repeat(64)}` })
      .mockResolvedValueOnce({ passed: [], failed: ['tests/test_x.py::test_fix'], passed_match: false }),
  };
}

/** Diff flips no test: before/after report identical pass sets → dead mint. */
function makeDeadRunner(): EvalRunner {
  return {
    runEval: vi.fn()
      .mockResolvedValueOnce({ passed: ['tests/test_x.py::test_other'], failed: ['tests/test_x.py::test_fix'], passed_match: false })
      .mockResolvedValueOnce({ passed: ['tests/test_x.py::test_other'], failed: ['tests/test_x.py::test_fix'], passed_match: false }),
  };
}

interface SessionTestEnv {
  stateDir: string;
  episodesDir: string;
  validatedStore: ValidatedPoolStore;
  mintedStore: MintedPoolStore;
  mineableStore: MineableTraceStore;
}

async function setup(): Promise<SessionTestEnv> {
  const stateDir = await mkdtemp(join(tmpdir(), 'session-echo-'));
  const episodesDir = join(stateDir, 'episodes');
  const validatedStore = new ValidatedPoolStore({ stateDir });
  const mintedStore = new MintedPoolStore({ stateDir });
  const mineableStore = new MineableTraceStore({ stateDir, episodesDir });
  await validatedStore.record(SOURCE_INSTANCE, {
    scorable: true,
    reason: 'gold-patch-resolves',
    checkedAt: new Date().toISOString(),
    rowHash: 'sha256:seed',
    imageName: SOURCE_HF_ROW.image_name,
    imageDigest: `sha256:${'e'.repeat(64)}`,
  }, EVAL_SEMANTICS_VERSION);
  return { stateDir, episodesDir, validatedStore, mintedStore, mineableStore };
}

async function appendRecord(env: SessionTestEnv, record: MineableTraceRecord): Promise<void> {
  const result = await createEvidenceAdapter({ capturesDir: env.episodesDir }).put(
    episodeForRecord(record),
  );
  expect(result.status).toBe('ok');
  await env.mineableStore.append(record);
}

function baseDeps(env: Awaited<ReturnType<typeof setup>>, runner: EvalRunner, opts: {
  publish?: boolean;
  publicRepoChecker?: { isPublic: (repo: string) => Promise<boolean> };
} = {}): SessionEchoMintDeps {
  return {
    stateDir: env.stateDir,
    ipfsRegistryUrl: 'https://registry.example',
    ipfsGatewayUrl: 'https://gateway.example',
    validatedStore: env.validatedStore,
    mintedStore: env.mintedStore,
    hfFetcher,
    runner,
    upstreamRepoDir: env.stateDir, // not a git repo — resolveUpstreamEvalCommit fails soft to null
    publicRepoChecker: opts.publicRepoChecker ?? { isPublic: async () => true },
    minterSafe: MINTER_SAFE,
    publish: opts.publish ?? true,
    mineableStore: env.mineableStore,
    operatorSafe: OPERATOR_SAFE,
    pool: [SOURCE_TASK],
  };
}

async function cleanup(env: { stateDir: string }): Promise<void> {
  await rm(env.stateDir, { recursive: true, force: true });
}

describe('mineSessionEchoes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rule 1: blinded provenance — instance_id/row/provenance never carry the raw sourceId', async () => {
    const env = await setup();
    try {
      const record = makeRecord();
      await appendRecord(env, record);

      const result = await mineSessionEchoes(baseDeps(env, makeSuccessfulRunner()));
      expect(result.admitted).toHaveLength(1);
      const mintedId = result.admitted[0]!;

      expect(mintedId).not.toContain(record.sourceId);
      expect(mintedId).toMatch(/^acme__widget__session-[0-9a-f]{12}$/);

      const entry = await env.mintedStore.getEntry(mintedId, EVAL_SEMANTICS_VERSION);
      expect(entry).not.toBeNull();
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(record.sourceId);
      expect(entry!.provenance.sourceLineageHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await cleanup(env);
    }
  });

  it('rule 2: provenance blocks both the minter and the source-solver from claiming the echo', async () => {
    const env = await setup();
    try {
      const record = makeRecord();
      await appendRecord(env, record);

      const result = await mineSessionEchoes(baseDeps(env, makeSuccessfulRunner()));
      const mintedId = result.admitted[0]!;
      const entry = await env.mintedStore.getEntry(mintedId, EVAL_SEMANTICS_VERSION);

      expect(entry!.provenance.synthetic).toBe(true);
      expect(entry!.provenance.minterSafe).toBe(MINTER_SAFE);
      expect((entry!.provenance as { sourceSolverSafe?: string }).sourceSolverSafe).toBe(OPERATOR_SAFE);
      expect(syntheticClaimBlocked(entry!.provenance, MINTER_SAFE)).toContain('minter');
      expect(syntheticClaimBlocked(entry!.provenance, OPERATOR_SAFE)).toContain('source solver');
    } finally {
      await cleanup(env);
    }
  });

  it('rule 3: share gate — no share consent mints locally but is never published, and D5 is never consulted for it', async () => {
    const env = await setup();
    try {
      const record = makeRecord({ publishMinedTasksConsent: false });
      await appendRecord(env, record);

      const isPublic = vi.fn().mockResolvedValue(true);
      const result = await mineSessionEchoes(baseDeps(env, makeSuccessfulRunner(), { publish: true, publicRepoChecker: { isPublic } }));

      // Local mining still happens.
      expect(result.admitted).toHaveLength(1);
      const mintedId = result.admitted[0]!;

      // D5 (assertPublicRepoForPublish) belongs to the publish path only —
      // never consulted for a share-off record.
      expect(isPublic).not.toHaveBeenCalled();
      expect(uploadToIpfs).not.toHaveBeenCalled();

      // No published-artifact reference: hf_dataset stays the local
      // placeholder, and this fresh store has never published anything.
      const entry = await env.mintedStore.getEntry(mintedId, EVAL_SEMANTICS_VERSION);
      expect(entry!.hf_dataset).toBe(MINTED_DATASET_PLACEHOLDER);
      expect(await env.mintedStore.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION)).toBeNull();
      const poolTasks = await loadMintedPoolTasks(env.mintedStore, EVAL_SEMANTICS_VERSION);
      expect(poolTasks.map((t) => t.instance_id)).not.toContain(mintedId);
      expect(await env.mineableStore.get(record.sourceId)).toMatchObject({
        localState: 'minted',
        publicationState: 'disabled',
      });
    } finally {
      await cleanup(env);
    }
  });

  it('stage 2 quarantines an already-queued Stage 1 record but still mints it locally', async () => {
    const env = await setup();
    try {
      const retained = makeRecord({
        sourceId: 'retained-stage1-share',
        publishMinedTasksConsent: true,
      });
      await appendRecord(env, retained);
      await env.mineableStore.authorize(retained.sourceId, '2026-07-15T12:01:00.000Z');
      expect(await env.mineableStore.get(retained.sourceId)).toMatchObject({
        localState: 'recorded',
        publicationState: 'queued',
      });

      const publishConsent = await enforceStage2ParkedPublication(env.mineableStore);
      const isPublic = vi.fn().mockResolvedValue(true);
      const result = await mineSessionEchoes(baseDeps(
        env,
        makeSuccessfulRunner(),
        // A stale caller-side publish toggle is deliberately true: durable
        // quarantine state remains the final outbound authority.
        { publish: true, publicRepoChecker: { isPublic } },
      ));

      expect(publishConsent).toBe(false);
      expect(result.admitted).toHaveLength(1);
      expect(isPublic).not.toHaveBeenCalled();
      expect(uploadToIpfs).not.toHaveBeenCalled();
      expect(await env.mineableStore.get(retained.sourceId)).toMatchObject({
        localState: 'minted',
        publicationState: 'disabled',
      });
    } finally {
      await cleanup(env);
    }
  });

  it('rule 3b: first share mints locally, waits for preview acknowledgement, then publishes on a later tick', async () => {
    const env = await setup();
    try {
      const record = makeRecord({ publishMinedTasksConsent: true });
      await appendRecord(env, record);
      const isPublic = vi.fn().mockResolvedValue(true);
      const deps = baseDeps(env, makeSuccessfulRunner(), { publish: true, publicRepoChecker: { isPublic } });

      const first = await mineSessionEchoes(deps);

      expect(first.admitted).toHaveLength(1);
      expect(isPublic).not.toHaveBeenCalled();
      expect(uploadToIpfs).not.toHaveBeenCalled();
      expect(await env.mineableStore.get(record.sourceId)).toMatchObject({
        localState: 'minted',
        publicationState: 'preview-required',
      });

      await env.mineableStore.authorize(record.sourceId, '2026-07-15T12:01:00.000Z');
      const second = await mineSessionEchoes({ ...deps, runner: makeSuccessfulRunner() });

      expect(second.admitted).toEqual(first.admitted);
      expect(isPublic).toHaveBeenCalledWith(REPO);
      expect(uploadToIpfs).toHaveBeenCalledTimes(1);
      expect(await env.mineableStore.get(record.sourceId)).toMatchObject({
        localState: 'minted',
        publicationState: 'published',
        publicationRef: 'ipfs://bafysessionecho',
      });
    } finally {
      await cleanup(env);
    }
  });

  it('publishes only the public task artifact, never the local source id or accepted diff/gold', async () => {
    const env = await setup();
    try {
      const record = makeRecord({
        sourceId: 'SECRET_LOCAL_EPISODE_ID',
        acceptedDiff: 'SECRET_ACCEPTED_DIFF_GOLD',
        intermediateFailureDiffs: ['SECRET_PRIVATE_FAILURE_DIFF'],
        skillEvents: [{ skill: 'SECRET_LOCAL_SKILL', action: 'loaded' }],
        publishMinedTasksConsent: true,
      });
      await appendRecord(env, record);
      await env.mineableStore.authorize(record.sourceId, '2026-07-15T12:01:00.000Z');

      await mineSessionEchoes(baseDeps(env, makeSuccessfulRunner(), { publish: true }));

      const outbound = JSON.stringify(vi.mocked(uploadToIpfs).mock.calls);
      expect(outbound).not.toContain('SECRET_LOCAL_EPISODE_ID');
      expect(outbound).not.toContain('SECRET_ACCEPTED_DIFF_GOLD');
      expect(outbound).not.toContain('SECRET_PRIVATE_FAILURE_DIFF');
      expect(outbound).not.toContain('SECRET_LOCAL_SKILL');
    } finally {
      await cleanup(env);
    }
  });

  it('rule 4a: the denylist gate fires before any Docker spend (runner never called)', async () => {
    const env = await setup();
    try {
      const denylist = loadMintRepoDenylist();
      expect(denylist.repos.size).toBeGreaterThan(0);
      const deniedRepo = [...denylist.repos][0]!;

      const record = makeRecord({ repo: deniedRepo });
      await appendRecord(env, record);

      const runner = makeSuccessfulRunner();
      const result = await mineSessionEchoes(baseDeps(env, runner));

      expect(result.admitted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.reason).toMatch(/held-out/);
      expect(runner.runEval).not.toHaveBeenCalled();
    } finally {
      await cleanup(env);
    }
  });

  it('rule 4b: a private repo still mints locally but the final publication gate refuses outbound I/O', async () => {
    const env = await setup();
    try {
      const record = makeRecord({ publishMinedTasksConsent: true });
      await appendRecord(env, record);
      await env.mineableStore.authorize(record.sourceId, '2026-07-15T12:01:00.000Z');

      const isPublic = vi.fn().mockResolvedValue(false);
      const result = await mineSessionEchoes(baseDeps(env, makeSuccessfulRunner(), { publish: true, publicRepoChecker: { isPublic } }));

      expect(isPublic).toHaveBeenCalledWith(REPO);
      expect(uploadToIpfs).not.toHaveBeenCalled();
      expect(result.admitted).toEqual([sessionEchoInstanceId(REPO, record.sourceId)]);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.reason).toMatch(/not public/);
      expect(await env.mineableStore.get(record.sourceId)).toMatchObject({
        localState: 'minted',
        publicationState: 'queued',
      });
    } finally {
      await cleanup(env);
    }
  });

  it('rule 4c: rechecks the public repository immediately before the outbound upload', async () => {
    const env = await setup();
    try {
      const record = makeRecord({ publishMinedTasksConsent: true });
      await appendRecord(env, record);
      await env.mineableStore.authorize(record.sourceId, '2026-07-15T12:01:00.000Z');
      const events: string[] = [];
      const runner = makeSuccessfulRunner();
      const runEval = runner.runEval;
      runner.runEval = vi.fn(async (args) => {
        events.push('eval');
        return runEval(args);
      });
      const isPublic = vi.fn(async () => {
        events.push('public-check');
        return true;
      });
      vi.mocked(uploadToIpfs).mockImplementationOnce(async () => {
        events.push('upload');
        return 'bafysessionecho';
      });

      await mineSessionEchoes(baseDeps(env, runner, { publish: true, publicRepoChecker: { isPublic } }));

      expect(events.slice(-2)).toEqual(['public-check', 'upload']);
    } finally {
      await cleanup(env);
    }
  });

  it('rechecks durable authorization after evaluation so a concurrent veto causes zero outbound I/O', async () => {
    const env = await setup();
    try {
      const record = makeRecord({ publishMinedTasksConsent: true });
      await appendRecord(env, record);
      await env.mineableStore.authorize(record.sourceId, '2026-07-15T12:01:00.000Z');
      const runner = makeSuccessfulRunner();
      const runEval = runner.runEval;
      let vetoed = false;
      runner.runEval = vi.fn(async (args) => {
        const result = await runEval(args);
        if (!vetoed) {
          vetoed = true;
          await env.mineableStore.veto(record.sourceId);
        }
        return result;
      });

      await mineSessionEchoes(baseDeps(env, runner, { publish: true }));

      expect(uploadToIpfs).not.toHaveBeenCalled();
      expect(await env.mineableStore.get(record.sourceId)).toMatchObject({
        localState: 'minted',
        publicationState: 'vetoed',
      });
    } finally {
      await cleanup(env);
    }
  });

  it('recovers a crash after minted-pool publication without rebuilding or uploading again', async () => {
    const env = await setup();
    try {
      const record = makeRecord({ publishMinedTasksConsent: true });
      await appendRecord(env, record);
      await env.mineableStore.authorize(record.sourceId, '2026-07-15T12:01:00.000Z');
      const mintedId = sessionEchoInstanceId(REPO, record.sourceId);
      await env.mintedStore.record(mintedId, {
        row: {
          ...SOURCE_HF_ROW,
          instance_id: mintedId,
          base_commit: record.baseCommit,
        },
        provenance: { synthetic: true, mintFamily: 'session-echo', sourceLineageHash: 'existing' },
        admission: { scorable: true, reason: 'gold-patch-resolves', checkedAt: record.createdAt },
        hf_dataset: 'ipfs://bafyexisting',
        hf_split: 'minted',
        mintedAt: record.createdAt,
        published: true,
        goldPatch: record.acceptedDiff,
      }, EVAL_SEMANTICS_VERSION);
      const runner = makeSuccessfulRunner();

      const result = await mineSessionEchoes(baseDeps(env, runner, { publish: true }));

      expect(result.admitted).toEqual([mintedId]);
      expect(runner.runEval).not.toHaveBeenCalled();
      expect(uploadToIpfs).not.toHaveBeenCalled();
      expect(await env.mineableStore.get(record.sourceId)).toMatchObject({
        localState: 'minted',
        publicationState: 'published',
        mintRef: mintedId,
        publicationRef: 'ipfs://bafyexisting',
      });
    } finally {
      await cleanup(env);
    }
  });

  it('rule 5: a session whose diff flips no test is rejected as a dead mint', async () => {
    const env = await setup();
    try {
      const record = makeRecord();
      await appendRecord(env, record);

      const result = await mineSessionEchoes(baseDeps(env, makeDeadRunner()));

      expect(result.admitted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.reason).toMatch(/empirical-dead/);
    } finally {
      await cleanup(env);
    }
  });

  it('rule 6: mined-or-rejected records are markMined and never reprocessed', async () => {
    const env = await setup();
    try {
      const record = makeRecord();
      await appendRecord(env, record);

      const firstResult = await mineSessionEchoes(baseDeps(env, makeSuccessfulRunner()));
      expect(firstResult.discovered).toBe(1);
      expect(await env.mineableStore.listUnmined()).toEqual([]);

      const secondRunner = makeSuccessfulRunner();
      const secondResult = await mineSessionEchoes(baseDeps(env, secondRunner));
      expect(secondResult.discovered).toBe(0);
      expect(secondResult.admitted).toEqual([]);
      expect(secondResult.rejected).toEqual([]);
      expect(secondRunner.runEval).not.toHaveBeenCalled();
    } finally {
      await cleanup(env);
    }
  });

  it('M1 belt-and-braces: a record sourced from an already-minted synthetic instance is rejected without Docker spend', async () => {
    const env = await setup();
    try {
      // Seed the minted pool with a synthetic entry whose instance_id is
      // the "source" this new record claims to be derived from — i.e. the
      // record's sourceInstanceId points at a task that was itself minted.
      const priorMintedId = 'acme__widget__prior-mint-1';
      await env.mintedStore.record(priorMintedId, {
        row: {
          instance_id: priorMintedId,
          repo: REPO,
          image_name: 'acme/widget:img',
          FAIL_TO_PASS: ['tests/test_x.py::test_fix'],
          PASS_TO_PASS: [],
          test_patch: '',
          install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
        },
        provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'priorhash' },
        admission: { scorable: true, reason: 'ok', checkedAt: new Date().toISOString() },
        hf_dataset: MINTED_DATASET_PLACEHOLDER,
        hf_split: 'minted',
        mintedAt: new Date().toISOString(),
        published: true,
      }, EVAL_SEMANTICS_VERSION);

      const record = makeRecord({ kind: 'solvernet-execution', sourceInstanceId: priorMintedId });
      await appendRecord(env, record);

      const runner = makeSuccessfulRunner();
      const result = await mineSessionEchoes(baseDeps(env, runner));

      expect(result.admitted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.reason).toBe('synthetic-source');
      expect(runner.runEval).not.toHaveBeenCalled();
      expect(await env.mineableStore.listUnmined()).toEqual([]);
    } finally {
      await cleanup(env);
    }
  });

  it('rule 6b: a rejected (dead-mint) record is also markMined and never reprocessed', async () => {
    const env = await setup();
    try {
      const record = makeRecord();
      await appendRecord(env, record);

      await mineSessionEchoes(baseDeps(env, makeDeadRunner()));
      expect(await env.mineableStore.listUnmined()).toEqual([]);

      const secondRunner = makeSuccessfulRunner();
      const secondResult = await mineSessionEchoes(baseDeps(env, secondRunner));
      expect(secondResult.discovered).toBe(0);
      expect(secondRunner.runEval).not.toHaveBeenCalled();
    } finally {
      await cleanup(env);
    }
  });
});

/** Implementation-based runner for multi-record ticks: broken/discrimination
 *  patch ('') fails test_fix, any non-empty patch resolves everything (with
 *  an imageDigest, so admission never shells out to `docker image inspect`). */
function makeSmartRunner(): EvalRunner {
  return {
    runEval: vi.fn().mockImplementation(async (args: { patch: string }) => {
      if (args.patch === '') {
        return { passed: ['tests/test_x.py::test_other'], failed: ['tests/test_x.py::test_fix'], passed_match: false };
      }
      return {
        passed: ['tests/test_x.py::test_fix', 'tests/test_x.py::test_other'],
        failed: [],
        passed_match: true,
        imageDigest: `sha256:${'d'.repeat(64)}`,
      };
    }),
  };
}

// Regression net for the D2 tier-2 fix (per-entry `published` marker in
// `_swe-rebench-v2-minted-pool.ts`): before the fix, `loadMintedPoolTasks`
// gated on the STORE-WIDE `publishedArtifactCid`, so the moment anything in
// the store published, every placeholder-`hf_dataset` entry (the placeholder
// itself starts with `ipfs://`) leaked into the generator's postable union
// (`swe-rebench-v2.ts:671`). Now publish state is tracked per entry.
describe('D2 tier-2 — unpublished mints never enter the postable union (per-entry published marker)', () => {
  it('mixed batch: publishing the consented mint does not make the consented-off mint loadable', async () => {
    const env = await setup();
    try {
      // Two session records, same repo: A consents to tier-2 publish, B does not.
      const recordA = makeRecord({ sourceId: 'session-a-consented', publishMinedTasksConsent: true });
      const recordB = makeRecord({ sourceId: 'session-b-tier1-only', publishMinedTasksConsent: false });
      await appendRecord(env, recordA);
      await appendRecord(env, recordB);
      await env.mineableStore.authorize(recordA.sourceId, '2026-07-15T12:01:00.000Z');

      const result = await mineSessionEchoes(baseDeps(env, makeSmartRunner(), { publish: true }));
      expect(result.admitted).toHaveLength(2);
      expect(result.rejected).toEqual([]);

      const entries = await Promise.all(
        result.admitted.map((id) => env.mintedStore.getEntry(id, EVAL_SEMANTICS_VERSION)),
      );
      const publishedIdx = entries.findIndex((e) => e!.published === true);
      const tier1OnlyIdx = entries.findIndex((e) => e!.published === false);
      expect(publishedIdx).toBeGreaterThanOrEqual(0);
      expect(tier1OnlyIdx).toBeGreaterThanOrEqual(0);
      const publishedId = result.admitted[publishedIdx]!;
      const tier1OnlyId = result.admitted[tier1OnlyIdx]!;

      // A was published: its hf_dataset was backfilled to the artifact ref.
      expect(entries[publishedIdx]!.hf_dataset).toBe('ipfs://bafysessionecho');
      // B's placeholder hf_dataset never resolves off the local placeholder.
      expect(entries[tier1OnlyIdx]!.hf_dataset).toBe(MINTED_DATASET_PLACEHOLDER);

      // Postable union: A in, B out — even though the store-wide
      // publishedArtifactCid is now set.
      expect(await env.mintedStore.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION)).toBe('bafysessionecho');
      const poolTasks = await loadMintedPoolTasks(env.mintedStore, EVAL_SEMANTICS_VERSION);
      const poolIds = poolTasks.map((t) => t.instance_id);
      expect(poolIds).toContain(publishedId);
      expect(poolIds).not.toContain(tier1OnlyId);

      // The published rows artifact excludes B's row too — publishing its row
      // data would itself defeat the tier-2 consent gate.
      const artifact = await env.mintedStore.exportArtifact(EVAL_SEMANTICS_VERSION);
      expect(artifact.rows.map((r) => r.instance_id)).not.toContain(tier1OnlyId);
    } finally {
      await cleanup(env);
    }
  });

  it('legacy entries without the marker keep pre-marker behaviour (store-wide cid fallback)', async () => {
    const env = await setup();
    try {
      const legacyId = 'legacy__repo__echo-nomarker';
      await env.mintedStore.record(legacyId, {
        row: {
          instance_id: legacyId,
          repo: 'legacy/repo',
          image_name: 'legacy/repo:img',
          FAIL_TO_PASS: ['t1'],
          PASS_TO_PASS: [],
          test_patch: '',
          install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
        },
        provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'legacy-hash' },
        admission: { scorable: true, reason: 'ok', checkedAt: new Date().toISOString() },
        hf_dataset: MINTED_DATASET_PLACEHOLDER,
        hf_split: 'minted',
        mintedAt: new Date().toISOString(),
        // no `published` field — legacy entry shape
      }, EVAL_SEMANTICS_VERSION);

      // No store-wide cid yet → legacy entry not loadable (unchanged).
      expect(await loadMintedPoolTasks(env.mintedStore, EVAL_SEMANTICS_VERSION)).toEqual([]);

      // Store-wide cid set (uniform pre-marker batch) → legacy entry loadable (unchanged).
      await env.mintedStore.setPublishedArtifact(EVAL_SEMANTICS_VERSION, 'bafylegacy', [legacyId]);
      const poolTasks = await loadMintedPoolTasks(env.mintedStore, EVAL_SEMANTICS_VERSION);
      expect(poolTasks.map((t) => t.instance_id)).toContain(legacyId);
    } finally {
      await cleanup(env);
    }
  });

  it('bounds session-echo mints per harvest tick via limitPerTick', async () => {
    const env = await setup();
    try {
      for (let i = 0; i < 5; i++) {
        await appendRecord(env, makeRecord({ sourceId: `session-cap-${i}` }));
      }

      const first = await mineSessionEchoes({
        ...baseDeps(env, makeSmartRunner()),
        limitPerTick: 2,
      });

      expect(first.discovered).toBe(2);
      expect(first.admitted).toHaveLength(2);

      const second = await mineSessionEchoes({
        ...baseDeps(env, makeSmartRunner()),
        limitPerTick: 2,
      });

      expect(second.discovered).toBe(2);
      expect(second.admitted).toHaveLength(2);

      const third = await mineSessionEchoes({
        ...baseDeps(env, makeSmartRunner()),
        limitPerTick: 2,
      });

      expect(third.discovered).toBe(1);
      expect(third.admitted).toHaveLength(1);
    } finally {
      await cleanup(env);
    }
  });
});
