/**
 * Launcher mode endpoint tests. Boilerplate matches setup-endpoints.test.ts:
 * each test stands up a fresh Hono app, registers the launcher routes with
 * deterministic deps, and asserts the response shape. The gather function
 * itself is exercised through the route — the route layer is thin enough
 * that one test surface covers both.
 *
 * Spec: spec/2026-05-05-launcher-role-and-mode.md §5.3.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { addLauncherRoutes } from '../../src/api/launcher-endpoints.js';
import { requireUiToken } from '../../src/api/handshake.js';
import type { JinnConfig } from '../../src/config.js';
import type { LauncherGeneratorStateSnapshot } from '../../src/api/launcher-status.js';
import type {
  PostedTaskRecord,
  FetchPostedTasksOptions,
} from '../../src/api/launcher-tasks.js';
import type { TaskStatusSnapshot } from '../../src/archive/types.js';
import { withTempStore } from '@test/store.js';
import { seedNativeRun } from '@test/seed-native-run.js';

const UI_TOKEN = 'ui-token-test';
const SAFE_ADDRESS = '0x0000000000000000000000000000000000000abc';

const PREDICTION_WIRING = {
  workKind: 'prediction.v1',
  harness: 'prediction-v1-baseline',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'prediction-v1-baseline-default',
  isolationPolicy: 'process',
} as const;

const PREDICTION_POSTING = {
  workKind: 'prediction.v1',
  launchedRecordPath: '/tmp/prediction.json',
  generatorEnabled: true,
  legacyManifestDigest: 'legacy:prediction',
};

const SWE_WIRING = {
  workKind: 'swe-rebench-v2.v1',
  harness: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'claude-code-default',
  isolationPolicy: 'process',
} as const;

interface BuildArgs {
  executionWiring?: JinnConfig['executionWiring'];
  posting?: JinnConfig['posting'];
  generatorStates?: Record<string, LauncherGeneratorStateSnapshot | undefined>;
  openTaskCount?: (netName: string) => number;
  reservedBudgetWei?: (netName: string) => string;
  safeBalanceWei?: string;
  now?: number;
  /** Mount the UI-token gate (mirrors server.ts wiring). */
  withAuth?: boolean;
  /**
   * Posted-Task fixtures for the `GET /v1/launcher/tasks` endpoint. Either a
   * static list (the test harness applies the `before`/`limit` filter), or a
   * function that receives the gather options and returns a tailored list.
   */
  postedTasks?:
    | PostedTaskRecord[]
    | ((opts: FetchPostedTasksOptions) => PostedTaskRecord[]);
  fetchTaskStatuses?: (manifestCid: string) => Promise<Map<string, TaskStatusSnapshot>>;
}

/**
 * In-memory persistence shim for the PATCH endpoint. Mirrors the on-disk
 * shape that {@link import('../../src/config.js').persistTopLevelConfigValue}
 * would produce so tests can assert against the full post-write snapshot
 * without touching the filesystem.
 */
function buildPersistShim(): {
  persistConfigValue: (key: string, value: unknown, configPath?: string) => string;
  read: () => Record<string, unknown>;
} {
  const store: Record<string, unknown> = {};
  return {
    persistConfigValue: (key, value) => {
      store[key] = value;
      return '/tmp/test-config.json';
    },
    read: () => ({ ...store }),
  };
}

function defaultFetchPostedTasks(
  fixtures: PostedTaskRecord[] | undefined,
  spy?: { lastOpts?: FetchPostedTasksOptions },
): (opts: FetchPostedTasksOptions) => PostedTaskRecord[] {
  return (opts) => {
    if (spy) spy.lastOpts = opts;
    if (!fixtures) return [];
    const sorted = [...fixtures].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
    const filtered = opts.before
      ? sorted.filter((r) => Date.parse(r.postedAt) < Date.parse(opts.before!))
      : sorted;
    return filtered.slice(0, opts.limit);
  };
}

