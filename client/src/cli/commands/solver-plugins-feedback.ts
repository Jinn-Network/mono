/**
 * `jinn solver-plugins {endorse, warn, review, respond}` — write verbs that
 * route ERC-8004 `ReputationRegistry` feedback writes against the agentId of
 * the builder who published the plug-in. The builder's agentId is resolved
 * from `DiscoveryAPI.listPluginPublications`; the on-chain body anchors the
 * feedback to a specific plug-in via `manifestRef = "plugin:<cid>"` and
 * `manifestHash = keccak256(manifestRef)`.
 *
 * The pipeline mirrors `publishHandler`'s shape:
 *   1. resolveCliPassword (env > keystore-password file > prompt-fd)
 *   2. loadConfig
 *   3. discoveryApiFactory(config).listPluginPublications → builderAgentId
 *   4. bootstrapper.ensureStage1(password) — lazy Stage 1 ensure
 *   5. reputationClientFactory(...).giveFeedback(...) / .respondToFeedback(...)
 *
 * Outputs a single-line JSON envelope: `{ verb, txHash, pluginCid,
 * targetAgentId, ... }`. Error codes match the publish surface convention:
 * `keystore_missing`, `config_load_failed`, `ensure_stage1_failed`,
 * `fleet_identity_missing`, `agentid_unresolvable`, `self_feedback_not_allowed`,
 * `discovery_unavailable`, `publish_failed`.
 */

import { getAddress, keccak256, toBytes, type Address, type Hex } from 'viem';
import type { CommandContext } from '../command.js';
import { writeJson, writeDaemonGuardBlocked } from './solver-plugins.js';
import type { SolverPluginsDeps } from './solver-plugins.js';
import { getReputationRegistryAddress } from '../../erc8004/addresses.js';
import { DiscoveryUnavailableError } from '../../discovery/types.js';
import { DaemonGuardBlockedError } from '../daemon-guard.js';

// ── Shared option shapes ────────────────────────────────────────────────────

export interface EndorseOptions {
  pluginCid: string;
  score: number;
  scoreDecimals: number;
  tag1?: string;
  tag2?: string;
  configPath: string | undefined;
}

export interface WarnOptions {
  pluginCid: string;
  reason: string;
  configPath: string | undefined;
}

export interface ReviewOptions {
  pluginCid: string;
  score: number;
  scoreDecimals: number;
  tag1?: string;
  tag2?: string;
  configPath: string | undefined;
}

export interface RespondOptions {
  pluginCid: string;
  feedbackIndex: bigint;
  client: Address;
  responseUri: string;
  configPath: string | undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export interface FeedbackPipelineCtx {
  password: string;
  config: ReturnType<SolverPluginsDeps['loadConfig']>;
  builderAgentId: bigint;
  safeAddress: Address;
  reputationRegistryAddress: Address;
  manifestRef: string;
  manifestHash: Hex;
}

/**
 * Shared prologue for every write verb (endorse / warn / review / respond /
 * block): password → config → discovery row → Stage 1 ensure. Returns the
 * materialised ids needed for the on-chain write, or null after writing an
 * error envelope and calling ctx.exit.
 */
export async function preparePipeline(
  ctx: CommandContext,
  pluginCid: string,
  configPath: string | undefined,
  deps: SolverPluginsDeps,
): Promise<FeedbackPipelineCtx | null> {
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
    return null;
  }
  const password = passwordResult.password;

