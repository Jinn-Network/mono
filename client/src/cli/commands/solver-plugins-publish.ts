/**
 * `jinn solver-plugins publish <source>` — builder action.
 *
 * BUILDER ACTION, NOT AN OPERATOR ACTION. Routes through the Stage 1
 * identity Safe (`fleet_safe_address`), lazily completing Stage 1 if
 * needed. Never touches Stage 2 (OLAS service / staking). A user with
 * `fleet_stage === 'none'` and zero ETH on their master EOA will be
 * surfaced an `ensure_stage1_failed` envelope with the funding hint;
 * funding the EOA and re-running is the expected resolution.
 *
 * Pipeline:
 *   1. resolveCliPassword (env > keystore-password file > prompt-fd)
 *   2. resolveSolverPlugin(source) → loaded plug-in metadata + sha256
 *   3. pack tarball into a temp dir, capturing pluginSha256
 *   4. bootstrapper.ensureStage1(password) — lazy; no-op if already stage1+
 *   5. pinFileToIpfs(registry, tarballPath) → pluginCid
 *   6. PluginRegistryPublisher.publish({ pluginCid, payload }) → txHash
 *
 * Outputs a single-line JSON envelope:
 *   { verb: 'solver-plugins publish', txHash, pluginCid, pluginSha256,
 *     builderAgentId, identityRegistry, safeAddress }
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getAddress, type Address } from 'viem';
import type { CommandContext } from '../command.js';
import {
  digestDirectory,
  resolveSolverPlugin,
} from '../../plugins/index.js';
import type { PluginPayload } from '../../erc8004/plugin-registry.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import { writeJson, writeDaemonGuardBlocked } from './solver-plugins.js';
import { DaemonGuardBlockedError } from '../daemon-guard.js';

export interface PublishOptions {
  source: string;
  configPath: string | undefined;
  builderAgentIdOverride: bigint | undefined;
  reasonUnused?: never;
}

export async function publishHandler(
  ctx: CommandContext,
  opts: PublishOptions,
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

  let config: ReturnType<typeof deps.loadConfig>;
  try {
    config = deps.loadConfig(opts.configPath);
  } catch (err) {
    writeJson(ctx, {
      error: {
        code: 'config_load_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
    return;
  }

  // 1. Resolve plug-in.
  let loaded: Awaited<ReturnType<typeof resolveSolverPlugin>>;
  try {
    loaded = await resolveSolverPlugin(opts.source);
  } catch (err) {
    writeJson(ctx, {
      error: {
        code: 'invalid_solver_plugin',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
    return;
  }

  // 2. Pack tarball into temp dir; recompute sha256 of the live source tree.
  const packDir = mkdtempSync(join(tmpdir(), 'jinn-publish-pack-'));
  let tarballPath: string;
  let pluginSha256Hex: string;
  try {
    pluginSha256Hex = digestDirectory(loaded.root);
    tarballPath = join(packDir, `${loaded.manifest.name.replace(/[@/]/g, '_')}-${loaded.manifest.version}.tgz`);
    const tar = spawnSync(
      'tar',
      ['-czf', tarballPath, '-C', dirname(loaded.root), basename(loaded.root)],
      { encoding: 'utf8' },
    );
    if (tar.status !== 0) {
      throw new Error(tar.stderr || `tar exited ${tar.status}`);
    }
  } catch (err) {
    rmSync(packDir, { recursive: true, force: true });
    writeJson(ctx, {
      error: {
        code: 'pack_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
    return;
  }

  try {
    // 3. Lazy Stage 1 ensure.
    const bootstrapper = deps.bootstrapperFactory(config);
    const stage1 = await bootstrapper.ensureStage1(password);
    if (!stage1.ok) {
      writeJson(ctx, {
        error: { code: 'ensure_stage1_failed', message: stage1.message },
      });
      ctx.exit(1);
      return;
    }
    const fleet = stage1.fleet_state;
    if (!fleet.fleet_agent_id || !fleet.fleet_safe_address || !fleet.fleet_identity_registry) {
      writeJson(ctx, {
        error: {
          code: 'fleet_identity_missing',
          message:
            'Stage 1 completed but fleet identity is empty. Re-run `jinn solver-plugins publish` after the next stage1 cycle.',
        },
      });
      ctx.exit(1);
      return;
    }

    const builderAgentId =
      opts.builderAgentIdOverride ?? BigInt(fleet.fleet_agent_id);
    const safeAddress = getAddress(fleet.fleet_safe_address) as Address;
    const identityRegistry = getAddress(fleet.fleet_identity_registry) as Address;

    // 4. Pin tarball.
    const pluginCid = await deps.pinFileToIpfs(
      config.ipfsRegistryUrl ?? 'https://registry.autonolas.tech',
      tarballPath,
    );

    // 5. Publish setMetadata via Safe.
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

    const payload: PluginPayload = {
      version: 1,
      pluginName: loaded.manifest.name,
      pluginVersion: loaded.manifest.version,
      pluginSha256: ('0x' + pluginSha256Hex) as `0x${string}`,
      supports: loaded.manifest.jinn.supports,
      publishedAt: Math.floor(deps.now() / 1000),
    };

    const txHash = await publisher.publish({ pluginCid, payload });

    writeJson(ctx, {
      verb: 'solver-plugins publish',
      txHash,
      pluginCid,
      pluginSha256: payload.pluginSha256,
      builderAgentId: builderAgentId.toString(),
      identityRegistry,
      safeAddress,
      pluginName: loaded.manifest.name,
      pluginVersion: loaded.manifest.version,
      supports: loaded.manifest.jinn.supports,
      publishedAt: payload.publishedAt,
    });
  } catch (err) {
    if (err instanceof DaemonGuardBlockedError) {
      writeDaemonGuardBlocked(ctx, err);
      return;
    }
    writeJson(ctx, {
      error: {
        code: 'publish_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}
