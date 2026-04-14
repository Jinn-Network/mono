import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/earning/bootstrap.js', () => ({
  FleetBootstrapper: class {
    async bootstrap() {
      return {
        ok: false,
        funding: { master_address: '0xabc', eth_required: '1000', eth_balance: '500' },
        message: 'need more eth',
        fleet_state: { master_address: '0xabc', services: [] },
      };
    }
  },
}));

function makeCtx(env: Record<string, string> = { JINN_PASSWORD: 'test' }): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('bootstrap command', () => {
  it('emits funding_required envelope and exits 10 when bootstrap returns funding', async () => {
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx();
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('funding_required');
    expect(parsed.exitCode).toBe(10);
    expect(exits).toEqual([10]);
  });

  it('emits invalid_invocation exit 11 when JINN_PASSWORD is missing', async () => {
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx({});
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(parsed.details?.field).toBe('JINN_PASSWORD');
  });
});
