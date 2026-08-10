/**
 * `jinn solver-plugins {list-feedback, discover, status}` — read verbs.
 *
 * None of the read verbs resolve the keystore password. They read published
 * plug-in records through the neutral `PluginPublicationReader`
 * (`deps.pluginReaderFactory`, on-chain over the IdentityRegistry), plus a
 * read-only `ReputationRegistryClient` (`password: undefined` → `walletClient`
 * unbuilt → reads work, writes throw).
 *
 * Output envelopes mirror the write-verb convention (`verb` field +
 * structured payload). Failure modes:
 *   - `agentid_unresolvable` (list-feedback only — `status` reports
 *     `{ status: 'not_published' }` instead, since "no record" is the
 *     answer to a status read).
 *   - `discovery_unavailable` (reader throws `PluginPublicationUnavailableError`).
 *   - `config_load_failed`.
 */

import type { Address } from 'viem';
import type { CommandContext } from '../command.js';
import { writeJson } from './solver-plugins.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import { getReputationRegistryAddress } from '../../erc8004/addresses.js';
import {
  PluginPublicationUnavailableError,
  type PluginPublication,
} from '../../plugin-registry/publication-reader.js';

export interface StatusOptions {
  pluginCid: string;
  configPath: string | undefined;
}

export interface DiscoverOptions {
  solverType: string | undefined;
  builderAgentId: string | undefined;
  includeRevoked: boolean | undefined;
  limit: number | undefined;
  configPath: string | undefined;
}

export interface ListFeedbackOptions {
  pluginCid: string;
  client: Address | undefined;
  includeRevoked: boolean;
  configPath: string | undefined;
}

type LoadedConfig = ReturnType<SolverPluginsDeps['loadConfig']>;

/**
 * Load the operator config, emitting a `config_load_failed` envelope and
 * exiting on failure. Returns `null` only after `ctx.exit` has been called.
 */
