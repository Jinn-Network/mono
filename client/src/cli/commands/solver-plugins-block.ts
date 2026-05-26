/**
 * `jinn solver-plugins block <pluginCid> --reason <text>` — dual-effect verb.
 *
 * Network half: submits a `score=0` `giveFeedback({ tag1: 'block', tag2:
 * reason })` against the builder's agentId, mirroring `warnHandler` /
 * `endorseHandler`.
 *
 * Local half: appends `pluginCid` to `cfg.solverPlugins.blockedCids` and
 * writes the operator config file. The daemon reads this list at startup and
 * refuses to load matching plug-ins.
 *
 * Failure-mode policy (see spec/2026-05-26-117-design.md "Failure modes"):
 *   - Network publish fails → emit `{ blockedLocal: true, pluginCid,
 *     networkPublishError: { code: 'blocked_locally_only', message } }`,
 *     exit 0. The local refusal succeeded.
 *   - Network publish succeeds AND local write succeeds → emit
 *     `{ blockedLocal: true, txHash, pluginCid }`, exit 0.
 *   - Local write fails → emit `{ error: { code: 'config_write_failed' } }`,
 *     exit 1. This overrides any earlier network outcome (the operator's
 *     intent did not land on disk).
 *
 * Password resolution and Stage 1 ensure happen first so a daemon without
 * keystore credentials surfaces `keystore_missing` before touching either
 * the network or the config file.
 */

import { keccak256, toBytes, getAddress, type Address, type Hex } from 'viem';
import type { CommandContext } from '../command.js';
import { writeJson } from './solver-plugins.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import { getReputationRegistryAddress } from '../../erc8004/addresses.js';
import { DiscoveryUnavailableError } from '../../discovery/types.js';
import {
  DEFAULT_CONFIG_PATH,
} from '../../config.js';

export interface BlockOptions {
  pluginCid: string;
  reason: string;
  configPath: string | undefined;
}

export async function blockHandler(
  ctx: CommandContext,
  opts: BlockOptions,
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
      error: { code: 'config_load_failed', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
    return;
  }

  // Resolve builder agentId via discovery.
  let builderAgentIdStr: string | undefined;
  try {
    const api = deps.discoveryApiFactory(config);
    const rows = await api.listPluginPublications({});
    const row = rows.find((r) => r.cid === opts.pluginCid);
    builderAgentIdStr = row?.builderAgentId;
  } catch (err) {
    if (err instanceof DiscoveryUnavailableError) {
      writeJson(ctx, {
        error: {
          code: 'discovery_unavailable',
          message: `Indexer unavailable (mode=${config.discovery?.mode ?? 'onchain'}${config.discovery?.url ? `, url=${config.discovery.url}` : ''}): ${err.message}`,
        },
      });
      ctx.exit(1);
      return;
    }
    throw err;
  }
  if (!builderAgentIdStr) {
    writeJson(ctx, {
      error: {
        code: 'agentid_unresolvable',
        message: `No plug-in publication record found for cid ${opts.pluginCid} (discovery mode=${config.discovery?.mode ?? 'onchain'}).`,
        details: { mode: config.discovery?.mode ?? 'onchain' },
      },
    });
    ctx.exit(1);
    return;
  }

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

  const chainId = config.network === 'testnet' ? 84532 : 8453;
  const reputationRegistryAddress = getReputationRegistryAddress(chainId);
  if (!reputationRegistryAddress) {
    writeJson(ctx, {
      error: {
        code: 'config_load_failed',
        message: `No ReputationRegistry address known for chainId ${chainId}.`,
      },
    });
    ctx.exit(1);
    return;
  }

  const safeAddress = getAddress(fleet.fleet_safe_address) as Address;
  const manifestRef = `plugin:${opts.pluginCid}`;
  const manifestHash: Hex = keccak256(toBytes(manifestRef));

  // Step (a): attempt the network publish. Capture either the txHash or the
  // error; never throw out of this block — the local write must run
  // unconditionally.
  let networkTxHash: Hex | undefined;
  let networkError: Error | undefined;
  const client = deps.reputationClientFactory({
    reputationRegistryAddress,
    safeAddress,
    rpcUrl: config.rpcUrl,
    network: config.network === 'testnet' ? 'base-sepolia' : 'base',
    earningDir: config.earningDir,
    password,
  });
  try {
    networkTxHash = await client.giveFeedback({
      harnessAgentId: BigInt(builderAgentIdStr),
      score: 0,
      scoreDecimals: 2,
      manifestRef,
      manifestHash,
      tag1: 'block',
      tag2: opts.reason,
    });
  } catch (err) {
    networkError = err instanceof Error ? err : new Error(String(err));
  }

  // Step (b): unconditional local config update. A failure here is fatal —
  // overrides any earlier network outcome.
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  try {
    const onDisk = deps.readConfigFile(configPath);
    const existingBlock =
      typeof onDisk['solverPlugins'] === 'object' && onDisk['solverPlugins'] !== null
        ? (onDisk['solverPlugins'] as Record<string, unknown>)
        : {};
    const existingList = Array.isArray(existingBlock['blockedCids'])
      ? (existingBlock['blockedCids'] as string[]).filter((s) => typeof s === 'string')
      : [];
    if (!existingList.includes(opts.pluginCid)) {
      existingList.push(opts.pluginCid);
    }
    const nextConfig = {
      ...onDisk,
      solverPlugins: {
        ...existingBlock,
        blockedCids: existingList,
      },
    };
    deps.writeConfigFile(configPath, nextConfig);
  } catch (err) {
    writeJson(ctx, {
      error: {
        code: 'config_write_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
    return;
  }

  if (networkError) {
    writeJson(ctx, {
      verb: 'solver-plugins block',
      blockedLocal: true,
      pluginCid: opts.pluginCid,
      targetAgentId: builderAgentIdStr,
      reason: opts.reason,
      networkPublishError: {
        code: 'blocked_locally_only',
        message: networkError.message,
      },
    });
    return;
  }

  writeJson(ctx, {
    verb: 'solver-plugins block',
    blockedLocal: true,
    txHash: networkTxHash,
    pluginCid: opts.pluginCid,
    targetAgentId: builderAgentIdStr,
    reason: opts.reason,
    reputationRegistry: reputationRegistryAddress,
    safeAddress,
  });
}
