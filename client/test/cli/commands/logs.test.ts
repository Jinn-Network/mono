import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/store/store.js', () => ({
  Store: class {
    constructor(_path: string) {}
    getRecentOwnActivity(limit: number) {
      const all = [
        { requestId: 'req_1', role: 'created' },
        { requestId: 'req_2', role: 'delivered' },
      ];
      return all.slice(0, limit);
    }
    close() {}
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
  it('writes one JSON object per line', async () => {
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
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(w);
      expect(parsed.ts).toBeDefined();
      expect(parsed.level).toBeDefined();
      expect(parsed.component).toBeDefined();
      expect(parsed.msg).toBeDefined();
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
  });
});
