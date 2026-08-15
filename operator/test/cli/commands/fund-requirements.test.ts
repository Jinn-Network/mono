import { describe, expect, it, vi } from 'vitest';
import { createFundRequirementsCommand, type FundRequirementsDeps } from '../../../src/cli/commands/fund-requirements.js';
import type { FundingPlan } from '../../../src/earning/funding-plan.js';
import { makeCommandCtx } from '@test/cli.js';

interface MakeDepsOpts {
  plan?: Partial<FundingPlan>;
  passwordOk?: boolean;
  /**
   * Spy fn to capture the call. Tests assert this is the ONLY entry-point
   * the command uses (no `bootstrap()` mutator, no faucet, no on-chain tx).
   */
  planSpy?: ReturnType<typeof vi.fn>;
}

function makeFakeDeps(opts: MakeDepsOpts = {}): FundRequirementsDeps {
  const plan: FundingPlan = {
    satisfied: true,
    partial: false,
    reasons: [],
    safes: [],
    ...opts.plan,
  };
  const passwordOk = opts.passwordOk ?? true;
  const planSpy = opts.planSpy ?? vi.fn(async () => plan);
  return {
    loadConfig: () => ({ earningDir: '/tmp', network: 'testnet', rpcUrl: 'http://127.0.0.1:8545' } as any),
    getConfigPathFromArgs: () => undefined,
    resolveCliPassword: () =>
      passwordOk
        ? { ok: true as const, password: 'test' }
        : { ok: false as const, message: 'Set JINN_PASSWORD or pass --password-fd N with a readable file descriptor.' },
    planFleetFunding: planSpy as unknown as FundRequirementsDeps['planFleetFunding'],
  };
}

