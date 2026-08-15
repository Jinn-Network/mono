/**
 * `jinn solver-plugins revoke <pluginCid> --reason <text>` — builder action.
 *
 * Overwrites `plugin:<pluginCid>` with a `version=2, revoked=true, reason` payload.
 * Same Safe-routed write path as `publish`; same lazy `ensureStage1` gate.
 */

import { getAddress, type Address } from 'viem';
import type { CommandContext } from '../command.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import { writeJson, writeDaemonGuardBlocked } from './solver-plugins.js';
import { DaemonGuardBlockedError } from '../daemon-guard.js';
import type { RevocationPayload } from '../../erc8004/plugin-registry.js';

export interface RevokeOptions {
  pluginCid: string;
  reason: string;
  configPath: string | undefined;
  builderAgentIdOverride: bigint | undefined;
}

export async function revokeHandler(
  ctx: CommandContext,
  opts: RevokeOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const passwordResult = deps.resolveCliPassword(ctx.argv, ctx.env);
  if (!passwordResult.ok) {
    writeJson(ctx, {
      error: {
        code: 'keystore_missing',
        message:
          'Could not resolve password. Set JINN_PASSWORD, write ~/.jinn-client/keystore-password, or pass --password-fd.',
      },
    });
    ctx.exit(1);
    return;
  }
  const password = passwordResult.password;

  let config;
  try {
    config = deps.loadConfig(opts.configPath);
  } catch (err) {
    writeJson(ctx, {
      error: { code: 'config_load_failed', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
    return;
  }

  try {
    const bootstrapper = deps.bootstrapperFactory(config);
    const stage1 = await bootstrapper.ensureStage1(password);
    if (!stage1.ok) {
      writeJson(ctx, { error: { code: 'ensure_stage1_failed', message: stage1.message } });
      ctx.exit(1);
      return;
    }
    const fleet = stage1.fleet_state;
    if (!fleet.fleet_agent_id || !fleet.fleet_safe_address || !fleet.fleet_identity_registry) {
      writeJson(ctx, {
        error: {
          code: 'fleet_identity_missing',
          message: 'Stage 1 completed but fleet identity is empty.',
        },
      });
      ctx.exit(1);
      return;
    }

    const builderAgentId =
      opts.builderAgentIdOverride ?? BigInt(fleet.fleet_agent_id);
    const safeAddress = getAddress(fleet.fleet_safe_address) as Address;
    const identityRegistry = getAddress(fleet.fleet_identity_registry) as Address;

    // The factory builds viem clients internally in production; tests mock the whole factory.
    const publisher = deps.publisherFactory({
      identityRegistryAddress: identityRegistry,
      builderAgentId,
      safeAddress,
      rpcUrl: config.rpcUrl,
      network: config.network === 'testnet' ? 'base-sepolia' : 'base',
      earningDir: config.earningDir,
      password,
    });

    const payload: RevocationPayload = {
      version: 2,
      revoked: true,
      reason: opts.reason,
    };

    const txHash = await publisher.revoke({ pluginCid: opts.pluginCid, payload });

    writeJson(ctx, {
      verb: 'solver-plugins revoke',
      txHash,
      pluginCid: opts.pluginCid,
      reason: opts.reason,
      builderAgentId: builderAgentId.toString(),
      identityRegistry,
      safeAddress,
    });
  } catch (err) {
    if (err instanceof DaemonGuardBlockedError) {
      writeDaemonGuardBlocked(ctx, err);
      return;
    }
    writeJson(ctx, {
      error: {
        code: 'revoke_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
  }
}