function buildTestApp(args: BuildArgs): {
  app: Hono;
  token: string;
  fetchSpy: { lastOpts?: FetchPostedTasksOptions };
  /** Returns the in-memory persisted snapshot (mirrors config.json on disk). */
  readPersistedConfig: () => Record<string, unknown>;
  /** Returns the most recent solverNets payload passed to onSolverNetsUpdated. */
  readNotifiedSolverNets: () => Record<string, Record<string, unknown>> | undefined;
} {
  const app = new Hono();
  if (args.withAuth ?? true) {
    app.use('/v1/launcher', requireUiToken(UI_TOKEN));
    app.use('/v1/launcher/*', requireUiToken(UI_TOKEN));
  }
  const fetchSpy: { lastOpts?: FetchPostedTasksOptions } = {};
  const fetchPostedTasks =
    typeof args.postedTasks === 'function'
      ? (opts: FetchPostedTasksOptions) => {
          fetchSpy.lastOpts = opts;
          return (args.postedTasks as (o: FetchPostedTasksOptions) => PostedTaskRecord[])(opts);
        }
      : defaultFetchPostedTasks(args.postedTasks, fetchSpy);
  const persistShim = buildPersistShim();
  let lastNotified: Record<string, Record<string, unknown>> | undefined;
  addLauncherRoutes(app, {
    getConfig: () => ({
      executionWiring: args.executionWiring,
      posting: args.posting,
    }),
    getGeneratorState: (name) => args.generatorStates?.[name],
    getOpenTaskCount: (name) => args.openTaskCount?.(name) ?? 0,
    getReservedBudgetWei: (name) => args.reservedBudgetWei?.(name) ?? '0',
    getSafeBalanceWei: () => args.safeBalanceWei ?? '0',
    safeAddress: SAFE_ADDRESS,
    now: args.now !== undefined ? () => args.now! : undefined,
    tasksDeps: {
      creatorAddress: SAFE_ADDRESS,
      fetchPostedTasks,
      ...(args.fetchTaskStatuses ? { fetchTaskStatuses: args.fetchTaskStatuses } : {}),
      now: args.now !== undefined ? () => args.now! : undefined,
    },
    persistConfigValue: persistShim.persistConfigValue,
    onSolverNetsUpdated: (solverNets) => {
      lastNotified = solverNets;
    },
  });
  return {
    app,
    token: UI_TOKEN,
    fetchSpy,
    readPersistedConfig: persistShim.read,
    readNotifiedSolverNets: () => lastNotified,
  };
}

describe('GET /v1/launcher/status', () => {
  it('returns per-net launcher status for nets with launching role', async () => {
    const { app, token } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      generatorStates: {
        'prediction.v1': {
          lastPollAt: '2026-05-05T10:00:00.000Z',
          lastPollSummary: { evaluated: 12, posted: 3, skipped: 9 },
          cadenceMs: 6 * 60 * 60 * 1000,
        },
      },
      openTaskCount: () => 7,
      reservedBudgetWei: () => '1000000000000000000',
      safeBalanceWei: '5000000000000000000',
      now: Date.parse('2026-05-05T11:00:00.000Z'),
    });

    const res = await app.request('/v1/launcher/status', {
      headers: { 'x-jinn-ui-token': token },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      schemaVersion: number;
      nets: Array<{
        name: string;
        generator: { state: string; cadenceMs: number; stale: boolean; lastPollAt?: string; lastPollSummary?: unknown };
        openTasks: number;
        budget: { safeAddress: string; safeBalanceWei: string; reservedBudgetWei: string };
      }>;
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.nets).toHaveLength(1);
    expect(body.nets[0]).toMatchObject({
      name: 'prediction.v1',
      generator: {
        state: 'active',
        cadenceMs: 6 * 60 * 60 * 1000,
        stale: false,
        lastPollAt: '2026-05-05T10:00:00.000Z',
        lastPollSummary: { evaluated: 12, posted: 3, skipped: 9 },
      },
      openTasks: 7,
      budget: {
        safeAddress: SAFE_ADDRESS,
        safeBalanceWei: '5000000000000000000',
        reservedBudgetWei: '1000000000000000000',
      },
    });
  });

  it('surfaces every loaded SolverNet (no operator-config role filter)', async () => {
    // Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md removed
    // the operator-config `'launching'` role; the launcher status endpoint
    // now surfaces every SolverNet entry regardless of operator role
    // selection. Launched-record ownership is the new launcher-mode signal.
    const { app, token } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
    });
    const res = await app.request('/v1/launcher/status', {
      headers: { 'x-jinn-ui-token': token },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { nets: Array<{ name: string }> };
    expect(body.nets.map((n) => n.name)).toEqual(['prediction.v1']);
  });

  it('reports stale=true when lastPollAt is older than 2x cadence', async () => {
    const cadenceMs = 60_000;
    const now = Date.parse('2026-05-05T12:00:00.000Z');
    const { app, token } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      generatorStates: {
        'prediction.v1': {
          lastPollAt: new Date(now - 3 * cadenceMs).toISOString(),
          cadenceMs,
        },
      },
      now,
    });
    const res = await app.request('/v1/launcher/status', {
      headers: { 'x-jinn-ui-token': token },
    });
    const body = await res.json() as {
      nets: Array<{ generator: { stale: boolean; state: string } }>;
    };
    expect(body.nets[0]?.generator.stale).toBe(true);
    // No lastError → still 'active', stale flag is the operator-visible signal.
    expect(body.nets[0]?.generator.state).toBe('active');
  });

  it('reports state=errored when the generator surfaced lastError', async () => {
    const { app, token } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      generatorStates: {
        'prediction.v1': {
          lastPollAt: '2026-05-05T10:00:00.000Z',
          lastError: { message: 'polymarket 503', at: '2026-05-05T10:00:01.000Z' },
          cadenceMs: 60_000,
        },
      },
      now: Date.parse('2026-05-05T10:00:30.000Z'),
    });
    const res = await app.request('/v1/launcher/status', {
      headers: { 'x-jinn-ui-token': token },
    });
    const body = await res.json() as {
      nets: Array<{ generator: { state: string; lastError?: { message: string } } }>;
    };
    expect(body.nets[0]?.generator.state).toBe('errored');
    expect(body.nets[0]?.generator.lastError?.message).toBe('polymarket 503');
  });

  it('reports state=paused when no generator state has been recorded yet', async () => {
    const { app, token } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      generatorStates: { 'prediction.v1': undefined },
    });
    const res = await app.request('/v1/launcher/status', {
      headers: { 'x-jinn-ui-token': token },
    });
    const body = await res.json() as {
      nets: Array<{ generator: { state: string; cadenceMs?: number; stale: boolean } }>;
    };
    expect(body.nets[0]?.generator.state).toBe('paused');
    expect(body.nets[0]?.generator).not.toHaveProperty('cadenceMs');
    expect(body.nets[0]?.generator.stale).toBe(false);
  });

  it('requires auth', async () => {
    const { app } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
    });
    const res = await app.request('/v1/launcher/status');
    expect(res.status).toBe(401);
  });
});

