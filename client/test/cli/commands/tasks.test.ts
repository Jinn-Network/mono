import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tasksCommand from '@/cli/commands/tasks.js';
import {
  MarketplaceTaskSubmitRequestSchema,
  parseMarketplaceTaskSubmitRequest,
} from '@/tasks/submit-request.js';
import { makeCommandCtx } from '@test/cli.js';
import { LocalAdapter } from '@/adapters/local/adapter.js';
import { Store } from '@/store/store.js';
import { marketplaceTaskSelectionSidecarPath } from '@/tasks/submit-selection.js';
import { canonicalJson } from '@/util/canonical-json.js';
import {
  executeSafeTransaction,
  SafePostBroadcastHookError,
} from '@/adapters/mech/safe.js';
import Database from 'better-sqlite3';
import {
  TaskSubmitRequestV1Schema,
  TaskSubmitResultV1Schema,
} from '@jinn-network/sdk/autopilot';

const createCliExecutionContext = vi.hoisted(() => vi.fn());
const createCliReadOnlySignerContext = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  ctx: {
    fleetState: {
      services: [{
        index: 0,
        step: 'complete',
        safe_address: '0x00112233445566778899aabbccddeeff00112233',
        mech_address: '0x2222222222222222222222222222222222222222',
      }],
    },
  },
})));
const runMarketplaceTaskSubmitPreflight = vi.hoisted(() => vi.fn(async () => undefined));
const resolveMarketplaceTaskSolverNet = vi.hoisted(() => vi.fn(async (input: {
  explicitManifestCid?: string;
}) => input.explicitManifestCid ?? 'bafy-auto-selected'));
const gatherIntrospectionRaw = vi.hoisted(() => vi.fn(async () => ({
  fleet: {
    services: [{
      step: 'complete',
      safe_address: '0x00112233445566778899aabbccddeeff00112233',
    }],
  },
})));
vi.mock('@/cli/execution-context.js', () => ({
  createCliExecutionContext,
  createCliReadOnlySignerContext,
  pickPrimaryMechService: (services: Array<{ safe_address?: string; mech_address?: string }>) =>
    services.find((service) => service.safe_address && service.mech_address),
}));
vi.mock('@/cli/introspection-context.js', () => ({ gatherIntrospectionRaw }));
vi.mock('@/tasks/submit-preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/tasks/submit-preflight.js')>()),
  runMarketplaceTaskSubmitPreflight,
  resolveMarketplaceTaskSolverNet,
}));

const V2_ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const SAFE_WRAPPER_TX_HASH = `0x${'9a'.repeat(32)}` as const;

/**
 * Drives the real `executeSafeTransaction` chokepoint (single-broadcaster cutover — plan Task
 * 7; per-daemon state — finding E16 / the C2 ruling). It requires a `VenueBroadcaster` bound to
 * the Safe under test, so this helper builds a stub one and passes it explicitly on each call —
 * no process-global to install or clear. `writeContract` stands in for the broadcaster's
 * underlying wallet write; both existing usages exercise the `beforeBroadcast` fence rejecting
 * BEFORE the broadcaster is ever reached, so `writeContract` staying uncalled is still the
 * meaningful assertion.
 */
