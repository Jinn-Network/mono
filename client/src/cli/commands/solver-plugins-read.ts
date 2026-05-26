/**
 * `jinn solver-plugins {list-feedback, discover, status}` — read verbs.
 *
 * None of the read verbs resolve the keystore password. They use the same
 * `discoveryApiFactory` the daemon uses, plus a read-only
 * `ReputationRegistryClient` (`password: undefined` → `walletClient`
 * unbuilt → reads work, writes throw).
 *
 * Output envelopes mirror the write-verb convention (`verb` field +
 * structured payload). Failure modes:
 *   - `agentid_unresolvable` (list-feedback only — `status` reports
 *     `{ status: 'not_published' }` instead, since "no record" is the
 *     answer to a status read).
 *   - `discovery_unavailable` (factory throws `DiscoveryUnavailableError`).
 *   - `config_load_failed`.
 */

import type { Address } from 'viem';
import type { CommandContext } from '../command.js';
import { writeJson } from './solver-plugins.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import { getReputationRegistryAddress } from '../../erc8004/addresses.js';
import { DiscoveryUnavailableError } from '../../discovery/types.js';

export interface ListFeedbackOptions {
  pluginCid: string;
  client: Address | undefined;
  includeRevoked: boolean;
  configPath: string | undefined;
}

function emitDiscoveryUnavailable(
  ctx: CommandContext,
  config: ReturnType<SolverPluginsDeps['loadConfig']>,
  err: DiscoveryUnavailableError,
): void {
  writeJson(ctx, {
    error: {
      code: 'discovery_unavailable',
      message: `Indexer unavailable (mode=${config.discovery?.mode ?? 'onchain'}${config.discovery?.url ? `, url=${config.discovery.url}` : ''}): ${err.message}`,
      details: {
        mode: config.discovery?.mode ?? 'onchain',
        ...(config.discovery?.url ? { url: config.discovery.url } : {}),
      },
    },
  });
  ctx.exit(1);
}

export async function listFeedbackHandler(
  ctx: CommandContext,
  opts: ListFeedbackOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
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

  // Resolve agentId via discovery.
  let builderAgentIdStr: string | undefined;
  try {
    const api = deps.discoveryApiFactory(config);
    const rows = await api.listPluginPublications({});
    const row = rows.find((r) => r.cid === opts.pluginCid);
    builderAgentIdStr = row?.builderAgentId;
  } catch (err) {
    if (err instanceof DiscoveryUnavailableError) {
      emitDiscoveryUnavailable(ctx, config, err);
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

  // Read-only client — no Safe needed (Safe routing is for writes).
  const client = deps.reputationClientFactory({
    reputationRegistryAddress,
    safeAddress: undefined,
    rpcUrl: config.rpcUrl,
    network: config.network === 'testnet' ? 'base-sepolia' : 'base',
    earningDir: config.earningDir,
    password: undefined,
  });

  const builderAgentId = BigInt(builderAgentIdStr);
  const records = await client.readAllFeedback(builderAgentId, {
    ...(opts.client ? { clientAddresses: [opts.client] } : {}),
    includeRevoked: opts.includeRevoked,
  });

  // Marshal BigInts to strings for JSON-safe output.
  const serialised = records.map((r) => ({
    agentId: r.agentId.toString(),
    client: r.client,
    feedbackIndex: r.feedbackIndex.toString(),
    score: r.score.toString(),
    scoreDecimals: r.scoreDecimals,
    tag1: r.tag1,
    tag2: r.tag2,
    revoked: r.revoked,
  }));

  writeJson(ctx, {
    verb: 'solver-plugins list-feedback',
    pluginCid: opts.pluginCid,
    targetAgentId: builderAgentIdStr,
    records: serialised,
  });
}