interface TasksResponseBody {
  schemaVersion: number;
  generatedAt: string;
  cursor?: { before: string };
  tasks: Array<{
    taskId: string;
    taskCid: string;
    solverNet: string;
    postedAt: string;
    state: string;
    onchainStatus: string;
    claims: { current: number; max: number };
    budget: { totalWei: string; remainingWei: string; reclaimableAt?: string };
    summary?: { title?: string; resolutionTime?: string };
  }>;
}

describe('GET /v1/launcher/tasks', () => {
  it('returns tasks posted by this daemon creator, most recent first', async () => {
    const { app, token } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      postedTasks: [
        {
          taskId: '0xa',
          taskCid: 'Qma',
          solverType: 'prediction.v1',
          postedAt: '2026-05-05T10:00:00.000Z',
        },
        {
          taskId: '0xb',
          taskCid: 'Qmb',
          solverType: 'prediction.v1',
          postedAt: '2026-05-05T11:00:00.000Z',
        },
      ],
    });
    const res = await app.request('/v1/launcher/tasks', {
      headers: { 'x-jinn-ui-token': token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TasksResponseBody;
    expect(body.schemaVersion).toBe(1);
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0]?.taskId).toBe('0xb');
    expect(body.tasks[1]?.taskId).toBe('0xa');
    expect(body.tasks[0]?.solverNet).toBe('prediction.v1');
    // Default state/claims/budget when the daemon doesn't yet track lifecycle.
    expect(body.tasks[0]?.state).toBe('open');
    expect(body.tasks[0]?.claims).toEqual({ current: 0, max: 25 });
    expect(body.tasks[0]?.budget).toEqual({ totalWei: '0', remainingWei: '0' });
    // No cursor because page is not full.
    expect(body.cursor).toBeUndefined();
  });

  it('respects ?cursor=before:<iso>&limit=N pagination', async () => {
    const fixtures: PostedTaskRecord[] = [
      { taskId: '0xa', taskCid: 'Qma', solverType: 'prediction.v1', postedAt: '2026-05-05T08:00:00.000Z' },
      { taskId: '0xb', taskCid: 'Qmb', solverType: 'prediction.v1', postedAt: '2026-05-05T09:00:00.000Z' },
      { taskId: '0xc', taskCid: 'Qmc', solverType: 'prediction.v1', postedAt: '2026-05-05T10:00:00.000Z' },
      { taskId: '0xd', taskCid: 'Qmd', solverType: 'prediction.v1', postedAt: '2026-05-05T11:00:00.000Z' },
    ];
    const { app, token, fetchSpy } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      postedTasks: fixtures,
    });

    // Page 1: limit=2, no cursor → newest two (0xd, 0xc), cursor = postedAt of 0xc.
    const page1Res = await app.request('/v1/launcher/tasks?limit=2', {
      headers: { 'x-jinn-ui-token': token },
    });
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as TasksResponseBody;
    expect(page1.tasks.map((t) => t.taskId)).toEqual(['0xd', '0xc']);
    expect(page1.cursor).toBeDefined();
    expect(page1.cursor?.before).toBe('2026-05-05T10:00:00.000Z');

    // Page 2: pass the cursor back (with the `before:` prefix). Use a
    // larger limit so the response is partial and the gather function
    // signals "no further page" by omitting the cursor.
    const cursorParam = `before:${page1.cursor!.before}`;
    const page2Res = await app.request(
      `/v1/launcher/tasks?limit=10&cursor=${encodeURIComponent(cursorParam)}`,
      { headers: { 'x-jinn-ui-token': token } },
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as TasksResponseBody;
    expect(page2.tasks.map((t) => t.taskId)).toEqual(['0xb', '0xa']);
    // Partial page → no cursor.
    expect(page2.cursor).toBeUndefined();
    // The fetch dep saw the parsed before timestamp.
    expect(fetchSpy.lastOpts?.before).toBe('2026-05-05T10:00:00.000Z');
    expect(fetchSpy.lastOpts?.limit).toBe(10);
  });

  it('passes ?manifestCid through so owned launched SolverNets can fetch statuses without membership', async () => {
    const statusCalls: string[] = [];
    const { app, token } = buildTestApp({
      posting: [],
      executionWiring: [],
      postedTasks: [
        {
          taskId: 'display-task',
          protocolTaskId: '42',
          taskCid: 'Qmstatus',
          solverType: 'prediction.v1',
          postedAt: '2026-05-05T10:00:00.000Z',
        },
      ],
      fetchTaskStatuses: async (manifestCid) => {
        statusCalls.push(manifestCid);
        return new Map([
          ['42', { taskId: '42', finalized: true, refunded: false }],
        ]);
      },
    });

    const res = await app.request('/v1/launcher/tasks?manifestCid=bafy-owned-launch', {
      headers: { 'x-jinn-ui-token': token },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TasksResponseBody;
    expect(statusCalls).toEqual(['bafy-owned-launch']);
    expect(body.tasks[0]?.onchainStatus).toBe('finalized');
  });

  it('maps unknown solverType to solverNet="unknown" without dropping the row', async () => {
    const { app, token } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      postedTasks: [
        {
          taskId: '0xa',
          taskCid: 'Qma',
          solverType: 'mystery.v1',
          postedAt: '2026-05-05T10:00:00.000Z',
        },
      ],
    });
    const res = await app.request('/v1/launcher/tasks', {
      headers: { 'x-jinn-ui-token': token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TasksResponseBody;
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]?.solverNet).toBe('unknown');
  });

  it('uses local task_payload claimPolicy.maxClaims and task_run state for SWE posts', async () => {
    await withTempStore(async (store) => {
      const postedAt = '2026-05-05T12:00:00.000Z';
      store.upsertTaskPostRecord({
        creatorSafeAddress: SAFE_ADDRESS,
        sourceKey: 'swe-rebench-v2.local',
        policyType: 'once_per_bucket',
        scopeKey: 'swe-instance-1',
        taskId: 'swe-task-1',
        protocolTaskId: '1',
        taskCid: 'bafy-swe-task-1',
        requestId: 'post-request-1',
        firstPostedAt: postedAt,
        lastPostedAt: postedAt,
        postCount: 1,
        canonicalTaskJson: JSON.stringify({
          id: 'swe-task-1',
          description: 'SWE task',
          solverType: 'swe-rebench-v2.v1',
          role: 'restoration',
          claimPolicy: {
            mode: 'parallel',
            maxClaims: 50,
            maxClaimsPerOperator: 5,
            claimLeaseTtlSeconds: 3_600,
          },
        }),
      });
      store.recordActivityEvent({
        ts: postedAt,
        kind: 'task_posted',
        requestId: 'post-request-1',
        solverType: 'swe-rebench-v2.v1',
      });

      seedNativeRun(store, {
        requestId: 'claim-request-1',
        taskId: 'swe-task-1',
        taskCid: 'bafy-swe-task-1',
        solverType: 'swe-rebench-v2.v1',
        taskRole: 'restoration',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        state: 'WAITING',
        task: {
          id: 'swe-task-1',
          description: 'SWE task',
          solverType: 'swe-rebench-v2.v1',
          role: 'restoration',
          claimPolicy: {
            mode: 'parallel',
            maxClaims: 50,
            maxClaimsPerOperator: 5,
            claimLeaseTtlSeconds: 3_600,
          },
        },
      });

      const { app, token } = buildTestApp({
        executionWiring: [SWE_WIRING],
        postedTasks: ({ creatorAddress, limit, before }) =>
          store.listPostedTasksByCreator({
            creatorSafeAddress: creatorAddress,
            limit,
            ...(before ? { before } : {}),
          }).map((r) => ({
            taskId: r.taskId,
            taskCid: r.taskCid,
            solverType: r.solverType ?? undefined,
            postedAt: r.postedAt,
            ...(r.state ? { state: r.state } : {}),
            ...(r.claims ? { claims: r.claims } : {}),
          })),
      });

      const res = await app.request('/v1/launcher/tasks', {
        headers: { 'x-jinn-ui-token': token },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as TasksResponseBody;
      expect(body.tasks[0]?.solverNet).toBe('swe-rebench-v2.v1');
      expect(body.tasks[0]?.claims).toEqual({ current: 1, max: 50 });
      expect(body.tasks[0]?.state).toBe('claims-in-flight');
    });
  });

  it('uses SolverNet contract claim defaults when a SWE post has no local run payload', async () => {
    const { app, token } = buildTestApp({
      executionWiring: [SWE_WIRING],
      postedTasks: [
        {
          taskId: 'swe-open-1',
          taskCid: 'bafy-swe-open-1',
          solverType: 'swe-rebench-v2.v1',
          postedAt: '2026-05-05T12:00:00.000Z',
        },
      ],
    });

    const res = await app.request('/v1/launcher/tasks', {
      headers: { 'x-jinn-ui-token': token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TasksResponseBody;
    expect(body.tasks[0]?.solverNet).toBe('swe-rebench-v2.v1');
    expect(body.tasks[0]?.claims).toEqual({ current: 0, max: 5 });
  });

  it('clamps limit to [1, 100]', async () => {
    const { app, token, fetchSpy } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      postedTasks: [],
    });
    await app.request('/v1/launcher/tasks?limit=999', {
      headers: { 'x-jinn-ui-token': token },
    });
    expect(fetchSpy.lastOpts?.limit).toBe(100);

    await app.request('/v1/launcher/tasks?limit=0', {
      headers: { 'x-jinn-ui-token': token },
    });
    expect(fetchSpy.lastOpts?.limit).toBe(1);
  });

  it('requires auth', async () => {
    const { app } = buildTestApp({
      posting: [PREDICTION_POSTING],
      executionWiring: [PREDICTION_WIRING],
      postedTasks: [],
    });
    const res = await app.request('/v1/launcher/tasks');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /v1/launcher/solvernets/:name (retired)', () => {
  // The PATCH route was retired by Task 22 of
  // spec/2026-05-05-solvernet-creation-and-launch.md — the operator-config
  // `'launching'` role + top-level `predictionV1*` generator-config keys it
  // managed were dropped from the schema. The route now returns 410 Gone so
  // SPA clients on stale builds get a clear signal.
  it('returns 410 Gone (legacy launcher PATCH retired by Task 22)', async () => {
    const { app, token, readPersistedConfig, readNotifiedSolverNets } = buildTestApp({
      executionWiring: [PREDICTION_WIRING],
    });
    const res = await app.request('/v1/launcher/solvernets/prediction', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-jinn-ui-token': token },
      body: JSON.stringify({
        launching: true,
        generator: { cadenceMs: 30_000 },
      }),
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe('gone');
    expect(body.message).toMatch(/Task 22/);
    // Nothing should be persisted or notified — the endpoint is inert.
    expect(readPersistedConfig()).toEqual({});
    expect(readNotifiedSolverNets()).toBeUndefined();
  });

  it('still requires auth', async () => {
    const { app } = buildTestApp({
      executionWiring: [PREDICTION_WIRING],
    });
    const res = await app.request('/v1/launcher/solvernets/prediction', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ launching: true }),
    });
    expect(res.status).toBe(401);
  });
});
