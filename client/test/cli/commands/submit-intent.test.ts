import { describe, expect, it } from 'vitest';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { makeCommandCtx } from '@test/cli.js';
import { createSubmitIntentCommand, type SubmitIntentDeps } from '../../../src/cli/commands/submit-intent.js';

const mockRaw: GatheredStatusRaw = {
  shutdownState: null,
  dbPath: '',
  activityCounts: {},
  recentActivity: [],
  lastRewardClaimTickAt: null,
  rewardClaimIntervalMs: 1,
  fleet: {
    master_address: '0x1234567890123456789012345678901234567890',
    chain: 'base-sepolia',
    staking_mode: 'standard',
    updated_at: '2026-04-14T12:00:00.000Z',
    services: [
      {
        index: 1,
        agent_address: '0xaabbccddeeff11223344556677889900aabbccdd',
        safe_address: '0x00112233445566778899aabbccddeeff00112233',
        service_id: 42,
        mech_address: null,
        staking_address: null,
        step: 'complete',
        error: null,
      },
    ],
  },
  rpc: { ok: true },
  master: { address: '0x1234567890123456789012345678901234567890', balanceWei: '0' },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
};

function makeFakeDeps(overrides?: Partial<SubmitIntentDeps>): SubmitIntentDeps {
  return {
    loadConfig: () => ({ earningDir: '/tmp', network: 'testnet', rpcUrl: 'http://127.0.0.1:8545' } as any),
    getConfigPathFromArgs: () => undefined,
    gatherIntrospectionRaw: async () => mockRaw,
    executionContextFactory: async () => ({ ok: false, envelope: { code: 'fatal', message: 'not used in dry-run tests' } } as any),
    postingServiceFactory: () => ({ postCandidate: async () => ({ requestId: '0xabc', idempotent: false, attemptId: 'a1', attemptNumber: 1 }) } as any),
    readChainlinkLatest: async () => ({ answer: 3500n, decimals: 8 } as any),
    chainlinkPublicClientFactory: () => ({} as any),
    isRecoverableTransactionError: () => false,
    ...overrides,
  };
}

describe('submit-intent command', () => {
  it('--dry-run emits a plan without executing', async () => {
    const cmd = createSubmitIntentCommand(makeFakeDeps());
    const { ctx, writes } = makeCommandCtx({ argv: [
      '--id',
      'test-1',
      '--description',
      'The service is healthy',
      '--dry-run',
    ], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
    expect(parsed.plan[0]).toMatchObject({ id: 'test-1' });
  });

  it('non-TTY without --yes or --dry-run emits invalid_invocation', async () => {
    const cmd = createSubmitIntentCommand(makeFakeDeps());
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--id', 'test-1', '--description', 'The service is healthy'], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('accepts --config and --password-fd on --dry-run (parse path)', async () => {
    const cmd = createSubmitIntentCommand(makeFakeDeps());
    const { ctx, writes } = makeCommandCtx({ argv: [
      '--id',
      'test-1',
      '--description',
      'The service is healthy',
      '--dry-run',
      '--config',
      '/nonexistent-config-path.json',
      '--password-fd',
      '9',
    ], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
  });

  it('missing --id emits invalid_invocation', async () => {
    const cmd = createSubmitIntentCommand(makeFakeDeps());
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--dry-run', '--description', 'x'], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--id');
    expect(exits).toEqual([11]);
  });

  it('--dry-run emits bootstrap_incomplete when no service is at step=complete', async () => {
    const emptyFleetRaw: GatheredStatusRaw = {
      ...mockRaw,
      fleet: { ...mockRaw.fleet!, services: [] },
    };
    const cmd = createSubmitIntentCommand(makeFakeDeps({
      gatherIntrospectionRaw: async () => emptyFleetRaw,
    }));
    const { ctx, writes, exits } = makeCommandCtx({ argv: [
      '--id',
      'test-1',
      '--description',
      'x',
      '--dry-run',
    ], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('bootstrap_incomplete');
    expect(parsed.exitCode).toBe(20);
    expect(exits).toEqual([20]);
  });

  it('accepts --spec-file with a prediction.v0 intent', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'cli-submit-intent-'));
    const tmpFile = join(tmp, 'pred-intent.json');
    writeFileSync(tmpFile, JSON.stringify({
      window: { startTs: 0, endTs: 3600000 },
      spec: {
        kind: 'prediction.v0',
        oracle: { venue: 'chainlink-base-sepolia', feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1', feedDescription: 'ETH / USD' },
        question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 4500000 },
      },
      eligibility: { maxSubmissionDelayMs: 60000 },
    }));
    const cmd = createSubmitIntentCommand(makeFakeDeps());
    const { ctx, writes } = makeCommandCtx({ argv: [
      '--id', 'pred-1',
      '--description', 'ETH > 3500',
      '--spec-file', tmpFile,
      '--dry-run',
    ], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
    expect(parsed.plan[0]).toMatchObject({ id: 'pred-1' });
    expect(parsed.plan[0].spec?.kind).toBe('prediction.v0');
  });

  it('--spec-file with unknown spec.kind emits invalid_invocation', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'cli-submit-intent-'));
    const tmpFile = join(tmp, 'bad-kind.json');
    writeFileSync(tmpFile, JSON.stringify({
      window: { startTs: 1, endTs: 2 },
      spec: { kind: 'demo.v0', foo: 1 },
      eligibility: {},
    }));
    const cmd = createSubmitIntentCommand(makeFakeDeps());
    const { ctx, writes, exits } = makeCommandCtx({ argv: [
      '--id', 'x',
      '--description', 'y',
      '--spec-file', tmpFile,
      '--dry-run',
    ], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.message).toMatch(/unknown intent kind: demo\.v0/);
    expect(parsed.message).toMatch(/known kinds:/);
    expect(exits).toEqual([11]);
  });
});
