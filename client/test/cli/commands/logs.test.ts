import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

const eventRows = [
  {
    id: 1,
    ts: '2026-04-14T12:00:00.000Z',
    kind: 'delivered' as const,
    requestId: 'req_2' as const,
    serviceIndex: null as const,
    txHash: null as const,
    specKind: null as const,
    outcome: 'ok' as const,
    detail: null as const,
  },
  {
    id: 2,
    ts: '2026-04-14T11:00:00.000Z',
    kind: 'created' as const,
    requestId: 'req_1' as const,
    serviceIndex: null as const,
    txHash: null as const,
    specKind: null as const,
    outcome: 'ok' as const,
    detail: null as const,
  },
];

vi.mock('../../../src/store/store.js', () => ({
  Store: class {
    constructor(_path: string) {}
    getRecentActivityEvents = (limit: number) => eventRows.slice(0, limit).sort((a, b) => a.id - b.id);
    getActivityEventsAfterId = () => [] as never[];
  },
}));

vi.mock('../../../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/config.js')>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        network: 'testnet',
        rpcUrl: 'https://sepolia.base.org',
        earningDir: '/tmp/e',
        dbPath: ':memory:',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        apiPort: 7331,
        claudePath: 'claude',
        claudeModel: 'x',
        peers: [],
        ipfsRegistryUrl: 'https://registry.autonolas.tech',
        ipfsGatewayUrl: 'https://gateway.autonolas.tech',
        desiredStates: [],
        stakingMode: 'standard',
        targetServices: 1,
        debug: false,
      }) as ReturnType<typeof actual.loadConfig>,
  };
});

describe('logs command', () => {
  it('emits a single JSON envelope with an events array', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/logs.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: {},
    };
    await cmd.run(ctx);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.cursor).toEqual({ next: null });
    for (const ev of parsed.events) {
      expect(ev.ts).toBeDefined();
      expect(ev.level).toBeDefined();
      expect(ev.component).toBeDefined();
      expect(ev.msg).toBeDefined();
    }
  });

  it('respects --limit', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/logs.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['--limit', '1'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: {},
    };
    await cmd.run(ctx);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.events).toHaveLength(1);
  });

  it('emits an empty envelope when the store has no activity', async () => {
    vi.resetModules();
    vi.doMock('../../../src/store/store.js', () => ({
      Store: class {
        constructor(_path: string) {}
        getRecentActivityEvents() { return []; }
        getActivityEventsAfterId() { return []; }
      },
    }));
    const { default: cmd } = await import('../../../src/cli/commands/logs.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: {},
    };
    await cmd.run(ctx);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.events).toEqual([]);
    expect(parsed.cursor).toEqual({ next: null });
    vi.doUnmock('../../../src/store/store.js');
  });
});
