import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
import { canonicalJson } from '@/harnesses/engine/canonical-json.js';

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
vi.mock('@/tasks/submit-preflight.js', () => ({
  runMarketplaceTaskSubmitPreflight,
  resolveMarketplaceTaskSolverNet,
}));

const V2_ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'jinn-task-submit-request.v1',
    id: `autopilot:${V2_ATTEMPT_ID}`,
    description: 'Implement issue 42',
    solverType: 'jinn-repo.v1',
    solverNetManifestCid: 'bafy-autopilot-manifest',
    createdAt: 1_784_761_200_000,
    window: { startTs: 1_784_761_200_000, endTs: 1_784_764_800_000 },
    claimPolicy: {
      mode: 'exclusive',
      maxClaims: 1,
      maxClaimsPerOperator: 1,
      claimWindowStartTs: 1_784_761_200_000,
      claimWindowEndTs: 1_784_762_100_000,
      submissionDeadlineTs: 1_784_764_500_000,
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
      problem_statement: 'Implement issue 42',
      session: {
        schemaVersion: 'jinn-autopilot-session.v1',
        workflow: 'implement',
        repository: 'Jinn-Network/mono',
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
        },
        workflowContract: {
          skill: 'implement-issue',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
        deadline: '2026-07-22T23:50:00.000Z',
        receiptAuthors: ['jinn-autopilot'],
      },
    },
    ...overrides,
  };
}

describe('MarketplaceTaskSubmitRequestSchema', () => {
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

  it('emits Task CID, chain origin, manifest, and idempotency in JSON', async () => {
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
    let firstSignedTask: unknown;
    const pendingTxHash = `0x${'ef'.repeat(32)}` as const;
    Object.assign(firstAdapter, {
      postTask: vi.fn(async (task: { signedTask?: unknown }, options?: {
        onTransactionHash?: (txHash: typeof pendingTxHash) => void | Promise<void>;
      }) => {
        firstSignedTask = task.signedTask;
        await options?.onTransactionHash?.(pendingTxHash);
        throw Object.assign(new Error('simulated crash after Safe submission'), {
          name: 'PendingTaskSubmissionError',
          txHash: pendingTxHash,
        });
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
    expect(existsSync(marketplaceTaskSelectionSidecarPath(file))).toBe(true);
    firstStore.close();
    await firstAdapter.stop();

    resolveMarketplaceTaskSolverNet.mockRejectedValue(new Error('catalog unavailable'));
    const secondAdapter = new LocalAdapter();
    await secondAdapter.initialize();
    let recoveredSignedTask: unknown;
    Object.assign(secondAdapter, {
      recoverTaskPost: vi.fn(async (input: { signedTask: unknown }) => {
        recoveredSignedTask = input.signedTask;
        return {
          taskId: 'frozen-task-77',
          taskCid: `f01551220${'ab'.repeat(32)}`,
          txHash: pendingTxHash,
          blockNumber: 777,
        };
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
      taskId: 'frozen-task-77',
      solverNetManifestCid: 'bafy-frozen-selection',
      status: 'already_submitted',
    });
    expect(canonicalJson(recoveredSignedTask)).toBe(canonicalJson(firstSignedTask));
    expect(resolveMarketplaceTaskSolverNet).toHaveBeenCalledTimes(1);
    secondStore.close();
    await secondAdapter.stop();
  });
});