  let config: ReturnType<typeof deps.loadConfig>;
  try {
    config = deps.loadConfig(configPath);
  } catch (err) {
    writeJson(ctx, {
      error: { code: 'config_load_failed', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
    return null;
  }

  // Resolve builderAgentId via discovery first — cheaper to fail here than
  // after Stage 1.
  let builderAgentIdStr: string | undefined;
  try {
    const api = deps.discoveryApiFactory(config);
    const rows = await api.listPluginPublications({});
    const row = rows.find((r) => r.cid === pluginCid);
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
      return null;
    }
    throw err;
  }
  if (!builderAgentIdStr) {
    writeJson(ctx, {
      error: {
        code: 'agentid_unresolvable',
        message: `No plug-in publication record found for cid ${pluginCid} (discovery mode=${config.discovery?.mode ?? 'onchain'}).`,
        details: { mode: config.discovery?.mode ?? 'onchain' },
      },
    });
    ctx.exit(1);
    return null;
  }

  const bootstrapper = deps.bootstrapperFactory(config);
  const stage1 = await bootstrapper.ensureStage1(password);
  if (!stage1.ok) {
    writeJson(ctx, { error: { code: 'ensure_stage1_failed', message: stage1.message } });
    ctx.exit(1);
    return null;
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
    return null;
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
    return null;
  }

  const safeAddress = getAddress(fleet.fleet_safe_address) as Address;
  const manifestRef = `plugin:${pluginCid}`;
  const manifestHash = keccak256(toBytes(manifestRef));

  return {
    password,
    config,
    builderAgentId: BigInt(builderAgentIdStr),
    safeAddress,
    reputationRegistryAddress,
    manifestRef,
    manifestHash,
  };
}

function emitWriteError(ctx: CommandContext, err: unknown): void {
  if (err instanceof DaemonGuardBlockedError) {
    writeDaemonGuardBlocked(ctx, err);
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Self-feedback not allowed')) {
    writeJson(ctx, {
      error: {
        code: 'self_feedback_not_allowed',
        message:
          'Reputation registry rejected feedback: caller is the agent owner. Use a different operator agent NFT, or skip endorsement for plug-ins you publish yourself.',
      },
    });
    ctx.exit(1);
    return;
  }
  writeJson(ctx, {
    error: { code: 'publish_failed', message: msg },
  });
  ctx.exit(1);
}

// ── Verbs ────────────────────────────────────────────────────────────────────

/**
 * Shared body for any verb that submits a single `giveFeedback` after the
 * preparePipeline prologue. The caller supplies the verb name (for the
 * envelope) plus the on-chain args; this function emits the success envelope
 * or maps the thrown error to a typed envelope.
 */
async function submitFeedbackAndEmit(
  ctx: CommandContext,
  prep: FeedbackPipelineCtx,
  deps: SolverPluginsDeps,
  verb: string,
  args: {
    score: number;
    scoreDecimals: number;
    tag1?: string;
    tag2?: string;
  },
  extraEnvelopeFields: Record<string, unknown> = {},
): Promise<void> {
  const client = deps.reputationClientFactory({
    reputationRegistryAddress: prep.reputationRegistryAddress,
    safeAddress: prep.safeAddress,
    rpcUrl: prep.config.rpcUrl,
    network: prep.config.network === 'testnet' ? 'base-sepolia' : 'base',
    earningDir: prep.config.earningDir,
    password: prep.password,
  });
  try {
    const txHash = await client.giveFeedback({
      harnessAgentId: prep.builderAgentId,
      score: args.score,
      scoreDecimals: args.scoreDecimals,
      manifestRef: prep.manifestRef,
      manifestHash: prep.manifestHash,
      ...(args.tag1 ? { tag1: args.tag1 } : {}),
      ...(args.tag2 ? { tag2: args.tag2 } : {}),
    });
    writeJson(ctx, {
      verb,
      txHash,
      pluginCid: prep.manifestRef.slice('plugin:'.length),
      targetAgentId: prep.builderAgentId.toString(),
      score: args.score,
      scoreDecimals: args.scoreDecimals,
      reputationRegistry: prep.reputationRegistryAddress,
      safeAddress: prep.safeAddress,
      ...extraEnvelopeFields,
    });
  } catch (err) {
    emitWriteError(ctx, err);
  }
}

export async function warnHandler(
  ctx: CommandContext,
  opts: WarnOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const prep = await preparePipeline(ctx, opts.pluginCid, opts.configPath, deps);
  if (!prep) return;
  // The on-chain feedback layout exposes `tag1` (indexed; we use it as the
  // verb's category — 'warning') and `tag2` (free-text). The design note
  // referenced a "feedback URI" for the reason, but tag2 is the available
  // free-text slot on giveFeedback — wire the reason there.
  await submitFeedbackAndEmit(
    ctx,
    prep,
    deps,
    'solver-plugins warn',
    { score: 50, scoreDecimals: 2, tag1: 'warning', tag2: opts.reason },
    { reason: opts.reason },
  );
}

export async function endorseHandler(
  ctx: CommandContext,
  opts: EndorseOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const prep = await preparePipeline(ctx, opts.pluginCid, opts.configPath, deps);
  if (!prep) return;
  await submitFeedbackAndEmit(
    ctx,
    prep,
    deps,
    'solver-plugins endorse',
    {
      score: opts.score,
      scoreDecimals: opts.scoreDecimals,
      ...(opts.tag1 ? { tag1: opts.tag1 } : {}),
      ...(opts.tag2 ? { tag2: opts.tag2 } : {}),
    },
  );
}

export async function reviewHandler(
  ctx: CommandContext,
  opts: ReviewOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const prep = await preparePipeline(ctx, opts.pluginCid, opts.configPath, deps);
  if (!prep) return;
  await submitFeedbackAndEmit(
    ctx,
    prep,
    deps,
    'solver-plugins review',
    {
      score: opts.score,
      scoreDecimals: opts.scoreDecimals,
      ...(opts.tag1 ? { tag1: opts.tag1 } : {}),
      ...(opts.tag2 ? { tag2: opts.tag2 } : {}),
    },
  );
}

export async function respondHandler(
  ctx: CommandContext,
  opts: RespondOptions,
  deps: SolverPluginsDeps,
): Promise<void> {
  const prep = await preparePipeline(ctx, opts.pluginCid, opts.configPath, deps);
  if (!prep) return;
  const client = deps.reputationClientFactory({
    reputationRegistryAddress: prep.reputationRegistryAddress,
    safeAddress: prep.safeAddress,
    rpcUrl: prep.config.rpcUrl,
    network: prep.config.network === 'testnet' ? 'base-sepolia' : 'base',
    earningDir: prep.config.earningDir,
    password: prep.password,
  });
  try {
    const responseHash = keccak256(toBytes(opts.responseUri));
    const txHash = await client.respondToFeedback({
      feedbackId: {
        agentId: prep.builderAgentId,
        client: opts.client,
        feedbackIndex: opts.feedbackIndex,
      },
      responseURI: opts.responseUri,
      responseHash,
    });
    writeJson(ctx, {
      verb: 'solver-plugins respond',
      txHash,
      pluginCid: opts.pluginCid,
      targetAgentId: prep.builderAgentId.toString(),
      feedbackIndex: opts.feedbackIndex.toString(),
      client: opts.client,
      responseURI: opts.responseUri,
      reputationRegistry: prep.reputationRegistryAddress,
      safeAddress: prep.safeAddress,
    });
  } catch (err) {
    emitWriteError(ctx, err);
  }
}