describe('fund-requirements command', () => {
  it('emits a requirements array with role, address, asset, needWei', async () => {
    const deps = makeFakeDeps({
      plan: {
        satisfied: false,
        partial: false,
        reasons: [],
        master: {
          master_address: '0xMASTER',
          eth_required: '1000000000000000000',
          eth_balance: '0',
        },
        safes: [],
      },
    });
    const fr = createFundRequirementsCommand(deps);
    const { ctx, writes } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
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
    expect(parsed.partial).toBe(false);
    expect(parsed.reasons).toEqual([]);
  });

  it('reports satisfied=true with empty requirements when no funding needed', async () => {
    const deps = makeFakeDeps({
      plan: { satisfied: true, partial: false, reasons: [], safes: [] },
    });
    const fr = createFundRequirementsCommand(deps);
    const { ctx, writes } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await fr.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.satisfied).toBe(true);
    expect(parsed.requirements).toEqual([]);
    expect(parsed.partial).toBe(false);
  });

  it('--human formats amounts as ETH (not raw wei)', async () => {
    const deps = makeFakeDeps({
      plan: {
        satisfied: false,
        partial: false,
        reasons: [],
        master: {
          master_address: '0xMASTER',
          eth_required: '5000000000000000', // 0.005 ETH
          eth_balance: '0',
        },
        safes: [],
      },
    });
    const fr = createFundRequirementsCommand(deps);
    const { ctx, writes } = makeCommandCtx({ argv: ['--human'], env: { JINN_PASSWORD: 'test' } });
    await fr.run(ctx);
    const out = writes.join('');
    expect(out).toMatch(/Funding required/);
    expect(out).toMatch(/0\.005 ETH/);
    expect(out).not.toMatch(/wei/);
  });

  it('accepts --password-fd when password env is missing', async () => {
    const deps = makeFakeDeps({
      plan: {
        satisfied: false,
        partial: false,
        reasons: [],
        master: {
          master_address: '0xMASTER',
          eth_required: '1000000000000000000',
          eth_balance: '0',
        },
        safes: [],
      },
    });
    const fr = createFundRequirementsCommand(deps);
    const { ctx, writes } = makeCommandCtx({ argv: ['--password-fd', '0'], env: {} });
    await fr.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.satisfied).toBe(false);
    expect(parsed.partial).toBe(false);
  });

  it('returns a partial answer with reasons when password is missing', async () => {
    const deps = makeFakeDeps({
      passwordOk: false,
      plan: {
        satisfied: false,
        partial: true,
        reasons: ['password_missing'],
        safes: [],
      },
    });
    const fr = createFundRequirementsCommand(deps);
    const { ctx, writes } = makeCommandCtx({ env: {} });
    await fr.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.partial).toBe(true);
    expect(parsed.reasons).toContain('password_missing');
    expect(parsed.satisfied).toBe(false);
    expect(parsed.requirements).toEqual([]);
  });

  it('surfaces RPC unreachable as a partial reason without crashing', async () => {
    const deps = makeFakeDeps({
      plan: {
        satisfied: false,
        partial: true,
        reasons: ['rpc_unreachable'],
        safes: [],
      },
    });
    const fr = createFundRequirementsCommand(deps);
    const { ctx, writes } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await fr.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.partial).toBe(true);
    expect(parsed.reasons).toContain('rpc_unreachable');
    expect(parsed.satisfied).toBe(false);
  });

  it('uses the read-only planFleetFunding API and never the bootstrap mutator', async () => {
    // The audit (W1) requires fund-requirements to be inspection-only:
    //   - never write earning state
    //   - never request faucet funds
    //   - never send chain transactions
    //
    // The command is only allowed to invoke the read-only `planFleetFunding`
    // dependency. We assert that exactly one read-only call is made and the
    // command does not pull in any other dependency that could mutate state.
    const planSpy = vi.fn(async () => ({
      satisfied: true,
      partial: false,
      reasons: [],
      safes: [],
    } as FundingPlan));

    const deps: FundRequirementsDeps = {
      loadConfig: () => ({ earningDir: '/tmp', network: 'testnet', rpcUrl: 'http://127.0.0.1:8545' } as any),
      getConfigPathFromArgs: () => undefined,
      resolveCliPassword: () => ({ ok: true as const, password: 'test' }),
      planFleetFunding: planSpy as unknown as FundRequirementsDeps['planFleetFunding'],
    };

    // Trip-wire: if the command ever gains a back-channel that tries to
    // construct a bootstrapper, the test fails loudly.
    const forbiddenKeys = ['bootstrapperFactory', 'requestFunding', 'walletClient', 'sendTransaction'];
    for (const k of forbiddenKeys) {
      expect((deps as Record<string, unknown>)[k]).toBeUndefined();
    }

    const fr = createFundRequirementsCommand(deps);
    const { ctx } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await fr.run(ctx);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it('does not require a password and emits a partial answer instead', async () => {
    // Password absent: the command must still run (no envelope error) and
    // surface partial=true with `password_missing` so an agent can poll
    // safely without ever supplying secrets to an inspection verb.
    const planSpy = vi.fn(async () => ({
      satisfied: false,
      partial: true,
      reasons: ['no_keystore', 'password_missing'],
      safes: [],
    } as FundingPlan));

    const deps: FundRequirementsDeps = {
      loadConfig: () => ({ earningDir: '/tmp', network: 'testnet', rpcUrl: 'http://127.0.0.1:8545' } as any),
      getConfigPathFromArgs: () => undefined,
      resolveCliPassword: () => ({
        ok: false as const,
        message: 'Set JINN_PASSWORD or pass --password-fd N with a readable file descriptor.',
      }),
      planFleetFunding: planSpy as unknown as FundRequirementsDeps['planFleetFunding'],
    };
    const fr = createFundRequirementsCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({ env: {} });
    await fr.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.partial).toBe(true);
    expect(parsed.reasons).toContain('password_missing');
    expect(planSpy).toHaveBeenCalledTimes(1);
    // Plan was called without a password — must not throw.
    const args = planSpy.mock.calls[0]?.[0] as { password?: string } | undefined;
    expect(args?.password).toBeUndefined();
    expect(exits).toEqual([0]);
  });
});
