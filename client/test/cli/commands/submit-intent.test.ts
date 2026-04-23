import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';

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

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => mockRaw),
}));

function makeCtx(argv: string[], tty = false): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: tty,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

describe('submit-intent command', () => {
  it('--dry-run emits a plan without executing', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes } = makeCtx([
      '--id',
      'test-1',
      '--description',
      'The service is healthy',
      '--dry-run',
    ]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
    expect(parsed.plan[0]).toMatchObject({ id: 'test-1' });
  });

  it('non-TTY without --yes or --dry-run emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes, exits } = makeCtx(['--id', 'test-1', '--description', 'The service is healthy']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('accepts --config and --password-fd on --dry-run (parse path)', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes } = makeCtx([
      '--id',
      'test-1',
      '--description',
      'The service is healthy',
      '--dry-run',
      '--config',
      '/nonexistent-config-path.json',
      '--password-fd',
      '9',
    ]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
  });

  it('missing --id emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes, exits } = makeCtx(['--dry-run', '--description', 'x']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--id');
    expect(exits).toEqual([11]);
  });

  it('--dry-run emits bootstrap_incomplete when no service is at step=complete', async () => {
    vi.resetModules();
    vi.doMock('../../../src/cli/introspection-context.js', () => ({
      gatherIntrospectionRaw: vi.fn(async () => ({
        ...mockRaw,
        fleet: { ...mockRaw.fleet!, services: [] },
      })),
    }));
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes, exits } = makeCtx([
      '--id',
      'test-1',
      '--description',
      'x',
      '--dry-run',
    ]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('bootstrap_incomplete');
    expect(parsed.exitCode).toBe(20);
    expect(exits).toEqual([20]);
    vi.doUnmock('../../../src/cli/introspection-context.js');
  });

  it('accepts --spec-file with a prediction.v0 intent', async () => {
    vi.resetModules();
    vi.doMock('../../../src/cli/introspection-context.js', () => ({
      gatherIntrospectionRaw: vi.fn(async () => mockRaw),
    }));
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
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes } = makeCtx([
      '--id', 'pred-1',
      '--description', 'ETH > 3500',
      '--spec-file', tmpFile,
      '--dry-run',
    ]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
    expect(parsed.plan[0]).toMatchObject({ id: 'pred-1' });
    expect(parsed.plan[0].spec?.kind).toBe('prediction.v0');
    vi.doUnmock('../../../src/cli/introspection-context.js');
  });

  it('--spec-file with unknown spec.kind emits invalid_invocation', async () => {
    vi.resetModules();
    vi.doMock('../../../src/cli/introspection-context.js', () => ({
      gatherIntrospectionRaw: vi.fn(async () => mockRaw),
    }));
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
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes, exits } = makeCtx([
      '--id', 'x',
      '--description', 'y',
      '--spec-file', tmpFile,
      '--dry-run',
    ]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.message).toMatch(/unknown intent kind: demo\.v0/);
    expect(parsed.message).toMatch(/known kinds:/);
    expect(exits).toEqual([11]);
    vi.doUnmock('../../../src/cli/introspection-context.js');
  });
});
