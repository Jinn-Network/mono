import { describe, expect, it } from 'vitest';
import { createLogsCommand } from '@/cli/commands/logs.js';
import { runCommand } from '@test/cli.js';
import type { ActivityEventRow } from '@/store/store.js';

const eventRows: ActivityEventRow[] = [
  {
    id: 1,
    ts: '2026-04-14T12:00:00.000Z',
    kind: 'delivered',
    requestId: 'req_2',
    serviceIndex: null,
    txHash: null,
    solverType: null,
    outcome: 'ok',
    detail: null,
  },
  {
    id: 2,
    ts: '2026-04-14T11:00:00.000Z',
    kind: 'created',
    requestId: 'req_1',
    serviceIndex: null,
    txHash: null,
    solverType: null,
    outcome: 'ok',
    detail: null,
  },
];

function makeFakeStore(rows: ActivityEventRow[]) {
  return {
    getRecentActivityEvents: (limit: number) =>
      rows.slice(0, limit).sort((a, b) => a.id - b.id),
    getActivityEventsAfterId: () => [] as ActivityEventRow[],
  } as any;
}

const fakeConfig = {
  network: 'testnet' as const,
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
  tasks: [],
  stakingMode: 'standard' as const,
  targetServices: 1,
  debug: false,
} as any;

const fakeDeps = {
  loadConfig: () => fakeConfig,
  getConfigPathFromArgs: () => undefined,
  storeFactory: (_path: string) => makeFakeStore(eventRows),
};

describe('logs command', () => {
  it('emits a single JSON envelope with an events array', async () => {
    const cmd = createLogsCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as {
      schemaVersion: number;
      events: Array<{ ts: string; level: string; component: string; msg: string }>;
      cursor: { next: string | null };
    };
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
    const cmd = createLogsCommand(fakeDeps);
    const { envelopes } = await runCommand(cmd, { argv: ['--limit', '1'] });
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as { events: unknown[] };
    expect(parsed.events).toHaveLength(1);
  });

  it('emits an empty envelope when the store has no activity', async () => {
    const emptyDeps = {
      ...fakeDeps,
      storeFactory: (_path: string) => makeFakeStore([]),
    };
    const cmd = createLogsCommand(emptyDeps);
    const { envelopes } = await runCommand(cmd);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as {
      schemaVersion: number;
      events: unknown[];
      cursor: { next: string | null };
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.events).toEqual([]);
    expect(parsed.cursor).toEqual({ next: null });
  });
});