function loadConfigOrEmit(
  ctx: CommandContext,
  configPath: string | undefined,
  deps: SolverPluginsDeps,
): LoadedConfig | null {
  try {
    return deps.loadConfig(configPath);
  } catch (err) {
    writeJson(ctx, {
      error: { code: 'config_load_failed', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
    return null;
  }
}

function emitDiscoveryUnavailable(
  ctx: CommandContext,
  config: LoadedConfig,
  err: PluginPublicationUnavailableError,
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

/**
 * `discover` lists published plug-in rows directly from the indexer. The
 * `PluginPublication` row already carries name/version/supports/builderAgentId,
 * so no IPFS payload dereference is required — `ipfsFetch` is held on
 * SolverPluginsDeps for symmetry / future use but this handler does not
 * consume it (a plan refinement vs. the design note's "missing IPFS config"
 * failure mode; that mode does not apply because the discovery row is
 * self-describing).
 */
export async function discoverHandler(
  ctx: CommandContext,
  opts: DiscoverOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const config = loadConfigOrEmit(ctx, opts.configPath, deps);
  if (!config) return;

  try {
    const api = deps.pluginReaderFactory(config);
    const plugins = await api.listPluginPublications({
      ...(opts.solverType ? { solverType: opts.solverType } : {}),
      ...(opts.builderAgentId ? { builderAgentId: opts.builderAgentId } : {}),
      ...(opts.includeRevoked !== undefined ? { includeRevoked: opts.includeRevoked } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });

    writeJson(ctx, {
      verb: 'solver-plugins discover',
      plugins: plugins.map((p) => ({
        cid: p.cid,
        builderAgentId: p.builderAgentId,
        name: p.name,
        version: p.version,
        supports: p.supports,
        publishedAt: p.publishedAt,
        revoked: p.revoked,
        ...(p.revokedReason ? { revokedReason: p.revokedReason } : {}),
        pluginSha256: p.pluginSha256,
      })),
    });
  } catch (err) {
    if (err instanceof PluginPublicationUnavailableError) {
      emitDiscoveryUnavailable(ctx, config, err);
      return;
    }
    throw err;
  }
}

/**
 * `status` composes the publication row (or the absence of one) with the
 * read-only `ReputationRegistry.getSummary` and the operator-local
 * `solverPlugins.blockedCids` flag. A missing publication is a valid answer
 * (`{ status: 'not_published' }`, exit 0), not an error.
 */
export async function statusHandler(
  ctx: CommandContext,
  opts: StatusOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const config = loadConfigOrEmit(ctx, opts.configPath, deps);
  if (!config) return;

  const locallyBlocked = config.solverPlugins?.blockedCids?.includes(opts.pluginCid) ?? false;

  let row: PluginPublication | undefined;
  try {
    const api = deps.pluginReaderFactory(config);
    const rows = await api.listPluginPublications({});
    row = rows.find((r) => r.cid === opts.pluginCid);
  } catch (err) {
    if (err instanceof PluginPublicationUnavailableError) {
      emitDiscoveryUnavailable(ctx, config, err);
      return;
    }
    throw err;
  }

  if (!row) {
    writeJson(ctx, {
      verb: 'solver-plugins status',
      pluginCid: opts.pluginCid,
      status: 'not_published',
      locallyBlocked,
    });
    return;
  }

  if (row.revoked) {
    writeJson(ctx, {
      verb: 'solver-plugins status',
      pluginCid: opts.pluginCid,
      status: 'revoked',
      publication: {
        cid: row.cid,
        builderAgentId: row.builderAgentId,
        name: row.name,
        version: row.version,
        supports: row.supports,
        publishedAt: row.publishedAt,
        pluginSha256: row.pluginSha256,
      },
      ...(row.revokedReason ? { revokedReason: row.revokedReason } : {}),
      locallyBlocked,
    });
    return;
  }

  // Active publication: also try to summarise reputation. Empty client list →
  // no summary (getSummary reverts on empty input by design).
  const chainId = config.network === 'testnet' ? 84532 : 8453;
  const reputationRegistryAddress = getReputationRegistryAddress(chainId);
  let summarySerialised: { count: string; summaryValue: string; summaryValueDecimals: number } | null = null;
  if (reputationRegistryAddress) {
    const client = deps.reputationClientFactory({
      reputationRegistryAddress,
      safeAddress: undefined,
      rpcUrl: config.rpcUrl,
      network: config.network === 'testnet' ? 'base-sepolia' : 'base',
      earningDir: config.earningDir,
      password: undefined,
    });
    const builderAgentId = BigInt(row.builderAgentId);
    const clients = await client.getClients(builderAgentId);
    if (clients.length > 0) {
      const summary = await client.getSummary(builderAgentId, { clientAddresses: clients });
      summarySerialised = {
        count: summary.count.toString(),
        summaryValue: summary.summaryValue.toString(),
        summaryValueDecimals: summary.summaryValueDecimals,
      };
    }
  }

  writeJson(ctx, {
    verb: 'solver-plugins status',
    pluginCid: opts.pluginCid,
    status: 'published',
    publication: {
      cid: row.cid,
      builderAgentId: row.builderAgentId,
      name: row.name,
      version: row.version,
      supports: row.supports,
      publishedAt: row.publishedAt,
      pluginSha256: row.pluginSha256,
    },
    summary: summarySerialised,
    locallyBlocked,
  });
}

export async function listFeedbackHandler(
  ctx: CommandContext,
  opts: ListFeedbackOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const config = loadConfigOrEmit(ctx, opts.configPath, deps);
  if (!config) return;

  let builderAgentIdStr: string | undefined;
  try {
    const api = deps.pluginReaderFactory(config);
    const rows = await api.listPluginPublications({});
    builderAgentIdStr = rows.find((r) => r.cid === opts.pluginCid)?.builderAgentId;
  } catch (err) {
    if (err instanceof PluginPublicationUnavailableError) {
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
