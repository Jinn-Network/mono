import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, unlinkSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSweRebenchV2GeneratorForLaunchedRecord } from '../../src/solver-types/swe-rebench-v2.js';
import {
  loadActiveHeldOutSlateIds,
  ACTIVE_HELD_OUT_SLATE_VERSIONS,
} from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import {
  ValidatedPoolStore,
  EVAL_SEMANTICS_VERSION,
  createVettedPoolArtifactRef,
  hashVettedPoolArtifact,
  writeVettedPoolArtifactPublication,
  type SweRebenchV2VettedPoolArtifact,
} from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { GeneratorStateStore } from '../../src/solver-types/_swe-rebench-v2-state.js';
import type { AdmissionMode } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import type { Task } from '../../src/types/task.js';

const DEFAULT_MOCK_ROWS = [
  {
    row: {
      instance_id: 'org__repo-1',
      repo: 'org/repo',
      base_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      language: 'python',
      problem_statement: 'fix first bug',
    },
  },
  {
    row: {
      instance_id: 'org__repo-2',
      repo: 'org/repo',
      base_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      language: 'python',
      problem_statement: 'fix second bug',
    },
  },
];

const FIXED_NOW_ISO = '2026-05-08T10:12:45.000Z';

function launchedRecord(overrides: Partial<LaunchedSolverNetRecord> = {}): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: '5474_swe-rebench-v2-v1_edb172d3',
    manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
    manifestHash: `0x${'aa'.repeat(32)}` as `0x${string}`,
    launcherAgentId: '5474',
    launcherSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
    launchedAt: FIXED_NOW_ISO,
    status: 'launched',
    statusUpdatedAt: FIXED_NOW_ISO,
    generatorEnabled: true,
    registry: {
      metadataTxHash: `0x${'bb'.repeat(32)}` as `0x${string}`,
      metadataBlockNumber: 1,
    },
    ...overrides,
  };
}

function poolTask(id: string, overrides: Partial<PoolTask> = {}): PoolTask {
  return {
    instance_id: id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2026_02',
    repo: 'org/repo',
    base_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    language: 'python',
    problem_statement: `fix bug in ${id}`,
    ...overrides,
  };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'jinn-swe-gen-cooldown-'));
}

interface MakeTestGeneratorOpts {
  stateDir: string;
  admissionMode?: AdmissionMode;
  poolTasks?: PoolTask[];
  N_target_successes?: number;
  posting_window_ms?: number;
  post_batch_size?: number;
}

function makeTestGenerator(opts: MakeTestGeneratorOpts) {
  const {
    stateDir,
    admissionMode,
    N_target_successes = 1,
    posting_window_ms = 24 * 60 * 60 * 1000,
    post_batch_size = 25,
  } = opts;
  const recordRef = { current: launchedRecord() };
  const configRef = {
    current: {
      N_target_successes,
      posting_window_ms,
      post_batch_size,
      ...(admissionMode !== undefined ? { admissionMode } : {}),
    },
  };
  return makeSweRebenchV2GeneratorForLaunchedRecord({
    recordRef,
    configRef,
    staticConfig: { stateDir },
  });
}

function expectTaskArray(value: Task | Task[] | null): Task[] {
  expect(Array.isArray(value)).toBe(true);
  return value as Task[];
}

