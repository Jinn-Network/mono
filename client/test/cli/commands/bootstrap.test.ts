import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

const bootstrapReturn = vi.hoisted(() => ({
  val: {
    ok: false as boolean,
    funding: {
      master_address: '0xabc',
      eth_required: '1000',
      eth_balance: '500',
    },
    message: 'need more eth',
    fleet_state: { master_address: '0xabc', services: [] as Array<{ index: number; step: string; service_id?: number }> },
  },
}));

vi.mock('../../../src/earning/bootstrap.js', () => ({
  FleetBootstrapper: class {
    async bootstrap() {
      return { ...bootstrapReturn.val };
    }
  },
}));

function makeCtx(
  env: Record<string, string> = { JINN_PASSWORD: 'test' },
  opts: { stdoutIsTty?: boolean; argv?: string[] } = {},
): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: opts.argv ?? [],
    stdoutIsTty: opts.stdoutIsTty ?? false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('bootstrap command', () => {
  it('emits funding_required envelope and exits 10 when bootstrap returns funding', async () => {
    bootstrapReturn.val = {
      ok: false,
      funding: {
        master_address: '0xabc',
        eth_required: '1000',
        eth_balance: '500',
      },
      message: 'need more eth',
      fleet_state: { master_address: '0xabc', services: [] },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx();
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('funding_required');
    expect(parsed.exitCode).toBe(10);
    expect(parsed.details).toEqual({
      role: 'master',
      address: '0xabc',
      asset: 'native',
      needWei: '1000',
      haveWei: '500',
    });
    expect(exits).toEqual([10]);
  });

  it('emits invalid_invocation exit 11 when password env is missing', async () => {
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx({});
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(parsed.details?.field).toBe('keystore password');
    expect(exits).toEqual([11]);
  });

  it('emits JSON success on non-TTY even without --json', async () => {
    bootstrapReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: {
        master_address: '0xmaster',
        services: [{ index: 0, step: 'complete', service_id: 7 }],
      },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx();
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.master).toBe('0xmaster');
    expect(parsed.services).toEqual([{ index: 0, step: 'complete', serviceId: 7 }]);
    expect(exits).toEqual([0]);
  });

  it('emits human success summary on TTY without --json', async () => {
    bootstrapReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: {
        master_address: '0xmaster',
        services: [{ index: 0, step: 'complete', service_id: 7 }],
      },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx(undefined, { stdoutIsTty: true });
    await bootstrap.run(ctx);
    const out = writes[writes.length - 1];
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('Bootstrap complete.');
    expect(out).toContain('0xmaster');
    expect(exits).toEqual([0]);
  });

  it('emits JSON success on TTY when --json is set', async () => {
    bootstrapReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: {
        master_address: '0xaaa',
        services: [],
      },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx(undefined, { stdoutIsTty: true, argv: ['--json'] });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.master).toBe('0xaaa');
    expect(exits).toEqual([0]);
  });
});
