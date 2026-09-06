/**
 * B0a (#2446) — the `jinn requester init` surface.
 *
 * The persona rule under test: nothing a requester reads on their first-touch
 * verb sends them to the operator daemon or the operator bootstrap.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequesterCommand, type RequesterCommandDeps } from '../../../src/cli/commands/requester.js';
import requesterCommand from '../../../src/cli/commands/requester.js';
import { CLI_COMMANDS } from '../../../src/cli/index.js';
import { createDefaultFleetState } from '../../../src/earning/types.js';
import type { FleetBootstrapResult } from '../../../src/earning/types.js';
import { makeCommandCtx } from '@test/cli.js';

function makeDeps(
  result: FleetBootstrapResult,
  spy?: ReturnType<typeof vi.fn>,
): RequesterCommandDeps {
  return {
    loadConfig: () => ({
      earningDir: '/tmp/jinn-requester',
      network: 'testnet',
      rpcUrl: 'http://127.0.0.1:8545',
    } as never),
    getConfigPathFromArgs: () => undefined,
    resolveCliPassword: () => ({ ok: true as const, password: 'test' }),
    ensureRequesterSafe: (spy ?? vi.fn(async () => result)) as RequesterCommandDeps['ensureRequesterSafe'],
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

  it('never routes the requester at the operator daemon or bootstrap', async () => {
    // The whole surface: help text plus every envelope this verb can emit on
    // the paths a first-touch requester actually hits.
    const surfaces: string[] = [requesterCommand.helpText, requesterCommand.summary];

    for (const argv of [['init'], ['bootstrap']]) {
      const fleet = createDefaultFleetState('base-sepolia');
      const cmd = createRequesterCommand({
        ...makeDeps({
          ok: false,
          message: 'Your wallet needs more ETH to deploy your creator Safe.',
          fleet_state: { ...fleet, master_address: '0xMASTER' },
          funding: { master_address: '0xMASTER', eth_required: '1500000000000000', eth_balance: '0' },
        }),
        resolveCliPassword: () => ({ ok: false as const, message: 'Set JINN_PASSWORD.' }),
      });
      const { ctx, writes } = makeCommandCtx({ argv });
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
});