describe('makeSweRebenchV2GeneratorForLaunchedRecord posting windows', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'jinn-swe-gen-cooldown-'));
    // Only fake Date so the cooldown logic sees a fixed timestamp, but leave
    // setTimeout real — fetchHfWithRetry's shared HF limiter sleeps via
    // setTimeout to honour the process-wide min-interval (issue #578). If we
    // faked setTimeout the second `/rows` request would never wake up because
    // these tests do not advance timers manually.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      // fetchHfSplit now routes through fetchHfWithRetry (issue #578), so
      // both /splits and /rows are mocked via this single fetch spy.
      if (url.includes('/splits')) {
        return { ok: true, json: async () => ({ splits: [{ split: '2026_02' }] }) } as Response;
      }
      return { ok: true, json: async () => ({ rows: DEFAULT_MOCK_ROWS }) } as Response;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('posts across the pool round-robin without a time window', async () => {
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    const recordRef = { current: launchedRecord() };
    const configRef = {
      current: {
        N_target_successes: 1,
        posting_window_ms: 86_400_000,
        post_batch_size: 1,
        admissionMode: 'python-floor',
      },
    };
    const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { stateDir },
    });

    const first = await gen();
    const second = await gen();

    expect(expectTaskArray(first)[0].spec).toMatchObject({ instance_id: 'org__repo-1' });
    expect(expectTaskArray(second)[0].spec).toMatchObject({ instance_id: 'org__repo-2' });
    expect(gen.getState()).toMatchObject({
      totalPosted: 2,
      lastPollSummary: { posted: 1 },
    });
    expect(gen.getState().lastPollSummary).not.toHaveProperty('abandoned');
  });

  it('sizes maxClaims to remaining target successes', async () => {
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    const stateStore = new GeneratorStateStore({ stateDir });
    await stateStore.recordSuccess('org__repo-1');
    await stateStore.recordSuccess('org__repo-1');
    const gen = makeTestGenerator({
      stateDir,
      admissionMode: 'python-floor',
      N_target_successes: 3,
      post_batch_size: 2,
    });

    const tasks = expectTaskArray(await gen());
    const partiallySolved = tasks.find((task) => task.spec?.instance_id === 'org__repo-1');

    expect(partiallySolved).toMatchObject({
      solverType: 'swe-rebench-v2.v1',
      claimPolicy: {
        maxClaims: 1,
        maxClaimsPerOperator: 1,
      },
    });
  });

  it('applies maxClaimsPerOperator and claimLeaseTtlSeconds overrides to newly posted tasks', async () => {
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    const recordRef = { current: launchedRecord() };
    const configRef = {
      current: {
        N_target_successes: 3,
        posting_window_ms: 86_400_000,
        post_batch_size: 1,
        admissionMode: 'python-floor',
        maxClaimsPerOperator: 2,
        claimLeaseTtlSeconds: 1_800,
      },
    };
    const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { stateDir },
    });

    const task = expectTaskArray(await gen())[0];

    expect(task).toMatchObject({
      solverType: 'swe-rebench-v2.v1',
      claimPolicy: {
        mode: 'parallel',
        maxClaims: 3,
        maxClaimsPerOperator: 2,
        claimLeaseTtlSeconds: 1_800,
      },
    });
  });
});

