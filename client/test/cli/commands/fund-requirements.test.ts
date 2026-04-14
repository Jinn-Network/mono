import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

const fundReturn = vi.hoisted(() => ({
  val: {
    ok: false as boolean,
    funding: {
      master_address: '0xMASTER',
      eth_required: '1000000000000000000',
      eth_balance: '0',
    },
    message: 'need eth',
    fleet_state: {
      master_address: '0xMASTER',
      services: [] as Array<{ index: number; step: string; service_id?: number }>,
    },
  },
}));

vi.mock('../../../src/earning/bootstrap.js', () => ({
  FleetBootstrapper: class {
    async bootstrap() {
      return { ...fundReturn.val };
    }
  },
}));

function makeCtx(env: Record<string, string> = { JINN_PASSWORD: 'test' }): {
  ctx: CommandContext;
  writes: string[];
} {
  const writes: string[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: () => {
      /* unused */
    },
    env,
  };
  return { ctx, writes };
}

describe('fund-requirements command', () => {
  it('emits a requirements array with role, address, asset, needWei', async () => {
    fundReturn.val = {
      ok: false,
      funding: {
        master_address: '0xMASTER',
        eth_required: '1000000000000000000',
        eth_balance: '0',
      },
      message: 'need eth',
      fleet_state: { master_address: '0xMASTER', services: [] },
    };
    const { default: fr } = await import('../../../src/cli/commands/fund-requirements.js');
    const { ctx, writes } = makeCtx();
    await fr.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.requirements)).toBe(true);
    expect(parsed.requirements[0]).toMatchObject({
      role: 'master',
      address: '0xMASTER',
      asset: 'native',
      needWei: '1000000000000000000',
      haveWei: '0',
    });
    expect(parsed.satisfied).toBe(false);
  });

  it('reports satisfied=true with empty requirements when no funding needed', async () => {
    fundReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: { master_address: '0xM', services: [] },
    };
    const { default: fr } = await import('../../../src/cli/commands/fund-requirements.js');
    const { ctx, writes } = makeCtx();
    await fr.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.satisfied).toBe(true);
    expect(parsed.requirements).toEqual([]);
  });
});