async function postThroughSafeWalletBoundary(
  options: {
    beforeBroadcast?: () => void | Promise<void>;
    onTransactionHash?: (txHash: typeof SAFE_WRAPPER_TX_HASH) => void | Promise<void>;
  } | undefined,
  writeContract: ReturnType<typeof vi.fn>,
) {
  const safeAddress = '0x00112233445566778899aabbccddeeff00112233' as const;
  const broadcaster = {
    safeAddress,
    execute: async (request: unknown) => ({
      txHash: (await writeContract(request)) as typeof SAFE_WRAPPER_TX_HASH,
    }),
  };
  const txHash = await executeSafeTransaction(
    {} as never,
    {} as never,
    {
      safeAddress,
      to: '0x2222222222222222222222222222222222222222',
      value: 0n,
      data: '0xdeadbeef',
    },
    broadcaster,
    {
      beforeBroadcast: options?.beforeBroadcast,
      onBroadcast: options?.onTransactionHash,
    },
  );
  return {
    taskId: 'wallet-boundary-task',
    taskCid: `f01551220${'ab'.repeat(32)}`,
    txHash,
    blockNumber: 88,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  const startTs = 1_900_000_000_000;
  const endTs = startTs + 3_600_000;
  const claimEndTs = startTs + 900_000;
  const submissionDeadlineTs = startTs + 3_300_000;
  return {
    schemaVersion: 'jinn-task-submit-request.v1',
    id: `autopilot:${V2_ATTEMPT_ID}`,
    description: 'Implement issue 42',
    solverType: 'jinn-repo.v1',
    solverNetManifestCid: 'bafy-autopilot-manifest',
    createdAt: startTs,
    window: { startTs, endTs },
    claimPolicy: {
      mode: 'exclusive',
      maxClaims: 1,
      maxClaimsPerOperator: 1,
      claimWindowStartTs: startTs,
      claimWindowEndTs: claimEndTs,
      submissionDeadlineTs,
      claimLeaseTtlSeconds: 1800,
      requiredVerdicts: 1,
    },
    spec: {
      schemaVersion: 'jinn-repo.v1',
      source: 'autopilot-session',
      instance_id: `autopilot:${V2_ATTEMPT_ID}`,
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      problem_statement: 'Implement issue 42',
      session: {
        schemaVersion: 'jinn-autopilot-session.v1',
        workflow: 'implement',
        repository: 'Jinn-Network/mono',
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
        issueNumber: 42,
        prNumber: 314,
        targetBase: 'next',
        branch: 'autopilot/issue-42',
        claimOid: 'b'.repeat(40),
        expectedHead: 'c'.repeat(40),
        v2AttemptId: V2_ATTEMPT_ID,
        runnerId: 'runner-1',
        taskSnapshot: {
          title: 'Issue 42',
          body: 'Implement it',
          prBody: 'Draft',
          baseSha: 'd'.repeat(40),
          targetBaseOid: 'd'.repeat(40),
        },
        workflowContract: {
          skill: 'implement-issue',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
        deadline: new Date(startTs + 1_800_000).toISOString(),
        receiptAuthors: ['jinn-autopilot'],
      },
    },
    ...overrides,
  };
}

describe('MarketplaceTaskSubmitRequestSchema', () => {
  it('is a compatibility alias of the SDK request validator', () => {
    expect(MarketplaceTaskSubmitRequestSchema).toBe(TaskSubmitRequestV1Schema);
  });

  it('accepts the exact machine submission contract', () => {
    expect(MarketplaceTaskSubmitRequestSchema.parse(request()).id)
      .toBe(`autopilot:${V2_ATTEMPT_ID}`);
  });

  it('rejects unknown fields and malformed policy values', () => {
    expect(() => parseMarketplaceTaskSubmitRequest(request({ unexpected: true }))).toThrow();
    expect(() => parseMarketplaceTaskSubmitRequest(request({
      claimPolicy: { ...request().claimPolicy, maxClaims: 2 },
    }))).toThrow();
  });

  it('requires the deterministic key to match the V2 attempt', () => {
    expect(() => parseMarketplaceTaskSubmitRequest(request({ id: 'manual-key' })))
      .toThrow(/autopilot:/);
  });

  it('accepts omission of SolverNet selection for unique-live indexer resolution', () => {
    const value = request();
    delete value.solverNetManifestCid;
    expect(parseMarketplaceTaskSubmitRequest(value).solverNetManifestCid).toBeUndefined();
  });

  it('rejects contradictory manifest CID and SolverNet name selection', () => {
    expect(() => parseMarketplaceTaskSubmitRequest(request({
      solverNet: 'Autopilot production',
    }))).toThrow(/mutually exclusive/i);
  });

  it.each([
    ['claim window ordering', (value: any) => {
      value.claimPolicy.claimWindowEndTs = value.claimPolicy.claimWindowStartTs;
    }],
    ['claim start within Task window', (value: any) => {
      value.claimPolicy.claimWindowStartTs = value.window.startTs - 1;
    }],
    ['claim end within Task window', (value: any) => {
      value.claimPolicy.claimWindowEndTs = value.window.endTs + 1;
    }],
    ['submission after claim window', (value: any) => {
      value.claimPolicy.submissionDeadlineTs = value.claimPolicy.claimWindowEndTs;
    }],
    ['submission within Task window', (value: any) => {
      value.claimPolicy.submissionDeadlineTs = value.window.endTs + 1;
    }],
    ['creation no later than Task start', (value: any) => {
      value.createdAt = value.window.startTs + 1;
    }],
    ['session deadline within submission deadline', (value: any) => {
      value.spec.session.deadline = new Date(
        value.claimPolicy.submissionDeadlineTs + 1,
      ).toISOString();
    }],
  ])('rejects invalid timing: %s', (_name, mutate) => {
    const value = request();
    mutate(value);
    expect(() => parseMarketplaceTaskSubmitRequest(value)).toThrow();
  });
});

describe('tasks submit machine contract', () => {
  afterEach(() => {
    createCliExecutionContext.mockReset();
    createCliReadOnlySignerContext.mockClear();
    gatherIntrospectionRaw.mockClear();
    runMarketplaceTaskSubmitPreflight.mockClear();
    resolveMarketplaceTaskSolverNet.mockReset();
    resolveMarketplaceTaskSolverNet.mockImplementation(
      async (input: { explicitManifestCid?: string }) =>
        input.explicitManifestCid ?? 'bafy-auto-selected',
    );
    vi.useRealTimers();
  });

  it.each([
    {
      name: 'requires --json',
      extraFlags: [] as string[],
      message: '--json is required',
    },
    {
      name: 'rejects --human',
      extraFlags: ['--json', '--human'],
      message: '--human is not supported',
    },
  ])('$name for request-file submission', async ({ extraFlags, message }) => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-submit-machine-mode-'));
    const file = join(dir, 'request.json');
    writeFileSync(file, JSON.stringify(request()));
    const made = makeCommandCtx({
      argv: [
        'submit',
        '--request-file',
        file,
        '--dry-run',
        ...extraFlags,
      ],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: expect.stringContaining(message),
    });
    expect(made.exits).toEqual([11]);
    expect(createCliReadOnlySignerContext).not.toHaveBeenCalled();
  });

  it('rejects request-file combined with legacy loose flags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-submit-'));
    const file = join(dir, 'request.json');
    writeFileSync(file, JSON.stringify(request()));
    const made = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--id', 'legacy', '--dry-run', '--json'],
    });

    await tasksCommand.run(made.ctx);

    const output = JSON.parse(made.writes.at(-1)!);
    expect(output.code).toBe('invalid_invocation');
    expect(output.message).toMatch(/mutually exclusive/i);
    expect(made.exits).toEqual([11]);
  });

  it('dry-run validates without constructing a posting context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-submit-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(request()));
    writeFileSync(config, '{}');
    const made = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--dry-run', '--json'],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      dryRun: true,
      verb: 'tasks submit',
    });
    expect(createCliExecutionContext).not.toHaveBeenCalled();
    expect(createCliReadOnlySignerContext).toHaveBeenCalledOnce();
    expect(gatherIntrospectionRaw).not.toHaveBeenCalled();
    expect(runMarketplaceTaskSubmitPreflight).toHaveBeenCalledOnce();
  });

  it('rejects a first-time expired machine request without posting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-submit-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    const value = request();
    writeFileSync(file, JSON.stringify(value));
    writeFileSync(config, '{}');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(value.claimPolicy.submissionDeadlineTs + 1));
    const dryRun = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--dry-run', '--json'],
    });
    await tasksCommand.run(dryRun.ctx);
    expect(JSON.parse(dryRun.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: expect.stringMatching(/freshness|expired|deadline/i),
    });
    expect(resolveMarketplaceTaskSolverNet).not.toHaveBeenCalled();
    expect(createCliReadOnlySignerContext).not.toHaveBeenCalled();
    expect(createCliExecutionContext).not.toHaveBeenCalled();
    expect(existsSync(marketplaceTaskSelectionSidecarPath(file))).toBe(false);

    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const postTask = vi.spyOn(adapter, 'postTask');
    createCliExecutionContext.mockResolvedValueOnce({
      ok: true,
      ctx: {
        adapter,
        jinnStore: store,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const live = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(live.ctx);
    expect(JSON.parse(live.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      details: { field: 'freshness', reason: 'policy_expired' },
    });
    expect(postTask).not.toHaveBeenCalled();
    store.close();
    await adapter.stop();
  });

  it('returns freshness invalid_invocation when expired recovery context is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-expired-context-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    const value = request();
    writeFileSync(file, JSON.stringify(value));
    writeFileSync(config, '{}');
    vi.useFakeTimers();
    vi.setSystemTime(value.claimPolicy.claimWindowEndTs + 1);
    const postTask = vi.fn();
    createCliExecutionContext.mockResolvedValueOnce({
      ok: false,
      envelope: {
        code: 'bootstrap_incomplete',
        message: 'no operational creator Safe',
      },
      ctx: { adapter: { postTask } },
    });
    const made = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      details: { field: 'freshness', reason: 'policy_expired' },
    });
    expect(postTask).not.toHaveBeenCalled();
  });

  it('recovers an expired crashed machine request without a second transaction broadcast', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-expired-recovery-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    const dbPath = join(dir, 'jinn.db');
    const value = request();
    writeFileSync(file, JSON.stringify(value));
    writeFileSync(config, '{}');
    vi.useFakeTimers();
    vi.setSystemTime(value.claimPolicy.claimWindowEndTs - 60_001);

    const firstAdapter = new LocalAdapter();
    await firstAdapter.initialize();
    const firstStore = new Store(dbPath);
    const firstBroadcast = vi.fn();
    Object.assign(firstAdapter, {
      postTask: vi.fn(async (_task: unknown, options?: {
        beforeBroadcast?: () => void | Promise<void>;
      }) => {
        await options?.beforeBroadcast?.();
        firstBroadcast();
        throw new Error('simulated crash after first transaction broadcast');
      }),
    });
    createCliExecutionContext.mockResolvedValueOnce({
      ok: true,
      ctx: {
        adapter: firstAdapter,
        jinnStore: firstStore,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const first = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(first.ctx);
    expect(firstBroadcast).toHaveBeenCalledOnce();
    firstStore.close();
    await firstAdapter.stop();

    vi.setSystemTime(value.claimPolicy.claimWindowEndTs + 1);
    const secondAdapter = new LocalAdapter();
    await secondAdapter.initialize();
    const secondBroadcast = vi.fn();
    const recoverTaskPost = vi.fn().mockResolvedValue({
      taskId: 'expired-recovered-task',
      taskCid: `f01551220${'ab'.repeat(32)}`,
      txHash: `0x${'cd'.repeat(32)}`,
      blockNumber: 321,
    });
    Object.assign(secondAdapter, {
      recoverTaskPost,
      postTask: vi.fn(async () => {
        secondBroadcast();
        throw new Error('must not broadcast a second transaction');
      }),
    });
    const secondStore = new Store(dbPath);
    createCliExecutionContext.mockResolvedValueOnce({
      ok: true,
      ctx: {
        adapter: secondAdapter,
        jinnStore: secondStore,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const second = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(second.ctx);

    expect(JSON.parse(second.writes.at(-1)!)).toMatchObject({
      taskId: 'expired-recovered-task',
      status: 'already_submitted',
      idempotent: true,
    });
    expect(recoverTaskPost).toHaveBeenCalledOnce();
    expect(secondBroadcast).not.toHaveBeenCalled();
    secondStore.close();
    await secondAdapter.stop();
  });

  it('classifies an expired recovery-only immutable mismatch as invalid without broadcasting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-expired-mismatch-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    const dbPath = join(dir, 'jinn.db');
    const value = request();
    writeFileSync(file, JSON.stringify(value));
    writeFileSync(config, '{}');
    vi.useFakeTimers();
    vi.setSystemTime(value.claimPolicy.claimWindowEndTs - 60_001);

    const firstAdapter = new LocalAdapter();
    await firstAdapter.initialize();
    const firstStore = new Store(dbPath);
    const firstBroadcast = vi.fn();
    Object.assign(firstAdapter, {
      postTask: vi.fn(async (_task: unknown, options?: {
        beforeBroadcast?: () => void | Promise<void>;
      }) => {
        await options?.beforeBroadcast?.();
        firstBroadcast();
        throw new Error('simulated crash after first transaction broadcast');
      }),
    });
    createCliExecutionContext.mockResolvedValueOnce({
      ok: true,
      ctx: {
        adapter: firstAdapter,
        jinnStore: firstStore,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const first = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(first.ctx);
    expect(firstBroadcast).toHaveBeenCalledOnce();
    firstStore.close();
    await firstAdapter.stop();

    writeFileSync(file, JSON.stringify({
      ...value,
      description: 'Forged replacement content',
    }));
    unlinkSync(marketplaceTaskSelectionSidecarPath(file));
    vi.setSystemTime(value.claimPolicy.claimWindowEndTs + 1);

    const secondAdapter = new LocalAdapter();
    await secondAdapter.initialize();
    const secondBroadcast = vi.spyOn(secondAdapter, 'postTask');
    const recoverTaskPost = vi.fn();
    Object.assign(secondAdapter, { recoverTaskPost });
    const secondStore = new Store(dbPath);
    createCliExecutionContext.mockResolvedValueOnce({
      ok: true,
      ctx: {
        adapter: secondAdapter,
        jinnStore: secondStore,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const second = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });

    await tasksCommand.run(second.ctx);

    expect(JSON.parse(second.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      details: { field: 'freshness', reason: 'policy_expired' },
    });
    expect(recoverTaskPost).not.toHaveBeenCalled();
    expect(secondBroadcast).not.toHaveBeenCalled();
    secondStore.close();
    await secondAdapter.stop();
  });

  it('emits Safe-wrapped wallet-boundary ownership loss as transient without retrying or writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-owner-fence-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    const dbPath = join(dir, 'jinn.db');
    writeFileSync(file, JSON.stringify(request()));
    writeFileSync(config, '{}');
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(dbPath);
    const writeContract = vi.fn().mockResolvedValue(SAFE_WRAPPER_TX_HASH);
    Object.assign(adapter, {
      postTask: vi.fn(async (_task: unknown, options?: {
        beforeBroadcast?: () => void | Promise<void>;
        onTransactionHash?: (txHash: typeof SAFE_WRAPPER_TX_HASH) => void | Promise<void>;
      }) => {
        const tamper = new Database(dbPath);
        tamper.prepare(`UPDATE task_post_locks SET owner_token = 'stolen-owner'`).run();
        tamper.close();
        return postThroughSafeWalletBoundary(options, writeContract);
      }),
    });
    createCliExecutionContext.mockResolvedValueOnce({
      ok: true,
      ctx: {
        adapter,
        jinnStore: store,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const made = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'transient_error',
      details: { reason: 'ownership_lost' },
    });
    expect(writeContract).not.toHaveBeenCalled();
    store.close();
    await adapter.stop();
  });

  it('rechecks freshness after slow preparation at the Safe wallet boundary and never writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-final-freshness-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    const value = request();
    writeFileSync(file, JSON.stringify(value));
    writeFileSync(config, '{}');
    vi.useFakeTimers();
    vi.setSystemTime(value.claimPolicy.claimWindowEndTs - 60_001);
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const writeContract = vi.fn().mockResolvedValue(SAFE_WRAPPER_TX_HASH);
    Object.assign(adapter, {
      postTask: vi.fn(async (_task: unknown, options?: {
        beforeBroadcast?: () => void | Promise<void>;
        onTransactionHash?: (txHash: typeof SAFE_WRAPPER_TX_HASH) => void | Promise<void>;
      }) => {
        vi.setSystemTime(value.claimPolicy.claimWindowEndTs - 59_999);
        return postThroughSafeWalletBoundary(options, writeContract);
      }),
    });
    createCliExecutionContext.mockResolvedValueOnce({
      ok: true,
      ctx: {
        adapter,
        jinnStore: store,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const made = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      details: { field: 'freshness', reason: 'policy_expired' },
    });
    expect(writeContract).not.toHaveBeenCalled();
    expect(store.getTaskPostRecord({
      creatorSafeAddress: '0x00112233445566778899AABbCCdDeeFf00112233',
      sourceKey: value.id,
      policyType: 'once_per_safe',
      scopeKey: '',
    })?.broadcastIntentAt).toBeNull();
    store.close();
    await adapter.stop();
  });

  it('emits Task CID, chain origin, manifest, and idempotency in JSON', async () => {
    const parseResult = vi.spyOn(TaskSubmitResultV1Schema, 'parse');
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-submit-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(request()));
    writeFileSync(config, '{}');
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    createCliExecutionContext.mockResolvedValue({
      ok: true,
      ctx: {
        adapter,
        jinnStore: store,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const made = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });

    await tasksCommand.run(made.ctx);

    const first = JSON.parse(made.writes.at(-1)!);
    expect(first).toMatchObject({
      taskId: '1',
      taskCid: 'local-1',
      creationTx: expect.stringMatching(/^0x/),
      creationBlock: expect.any(Number),
      solverNetManifestCid: 'bafy-autopilot-manifest',
      idempotent: false,
    });
    const retryMade = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(retryMade.ctx);
    const retry = JSON.parse(retryMade.writes.at(-1)!);
    expect(retry).toMatchObject({
      taskId: first.taskId,
      taskCid: first.taskCid,
      creationTx: first.creationTx,
      creationBlock: first.creationBlock,
      solverNetManifestCid: first.solverNetManifestCid,
      idempotent: true,
    });
    expect(parseResult).toHaveBeenCalledTimes(2);
    expect(TaskSubmitResultV1Schema.parse(first)).toEqual(first);
    expect(TaskSubmitResultV1Schema.parse(retry)).toEqual(retry);
    parseResult.mockRestore();
    store.close();
    await adapter.stop();
  });

  it('uses the unique public-indexer SolverNet for dry-run and real submission when omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-submit-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    const value = request();
    delete value.solverNetManifestCid;
    writeFileSync(file, JSON.stringify(value));
    writeFileSync(config, '{}');

    const dry = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--dry-run', '--json'],
    });
    await tasksCommand.run(dry.ctx);
    expect(JSON.parse(dry.writes.at(-1)!).plan[0]).toMatchObject({
      solverNetManifestCid: 'bafy-auto-selected',
    });
    expect(existsSync(marketplaceTaskSelectionSidecarPath(file))).toBe(false);

    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    createCliExecutionContext.mockResolvedValue({
      ok: true,
      ctx: {
        adapter,
        jinnStore: store,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const real = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(real.ctx);
    expect(JSON.parse(real.writes.at(-1)!)).toMatchObject({
      solverNetManifestCid: 'bafy-auto-selected',
      idempotent: false,
    });
    expect(resolveMarketplaceTaskSolverNet).toHaveBeenCalledWith(expect.objectContaining({
      explicitManifestCid: undefined,
      requestedName: undefined,
    }));
    expect(existsSync(marketplaceTaskSelectionSidecarPath(file))).toBe(true);
    store.close();
    await adapter.stop();
  });

  it('reuses a crash-frozen auto-selection without catalog access and signs identical Task bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-submit-'));
    const file = join(dir, 'request.json');
    const config = join(dir, 'config.json');
    const dbPath = join(dir, 'jinn.db');
    const value = request();
    delete value.solverNetManifestCid;
    writeFileSync(file, JSON.stringify(value));
    writeFileSync(config, '{}');
    resolveMarketplaceTaskSolverNet.mockResolvedValueOnce('bafy-frozen-selection');

    const firstAdapter = new LocalAdapter();
    await firstAdapter.initialize();
    const firstStore = new Store(dbPath);
    const realUpsert = firstStore.upsertTaskPostRecord.bind(firstStore);
    vi.spyOn(firstStore, 'upsertTaskPostRecord').mockImplementation((record) => {
      if (record.creationTxHash) {
        throw new Error('simulated durable task_posts hash write failure');
      }
      realUpsert(record);
    });
    let firstSignedTask: unknown;
    const pendingTxHash = `0x${'ef'.repeat(32)}` as const;
    const firstWalletWrite = vi.fn();
    Object.assign(firstAdapter, {
      postTask: vi.fn(async (task: { signedTask?: unknown }, options?: {
        beforeBroadcast?: () => void | Promise<void>;
        onTransactionHash?: (txHash: typeof pendingTxHash) => void | Promise<void>;
      }) => {
        firstSignedTask = task.signedTask;
        await options?.beforeBroadcast?.();
        firstWalletWrite();
        try {
          await options?.onTransactionHash?.(pendingTxHash);
        } catch (cause) {
          throw new SafePostBroadcastHookError(pendingTxHash, cause);
        }
        throw new Error('expected durable hash persistence to fail');
      }),
    });
    createCliExecutionContext.mockResolvedValueOnce({
      ok: true,
      ctx: {
        adapter: firstAdapter,
        jinnStore: firstStore,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const first = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(first.ctx);
    expect(JSON.parse(first.writes.at(-1)!)).toMatchObject({
      code: 'transient_error',
      details: { txHash: pendingTxHash },
    });
    expect(firstSignedTask).toMatchObject({
      solverNetManifestCid: 'bafy-frozen-selection',
    });
    expect(firstWalletWrite).toHaveBeenCalledOnce();
    expect(existsSync(marketplaceTaskSelectionSidecarPath(file))).toBe(true);
    firstStore.close();
    await firstAdapter.stop();

    resolveMarketplaceTaskSolverNet.mockRejectedValue(new Error('catalog unavailable'));
    const secondAdapter = new LocalAdapter();
    await secondAdapter.initialize();
    let recoveredSignedTask: unknown;
    const secondPostTask = vi.fn();
    const recoverTaskPost = vi.fn()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async (input: { signedTask: unknown }) => {
        recoveredSignedTask = input.signedTask;
        return {
          taskId: 'frozen-task-77',
          taskCid: `f01551220${'ab'.repeat(32)}`,
          txHash: pendingTxHash,
          blockNumber: 777,
        };
      });
    Object.assign(secondAdapter, {
      recoverTaskPost,
      postTask: secondPostTask,
    });
    const secondStore = new Store(dbPath);
    createCliExecutionContext.mockResolvedValue({
      ok: true,
      ctx: {
        adapter: secondAdapter,
        jinnStore: secondStore,
        primaryService: {
          index: 0,
          safe_address: '0x00112233445566778899aabbccddeeff00112233',
        },
        mnemonic: 'test test test test test test test test test test test junk',
      },
    });
    const second = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(second.ctx);

    expect(JSON.parse(second.writes.at(-1)!)).toMatchObject({
      code: 'transient_error',
      details: { reason: 'broadcast_uncertain' },
    });
    expect(secondPostTask).not.toHaveBeenCalled();

    const third = makeCommandCtx({
      argv: ['submit', '--request-file', file, '--config', config, '--yes', '--json'],
    });
    await tasksCommand.run(third.ctx);
    expect(JSON.parse(third.writes.at(-1)!)).toMatchObject({
      taskId: 'frozen-task-77',
      solverNetManifestCid: 'bafy-frozen-selection',
      status: 'already_submitted',
    });
    expect(canonicalJson(recoveredSignedTask)).toBe(canonicalJson(firstSignedTask));
    expect(resolveMarketplaceTaskSolverNet).toHaveBeenCalledTimes(1);
    expect(recoverTaskPost).toHaveBeenCalledTimes(2);
    expect(secondPostTask).not.toHaveBeenCalled();
    secondStore.close();
    await secondAdapter.stop();
  });
});
