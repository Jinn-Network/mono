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
 * The password / config / discovery / Stage 1 prologue is the same one the
 * other write verbs use — see `preparePipeline` in
 * `solver-plugins-feedback.ts`.
 */

import type { Hex } from 'viem';
import type { CommandContext } from '../command.js';
import { writeJson } from './solver-plugins.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import { preparePipeline } from './solver-plugins-feedback.js';
import { DEFAULT_CONFIG_PATH } from '../../config.js';

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
  const prep = await preparePipeline(ctx, opts.pluginCid, opts.configPath, deps);
  if (!prep) return;

  // Step (a): attempt the network publish. Capture either the txHash or the
  // error; never throw out of this block — the local write must run
  // unconditionally.
  let networkTxHash: Hex | undefined;
  let networkError: Error | undefined;
  const client = deps.reputationClientFactory({
    reputationRegistryAddress: prep.reputationRegistryAddress,
    safeAddress: prep.safeAddress,
    rpcUrl: prep.config.rpcUrl,
    network: prep.config.network === 'testnet' ? 'base-sepolia' : 'base',
    earningDir: prep.config.earningDir,
    password: prep.password,
  });
  try {
    networkTxHash = await client.giveFeedback({
      harnessAgentId: prep.builderAgentId,
      score: 0,
      scoreDecimals: 2,
      manifestRef: prep.manifestRef,
      manifestHash: prep.manifestHash,
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
      targetAgentId: prep.builderAgentId.toString(),
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
    targetAgentId: prep.builderAgentId.toString(),
    reason: opts.reason,
    reputationRegistry: prep.reputationRegistryAddress,
    safeAddress: prep.safeAddress,
  });
}
