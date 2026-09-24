/**
 * B0a (#2446) — the `jinn requester init` surface.
 *
 * The persona rule under test: nothing a requester reads on their first-touch
 * verb sends them to the operator daemon or the operator bootstrap.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequesterCommand, PRODUCTION_DEPS, type RequesterCommandDeps } from '../../../src/cli/commands/requester.js';
import requesterCommand from '../../../src/cli/commands/requester.js';
import { CLI_COMMANDS } from '../../../src/cli/index.js';
import { FleetBootstrapper } from '../../../src/earning/bootstrap.js';
import { createDefaultFleetState } from '../../../src/earning/types.js';
import type { FleetBootstrapResult } from '../../../src/earning/types.js';
import { resolveCliPassword } from '../../../src/cli/password.js';
import type { RpcNetworkPreflightResult } from '../../../src/preflight/rpc-network.js';
import { makeCommandCtx } from '@test/cli.js';

function okRpc(): RpcNetworkPreflightResult {
  return {
    ok: true,
    network: 'testnet',
    expectedChainId: 84532,
    actualChainId: 84532,
    rpcHost: '127.0.0.1',
  };
}

function makeDeps(
  result: FleetBootstrapResult,
  spy?: ReturnType<typeof vi.fn>,
  overrides: Partial<RequesterCommandDeps> = {},
): RequesterCommandDeps {
  return {
    loadConfig: () => ({
      earningDir: '/tmp/jinn-requester',
      network: 'testnet',
      rpcUrl: 'http://127.0.0.1:8545',
    } as never),
    getConfigPathFromArgs: () => undefined,
    resolveCliPassword: () => ({ ok: true as const, password: 'test' }),
    checkRpcNetwork: async () => okRpc(),
    rpcNetworkFailureHint: () => 'Point JINN_RPC_URL at the right chain.',
    logRpcLocalDevToStderr: () => {},
    checkDaemonGuard: () => ({
      blocked: false as const,
      pid: null,
      pidfilePath: '/tmp/jinn-requester/daemon.pid',
      reason: 'not-running' as const,
    }),
    ensureRequesterSafe: (spy ?? vi.fn(async () => result)) as RequesterCommandDeps['ensureRequesterSafe'],
    ...overrides,
  };
}

function readyState(): FleetBootstrapResult {
  const fleet = createDefaultFleetState('base-sepolia');
  return {
    ok: true,
    message: 'Creator Safe ready at 0xSAFE.',
    fleet_state: {
      ...fleet,
      master_address: '0xMASTER',
      fleet_safe_address: '0xSAFE',
      requester_stage: 'safe_deployed',
    },
  };
}

describe('jinn requester init', () => {
  const stateDirs: string[] = [];

  afterEach(() => {
    for (const dir of stateDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is registered as a public verb', () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toContain('requester');
  });

  it('reports the wallet and the creator Safe on success', async () => {
    const cmd = createRequesterCommand(makeDeps(readyState()));
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['init'], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const payload = JSON.parse(writes.at(-1)!);
    expect(payload.master).toBe('0xMASTER');
    expect(payload.creatorSafe).toBe('0xSAFE');
    expect(payload.chain).toBe('base-sepolia');
    expect(exits).toEqual([]);
  });

  it('exits funding_required naming the requester shortfall and what it blocks', async () => {
    const fleet = createDefaultFleetState('base-sepolia');
    const cmd = createRequesterCommand(makeDeps({
      ok: false,
      message: 'Your wallet needs 0.0015 ETH more to deploy your creator Safe.',
      fleet_state: { ...fleet, master_address: '0xMASTER' },
      funding: { master_address: '0xMASTER', eth_required: '1500000000000000', eth_balance: '0' },
    }));
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['init'], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const envelope = JSON.parse(writes.at(-1)!);
    expect(envelope.code).toBe('funding_required');
    expect(envelope.details).toMatchObject({
      address: '0xMASTER',
      needWei: '1500000000000000',
      blocks: 'tasks-submit',
    });
    expect(exits).toEqual([10]);
  });

  it('refuses an unknown subcommand', async () => {
    const cmd = createRequesterCommand(makeDeps(readyState()));
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['bootstrap'], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    expect(JSON.parse(writes.at(-1)!).code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  // D0a P3 (#525/#562/#897): this verb broadcasts from the same agent EOA a
  // running daemon signs with, and it persists the Safe address it deploys.
  // Both refusals must land *before* any chain write is attempted.
  it('refuses to broadcast while a jinn daemon is running, without calling the bootstrapper', async () => {
    const ensure = vi.fn(async () => readyState());
    const cmd = createRequesterCommand(makeDeps(readyState(), ensure, {
      checkDaemonGuard: () => ({
        blocked: true as const,
        pid: 4321,
        pidfilePath: '/tmp/jinn-requester/daemon.pid',
        reason: 'alive' as const,
      }),
    }));
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['init'], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const envelope = JSON.parse(writes.at(-1)!);
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.details).toMatchObject({ field: 'daemon_pidfile', pid: 4321, reason: 'alive' });
    expect(ensure).not.toHaveBeenCalled();
    expect(exits).toEqual([11]);
  });

  it('refuses on an RPC chain-id mismatch, without calling the bootstrapper', async () => {
    const ensure = vi.fn(async () => readyState());
    const cmd = createRequesterCommand(makeDeps(readyState(), ensure, {
      checkRpcNetwork: async (): Promise<RpcNetworkPreflightResult> => ({
        ok: false,
        message: 'RPC chain id 8453 does not match the configured testnet (84532).',
        network: 'testnet',
        expectedChainId: 84532,
        actualChainId: 8453,
        rpcHost: 'mainnet.base.org',
        reason: 'chain_mismatch',
      }),
    }));
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['init'], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const envelope = JSON.parse(writes.at(-1)!);
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.details).toMatchObject({
      field: 'rpcUrl',
      expectedChainId: 84532,
      actualChainId: 8453,
      reason: 'chain_mismatch',
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(exits).toEqual([11]);
  });

  it('never routes the requester at the operator daemon or bootstrap', async () => {
    // The whole surface: help text plus every envelope this verb can emit on
    // the paths a first-touch requester actually hits.
    const surfaces: string[] = [requesterCommand.helpText, requesterCommand.summary];

    for (const argv of [['init'], ['bootstrap']]) {
      const fleet = createDefaultFleetState('base-sepolia');
      // The real resolver against a genuinely empty state dir -- no
      // JINN_PASSWORD, no --password-fd, no pre-existing keystore-password
      // file -- is the actual first-touch refusal a requester with nothing
      // set up yet sees. A stubbed resolver can't catch `resolveCliPassword`
      // routing this refusal at `jinn run` (its shared "or run `jinn run` to
      // auto-generate one" branch), which this verb must never repeat.
      const emptyStateDir = mkdtempSync(join(tmpdir(), 'jinn-requester-nopass-'));
      stateDirs.push(emptyStateDir);
      const cmd = createRequesterCommand({
        ...makeDeps({
          ok: false,
          message: 'Your wallet needs more ETH to deploy your creator Safe.',
          fleet_state: { ...fleet, master_address: '0xMASTER' },
          funding: { master_address: '0xMASTER', eth_required: '1500000000000000', eth_balance: '0' },
        }),
        resolveCliPassword,
      });
      const { ctx, writes } = makeCommandCtx({ argv, env: { JINN_STATE_DIR: emptyStateDir } });
      await cmd.run(ctx);
      surfaces.push(writes.join(''));

      const funded = createRequesterCommand(makeDeps({
        ok: false,
        message: 'Your wallet needs more ETH to deploy your creator Safe.',
        fleet_state: { ...fleet, master_address: '0xMASTER' },
        funding: { master_address: '0xMASTER', eth_required: '1500000000000000', eth_balance: '0' },
      }));
      const second = makeCommandCtx({ argv, env: { JINN_PASSWORD: 'test' } });
      await funded.run(second.ctx);
      surfaces.push(second.writes.join(''));
    }

    for (const surface of surfaces) {
      expect(surface).not.toContain('jinn run');
      expect(surface).not.toContain('jinn bootstrap');
    }
  });

  // Round-3 finding (#4271, non-blocking note): every test above injects
  // `ensureRequesterSafe` through `RequesterCommandDeps`, so nothing exercises
  // `PRODUCTION_DEPS` itself. Swapping the production wiring for
  // `FleetBootstrapper.ensureStage1` (the operator's full Stage 1 walk --
  // service registration, staking, mech) would leave all other tests in this
  // file green, because they never touch `PRODUCTION_DEPS`. Pin it directly:
  // the requester's own bootstrapper method must be the one that runs.
  it('production wiring calls FleetBootstrapper.ensureRequesterSafe, not ensureStage1', async () => {
    const fleet = createDefaultFleetState('base-sepolia');
    const ensureRequesterSafeSpy = vi
      .spyOn(FleetBootstrapper.prototype, 'ensureRequesterSafe')
      .mockResolvedValue({
        ok: true,
        message: 'Creator Safe ready at 0xSAFE.',
        fleet_state: { ...fleet, master_address: '0xMASTER', fleet_safe_address: '0xSAFE' },
      });
    const ensureStage1Spy = vi.spyOn(FleetBootstrapper.prototype, 'ensureStage1');

    try {
      const result = await PRODUCTION_DEPS.ensureRequesterSafe({
        earningDir: '/tmp/jinn-requester-production-wiring',
        chain: 'base-sepolia',
        rpcUrl: 'http://127.0.0.1:8545',
        password: 'test',
      });

      expect(result.ok).toBe(true);
      expect(ensureRequesterSafeSpy).toHaveBeenCalledTimes(1);
      expect(ensureRequesterSafeSpy).toHaveBeenCalledWith('test');
      expect(ensureStage1Spy).not.toHaveBeenCalled();
    } finally {
      ensureRequesterSafeSpy.mockRestore();
      ensureStage1Spy.mockRestore();
    }
  });
});