describe('swe-rebench-v2 generator — admissionMode: required', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tmpDir();
    // See above: only fake Date, leave setTimeout real so the shared HF
    // limiter's min-interval sleep can finish without manual timer ticks.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-14T10:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' || url.includes('/api/v0/add')) {
        return {
          status: 200,
          text: async () => `${JSON.stringify({ Hash: 'bafy-vetted-pool-cid' })}\n`,
        } as Response;
      }
      if (url.includes('/splits')) {
        return { ok: true, json: async () => ({ splits: [{ split: '2026_02' }] }) } as Response;
      }
      return { ok: true, json: async () => ({ rows: DEFAULT_MOCK_ROWS }) } as Response;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('posts nothing when validated-pool.json is absent in required mode', async () => {
    const gen = makeTestGenerator({ stateDir, admissionMode: 'required' });
    const task = await gen();
    expect(task).toBeNull();
  });

  it('posts nothing when validated-pool.json has no scorable entries in required mode', async () => {
    const store = new ValidatedPoolStore({ stateDir });
    await store.record('a__1', { scorable: false, reason: 'unscorable', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    const gen = makeTestGenerator({ stateDir, admissionMode: 'required' });
    const task = await gen();
    expect(task).toBeNull();
  });

  it('posts only admitted scorable instances in required mode', async () => {
    const store = new ValidatedPoolStore({ stateDir });
    await store.record('org__repo-1', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    const gen = makeTestGenerator({ stateDir, admissionMode: 'required' });
    const task = await gen();
    expect(expectTaskArray(task)[0].spec).toMatchObject({ instance_id: 'org__repo-1' });
  });

  it('publishes the local scorable pool before posting and stamps the artifact ref', async () => {
    const store = new ValidatedPoolStore({ stateDir });
    await store.record(
      'org__repo-1',
      {
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-05-14T00:00:00Z',
        rowHash: 'sha256:' + '1'.repeat(64),
        imageDigest: 'sha256:' + 'a'.repeat(64),
      },
      EVAL_SEMANTICS_VERSION,
    );
    const gen = makeTestGenerator({ stateDir, admissionMode: 'required' });

    const task = expectTaskArray(await gen())[0];

    expect(task.spec).toMatchObject({ instance_id: 'org__repo-1' });
    expect(task.eligibility?.['vettedPoolRef']).toMatchObject({
      schemaVersion: 'solvernet.artifact-ref.v1',
      manifestCid: launchedRecord().manifestCid,
      artifactType: 'swe-rebench-v2-vetted-pool.v1',
      artifactCid: 'bafy-vetted-pool-cid',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    });
    expect(task.context?.['vettedPoolRef']).toBeUndefined();
  });

  it('uses the published artifact pool, not unpublished local scorable entries', async () => {
    const store = new ValidatedPoolStore({ stateDir });
    await store.record(
      'org__repo-1',
      { scorable: true, reason: 'locally validated only', checkedAt: '2026-05-14T00:00:00Z' },
      EVAL_SEMANTICS_VERSION,
    );
    const artifact: SweRebenchV2VettedPoolArtifact = {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-05-22T00:00:00.000Z',
      entries: [
        {
          instance_id: 'org__repo-2',
          scorable: true,
          reason: 'gold-patch-resolves',
          checkedAt: '2026-05-14T00:00:01Z',
        },
      ],
    };
    const ref = createVettedPoolArtifactRef({
      manifestCid: launchedRecord().manifestCid,
      artifactCid: 'bafy-existing-vetted-pool',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-05-22T00:00:00.000Z',
    });
    await writeVettedPoolArtifactPublication({ stateDir, ref, artifact });

    const gen = makeTestGenerator({ stateDir, admissionMode: 'required' });
    const task = expectTaskArray(await gen())[0];

    expect(task.spec).toMatchObject({ instance_id: 'org__repo-2' });
    expect(task.eligibility?.['vettedPoolRef']).toEqual(ref);
  });

  it('caches the write-once vetted-pool publication after first resolution', async () => {
    const artifact: SweRebenchV2VettedPoolArtifact = {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-05-22T00:00:00.000Z',
      entries: [
        {
          instance_id: 'org__repo-1',
          scorable: true,
          reason: 'gold-patch-resolves',
          checkedAt: '2026-05-14T00:00:00Z',
        },
        {
          instance_id: 'org__repo-2',
          scorable: true,
          reason: 'gold-patch-resolves',
          checkedAt: '2026-05-14T00:00:01Z',
        },
      ],
    };
    const ref = createVettedPoolArtifactRef({
      manifestCid: launchedRecord().manifestCid,
      artifactCid: 'bafy-existing-vetted-pool',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-05-22T00:00:00.000Z',
    });
    await writeVettedPoolArtifactPublication({ stateDir, ref, artifact });

    const gen = makeTestGenerator({
      stateDir,
      admissionMode: 'required',
      post_batch_size: 1,
    });

    const first = expectTaskArray(await gen())[0];
    unlinkSync(join(stateDir, 'vetted-pool-artifact-publication.json'));
    const second = expectTaskArray(await gen())[0];

    expect(first.spec).toMatchObject({ instance_id: 'org__repo-1' });
    expect(second.spec).toMatchObject({ instance_id: 'org__repo-2' });
    expect(second.eligibility?.['vettedPoolRef']).toEqual(ref);
  });

  it('falls back to python-floor when admissionMode is python-floor and no validation data exists', async () => {
    const gen = makeTestGenerator({
      stateDir,
      admissionMode: 'python-floor',
    });
    const task = await gen();
    expect(expectTaskArray(task)[0].spec).toMatchObject({ instance_id: 'org__repo-1' });
  });
});

describe('swe-rebench-v2 generator — vetted-pool re-publication on validated-pool growth', () => {
  let stateDir: string;
  let ipfsUploadCount: number;

  beforeEach(() => {
    stateDir = tmpDir();
    ipfsUploadCount = 0;
    // `shouldAdvanceTime` lets real time bleed into the fake clock so the
    // shared HF request limiter's `minRequestIntervalMs` sleep (500ms by
    // default — see hf-fetcher.ts) actually fires between /splits and /rows
    // calls. Without this, the second fetchHfWithRetry in loadSweRebenchV2Pool
    // hangs at the limiter and the test times out at 30s. Issue #578 added
    // this min-interval after the rows-fetcher rewrite (which `next` now
    // ships and PR #570 rebases onto), so the older `vi.useFakeTimers()`
    // pattern from the previous describe blocks doesn't carry forward here.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-22T00:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' || url.includes('/api/v0/add')) {
        ipfsUploadCount += 1;
        return {
          status: 200,
          text: async () => `${JSON.stringify({ Hash: `bafy-vetted-pool-cid-${ipfsUploadCount}` })}\n`,
        } as Response;
      }
      // /rows API → return mock rows so buildHistoricalPool gets a non-empty
      // pool. /splits API → return one split. Default → splits payload.
      if (url.includes('/rows')) {
        return { ok: true, json: async () => ({ rows: DEFAULT_MOCK_ROWS }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ splits: [{ split: '2026_02' }] }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function seedStalePublication(): Promise<void> {
    const stalePublishedAt = '2026-05-20T00:00:00.000Z';
    const artifact: SweRebenchV2VettedPoolArtifact = {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: stalePublishedAt,
      entries: [
        {
          instance_id: 'org__repo-1',
          scorable: true,
          reason: 'gold-patch-resolves',
          checkedAt: stalePublishedAt,
        },
      ],
    };
    const ref = createVettedPoolArtifactRef({
      manifestCid: launchedRecord().manifestCid,
      artifactCid: 'bafy-stale-vetted-pool',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: stalePublishedAt,
    });
    await writeVettedPoolArtifactPublication({
      stateDir,
      ref,
      artifact,
      updatedAt: stalePublishedAt,
    });
  }

  /** Seeds the validated pool and returns the store's own `updatedAt`. */
  async function seedValidatedPoolWithTwoEntries(): Promise<string> {
    const store = new ValidatedPoolStore({ stateDir });
    await store.record(
      'org__repo-1',
      { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-22T00:00:00.000Z' },
      EVAL_SEMANTICS_VERSION,
    );
    await store.record(
      'org__repo-2',
      { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-22T00:00:00.000Z' },
      EVAL_SEMANTICS_VERSION,
    );
    const scorable = await store.getScorableEntries(EVAL_SEMANTICS_VERSION);
    expect(scorable).not.toBeNull();
    return scorable!.updatedAt;
  }

  function bumpValidatedPoolMtime(): void {
    // Force the file's mtime past the publication's updatedAt so the per-tick
    // staleness gate fires deterministically — Node may otherwise report sub-ms
    // mtime granularity under fakeTimers.
    const future = new Date('2026-05-22T01:00:00.000Z');
    utimesSync(join(stateDir, 'validated-pool.json'), future, future);
  }

  it('re-publishes when validated-pool.json mtime advances past the stale publication', async () => {
    await seedStalePublication();
    await seedValidatedPoolWithTwoEntries();
    bumpValidatedPoolMtime();

    const gen = makeTestGenerator({
      stateDir,
      admissionMode: 'required',
      post_batch_size: 1,
    });

    await gen();
    await gen();

    expect(ipfsUploadCount).toBe(1);
    expect(gen.getState()).toMatchObject({
      poolPublicationPriorSize: 1,
      poolPublicationCurrentSize: 2,
    });
    expect(gen.getState().poolPublicationUpdatedAt).toBeTypeOf('string');
  });

  it('does not re-publish when the validated pool is no newer than the existing publication', async () => {
    const artifact: SweRebenchV2VettedPoolArtifact = {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-05-22T00:00:00.000Z',
      entries: [
        {
          instance_id: 'org__repo-1',
          scorable: true,
          reason: 'gold-patch-resolves',
          checkedAt: '2026-05-22T00:00:00.000Z',
        },
        {
          instance_id: 'org__repo-2',
          scorable: true,
          reason: 'gold-patch-resolves',
          checkedAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    };
    const ref = createVettedPoolArtifactRef({
      manifestCid: launchedRecord().manifestCid,
      artifactCid: 'bafy-current-vetted-pool',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-05-22T00:00:00.000Z',
    });
    // Pin the publication's `updatedAt` to the pool store's own value.
    // `resolvePublishedVettedPool` re-publishes when the store's `updatedAt`
    // is strictly newer than the publication's, and this block runs with
    // `shouldAdvanceTime: true` — so letting both default to `new Date()`
    // makes the outcome depend on how much real time bled into the fake clock
    // between the two writes, which is host-speed dependent (#3048).
    const poolUpdatedAt = await seedValidatedPoolWithTwoEntries();
    await writeVettedPoolArtifactPublication({
      stateDir,
      ref,
      artifact,
      updatedAt: poolUpdatedAt,
    });

    const gen = makeTestGenerator({
      stateDir,
      admissionMode: 'required',
      post_batch_size: 1,
    });

    await gen();
    await gen();

    expect(ipfsUploadCount).toBe(0);
    expect(gen.getState().poolPublicationCurrentSize).toBeUndefined();
    expect(gen.getState().poolPublicationPriorSize).toBeUndefined();
  });

  it('re-publishes a CLEAN artifact when the existing publication is contaminated with a held-out instance (#986 substrate exclusion + wiring)', async () => {
    // A real active held-out id (self-adjusting to the committed slate). The
    // generator passes SOLVER_TYPE='swe-rebench-v2.v1' to the slate loader; mirror it.
    const victim = [...loadActiveHeldOutSlateIds('swe-rebench-v2.v1', ACTIVE_HELD_OUT_SLATE_VERSIONS)][0];
    expect(victim).toBeTypeOf('string');

    // Existing publication is CONTAMINATED (lists org__repo-1 + the held-out victim).
    // Its updatedAt is AFTER the validated pool's, so `validatedNewer` is false —
    // the ONLY thing that can trigger a republish here is the contamination guard.
    const contaminated: SweRebenchV2VettedPoolArtifact = {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-05-22T02:00:00.000Z',
      entries: [
        { instance_id: 'org__repo-1', scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-22T00:00:00.000Z' },
        { instance_id: victim, scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-22T00:00:00.000Z' },
      ],
    };
    const ref = createVettedPoolArtifactRef({
      manifestCid: launchedRecord().manifestCid,
      artifactCid: 'bafy-contaminated-vetted-pool',
      artifactHash: hashVettedPoolArtifact(contaminated),
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-05-22T02:00:00.000Z',
    });
    await writeVettedPoolArtifactPublication({ stateDir, ref, artifact: contaminated, updatedAt: '2026-05-22T02:00:00.000Z' });

    const store = new ValidatedPoolStore({ stateDir });
    await store.record('org__repo-1', { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-22T00:00:00.000Z' }, EVAL_SEMANTICS_VERSION);
    await store.record(victim, { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-22T00:00:00.000Z' }, EVAL_SEMANTICS_VERSION);

    const gen = makeTestGenerator({ stateDir, admissionMode: 'required', post_batch_size: 1 });
    await gen();

    // Contamination forced a republish (not the timestamp gate).
    expect(ipfsUploadCount).toBe(1);
    // The republished artifact drops the held-out victim but keeps the rest.
    const published = JSON.parse(readFileSync(join(stateDir, 'vetted-pool-artifact-publication.json'), 'utf8'));
    const ids = published.artifact.entries.map((e: { instance_id: string }) => e.instance_id);
    expect(ids).toContain('org__repo-1');
    expect(ids).not.toContain(victim);
    // Scoring is unaffected: the held-out instance is still validated-scorable locally.
    expect(await store.getScorableIds(EVAL_SEMANTICS_VERSION)).toContain(victim);
  });
});
