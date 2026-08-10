/**
 * `jinn solver-plugins {show, validate, pack, publish, revoke}`.
 *
 * `show`, `validate`, `pack` are author/curator tooling (zero chain writes).
 * `publish` and `revoke` are BUILDER actions that write `plugin:<cid>`
 * records on the ERC-8004 IdentityRegistry via the fleet's Stage 1 identity
 * Safe. The publish/revoke verbs lazily complete Stage 1 (`FleetBootstrapper.ensureStage1`)
 * before any chain write — no separate `jinn builder init` step.
 *
 * Per `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md`
 * §6.3.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Address } from 'viem';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import {
  digestDirectory,
  loadSolverPluginManifest,
  resolveSolverPlugin,
} from '../../plugins/index.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import { PluginRegistryPublisher } from '../../erc8004/plugin-registry.js';
import { createDirectSafeBroadcaster } from '../../adapters/mech/direct-safe-broadcaster.js';
import { pinFileToIpfs as defaultPinFileToIpfs } from '../../adapters/mech/ipfs-pinfile.js';
import { fetchFromIpfs as defaultFetchFromIpfs } from '../../adapters/mech/ipfs.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import { createJinnPublicClient, createJinnWalletClient, type JinnOnchainNetwork } from '../../earning/viem-clients.js';
import { walletPrivateKeyAtIndex, decryptMnemonic } from '../../earning/wallet.js';
import { FleetStateStore } from '../../earning/store.js';
import { privateKeyToAccount } from 'viem/accounts';
import { checkDaemonGuard, daemonGuardEnvelope, DaemonGuardBlockedError } from '../daemon-guard.js';
import { EXIT_CODES } from '../../errors/envelope.js';
import { publishHandler } from './solver-plugins-publish.js';
import { revokeHandler } from './solver-plugins-revoke.js';
import { endorseHandler, warnHandler, reviewHandler, respondHandler } from './solver-plugins-feedback.js';
import { blockHandler } from './solver-plugins-block.js';
import { listFeedbackHandler, discoverHandler, statusHandler } from './solver-plugins-read.js';
import { getAddress } from 'viem';
import { ReputationRegistryClient } from '../../erc8004/reputation.js';
import { getIdentityRegistryAddress } from '../../erc8004/addresses.js';
import type { PluginPublicationReader } from '../../plugin-registry/publication-reader.js';
import {
  createPluginPublicationReader,
  createRpcPluginLogSource,
} from '../../plugin-registry/publication-host.js';

export function writeJson(ctx: CommandContext, value: unknown): void {
  ctx.writer.write(JSON.stringify(value) + '\n');
}

function localRoot(target: string): string {
  const stripped = target.startsWith('file:') || target.startsWith('path:')
    ? target.slice(target.indexOf(':') + 1)
    : target;
  return isAbsolute(stripped) ? stripped : resolve(process.cwd(), stripped);
}

/**
 * Args passed to `publisherFactory`.
 *
 * Extends PluginRegistryPublisherConfig with the production-only fields needed
 * to create real viem clients. The production factory reads `rpcUrl`, `network`,
 * `earningDir`, and `password` to decrypt the agent mnemonic and build a
 * WalletClient; the `publicClient` / `walletClient` fields are kept in the
 * interface so tests that pass pre-built (or null) clients still compile.
 */
export interface PublisherFactoryArgs {
  identityRegistryAddress: Address;
  builderAgentId: bigint;
  safeAddress: Address;
  rpcUrl: string;
  network: JinnOnchainNetwork;
  earningDir: string;
  password: string;
}

/**
 * Args passed to `reputationClientFactory`.
 *
 * When `password === undefined`, the factory builds a read-only client: reads
 * work, writes throw the canonical `walletClient required` error from
 * `ReputationRegistryClient`. The read-only path is what `list-feedback`,
 * `status`, and (indirectly) `discover` consume — none of them require a
 * keystore password.
 */
export interface ReputationClientFactoryArgs {
  reputationRegistryAddress: Address;
  safeAddress: Address | undefined;
  rpcUrl: string;
  network: JinnOnchainNetwork;
  earningDir: string;
  password: string | undefined;
}

export type ReputationClientHandle = Pick<
  ReputationRegistryClient,
  | 'giveFeedback'
  | 'respondToFeedback'
  | 'revokeFeedback'
  | 'readAllFeedback'
  | 'getSummary'
  | 'getClients'
>;

/**
 * Filesystem shim consumed by `block`'s local-config write. Held on the deps
 * bag so tests can inject read/write failure modes without monkey-patching
 * `fs`. Production wires the real fs-backed implementations.
 */
export interface ConfigFileIo {
  readConfigFile: (configPath: string) => Record<string, unknown>;
  writeConfigFile: (configPath: string, value: Record<string, unknown>) => void;
}

export interface SolverPluginsDeps extends BaseCommandDeps {
  bootstrapperFactory: (cfg: ReturnType<typeof defaultLoadConfig>) => Pick<FleetBootstrapper, 'ensureStage1'>;
  pinFileToIpfs: typeof defaultPinFileToIpfs;
  publisherFactory: (
    args: PublisherFactoryArgs,
  ) => {
    publish: PluginRegistryPublisher['publish'];
    revoke: PluginRegistryPublisher['revoke'];
  };
  reputationClientFactory: (args: ReputationClientFactoryArgs) => ReputationClientHandle;
  /**
   * Reads published plug-in records for the `discover` / `status` /
   * `list-feedback` verbs. One-swap R3 (#2461): narrowed from the legacy
   * `DiscoveryAPI` to the neutral `PluginPublicationReader` port so the read
   * verbs no longer depend on `discovery/` (deleted in the D-wave). The
   * production factory reads them on-chain from the IdentityRegistry.
   */
  pluginReaderFactory: (cfg: ReturnType<typeof defaultLoadConfig>) => PluginPublicationReader;
  ipfsFetch: typeof defaultFetchFromIpfs;
  readConfigFile: ConfigFileIo['readConfigFile'];
  writeConfigFile: ConfigFileIo['writeConfigFile'];
  resolveCliPassword: typeof defaultResolveCliPassword;
  now: () => number;
}

/**
 * D0a P3 (#525/#562/#897): refuse a solver-plugins write when a live jinn
 * daemon is detected for this earning directory -- see `../daemon-guard.js`.
 * Throws `DaemonGuardBlockedError` (D0a round-1 review) rather than a plain
 * `Error`, so each write handler's top-level catch (see
 * `solver-plugins-publish.ts`, `solver-plugins-revoke.ts`,
 * `solver-plugins-feedback.ts`) can special-case it via
 * `writeDaemonGuardBlocked` and preserve the full envelope (pid, pidfile
 * path, opt-out hint) instead of collapsing it into a generic `*_failed`
 * message.
 */
function assertNoLiveDaemon(earningDir: string): void {
  const guard = checkDaemonGuard({ earningDir });
  if (guard.blocked) {
    throw new DaemonGuardBlockedError(daemonGuardEnvelope(guard, 'jinn solver-plugins publish <source>'));
  }
}

/**
 * Re-emit a caught `DaemonGuardBlockedError`'s full envelope (D0a round-1 review) instead of
 * losing its pid / pidfile path / opt-out hint to a generic `*_failed` message wrap. Callers
 * check `err instanceof DaemonGuardBlockedError` before falling back to their own mapping.
 */
export function writeDaemonGuardBlocked(ctx: CommandContext, err: DaemonGuardBlockedError): void {
  const { envelope } = err;
  writeJson(ctx, {
    error: {
      code: envelope.code,
      message: envelope.message,
      ...(envelope.hint !== undefined ? { hint: envelope.hint } : {}),
      ...(envelope.exampleCli !== undefined ? { exampleCli: envelope.exampleCli } : {}),
      ...(envelope.details !== undefined ? { details: envelope.details } : {}),
    },
  });
  ctx.exit(EXIT_CODES[envelope.code]);
}

export const PRODUCTION_DEPS: SolverPluginsDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  bootstrapperFactory: (config) =>
    new FleetBootstrapper({
      earningDir: config.earningDir,
      chain: config.network === 'testnet' ? 'base-sepolia' : 'base',
      rpcUrl: config.rpcUrl,
      stakingMode: config.stakingMode,
    }),
  pinFileToIpfs: defaultPinFileToIpfs,
  publisherFactory: (args) => {
    // Lazily create viem clients from config fields so the production path
    // never passes null clients to PluginRegistryPublisher.
    // Tests mock this entire factory function and never reach this code.
    const pubClient = createJinnPublicClient(args.rpcUrl, args.network);
    const store = new FleetStateStore(args.earningDir);
    // Decrypt mnemonic asynchronously and return a publisher that defers
    // actual chain writes until publish()/revoke() is called.
    // We wrap with a lazy proxy to keep the factory synchronous.
    let walClientPromise: Promise<ReturnType<typeof createJinnWalletClient>> | undefined;
    const getWalletClient = async () => {
      if (!walClientPromise) {
        walClientPromise = (async () => {
          // D0a P3 (#525/#562/#897): `publish`/`revoke` sign via
          // `createDirectSafeBroadcaster` below with this same agent EOA a
          // running daemon uses, with no cross-process lock against it.
          assertNoLiveDaemon(args.earningDir);
          const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), args.password);
          const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);
          const account = privateKeyToAccount(agentKey);
          return createJinnWalletClient(args.rpcUrl, args.network, account);
        })();
      }
      return walClientPromise;
    };
    // Return an object that satisfies { publish, revoke } with lazy wallet init.
    // Both methods share a single PluginRegistryPublisher constructed once
    // after the wallet client resolves.
    let publisherPromise: Promise<PluginRegistryPublisher> | undefined;
    const getPublisher = async () => {
      if (!publisherPromise) {
        publisherPromise = getWalletClient().then((walClient) =>
          new PluginRegistryPublisher({
            identityRegistryAddress: args.identityRegistryAddress,
            builderAgentId: args.builderAgentId,
            safeAddress: args.safeAddress,
            publicClient: pubClient,
            walletClient: walClient,
            // Finding E16 / the C2 ruling: `jinn solver-plugins publish|revoke` is a standalone
            // one-shot process with no composition root to borrow a broadcaster from, so it
            // constructs its own — bound to the fleet identity Safe, signed by the same agent key
            // `walClient` already resolved above.
            broadcaster: createDirectSafeBroadcaster(pubClient, walClient, args.safeAddress),
          }),
        );
      }
      return publisherPromise;
    };
    const publisher = {
      async publish(pArgs: { pluginCid: string; payload: import('../../erc8004/plugin-registry.js').PluginPayload }) {
        return (await getPublisher()).publish(pArgs);
      },
      async revoke(rArgs: { pluginCid: string; payload: import('../../erc8004/plugin-registry.js').RevocationPayload }) {
        return (await getPublisher()).revoke(rArgs);
      },
    };
    return publisher;
  },
  reputationClientFactory: (args) => {
    // Lazy-mnemonic-decrypt pattern matching publisherFactory: synchronous
    // return, single shared ReputationRegistryClient built on first write
    // call. When password is undefined, build the read-only client up front
    // (no decrypt path) so reads work without a keystore.
    const pubClient = createJinnPublicClient(args.rpcUrl, args.network);
    let readOnlyClient: ReputationRegistryClient | undefined;
    let writeClientPromise: Promise<ReputationRegistryClient> | undefined;

    const getReadOnly = () => {
      if (!readOnlyClient) {
        readOnlyClient = new ReputationRegistryClient({
          reputationRegistryAddress: args.reputationRegistryAddress,
          publicClient: pubClient,
          ...(args.safeAddress ? { safeAddress: args.safeAddress } : {}),
        });
      }
      return readOnlyClient;
    };

    const getWriteClient = async () => {
      if (args.password === undefined) {
        // The read-only client's write methods throw a clean
        // 'walletClient required' error — the canonical signal for callers
        // that omitted the password.
        return getReadOnly();
      }
      if (!writeClientPromise) {
        const password = args.password;
        const store = new FleetStateStore(args.earningDir);
        writeClientPromise = (async () => {
          // D0a P3 (#525/#562/#897): writes below sign via
          // `createDirectSafeBroadcaster` (when routed through a Safe) with
          // this same agent EOA a running daemon uses, with no cross-process
          // lock against it.
          assertNoLiveDaemon(args.earningDir);
          const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
          const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);
          const account = privateKeyToAccount(agentKey);
          const walClient = createJinnWalletClient(args.rpcUrl, args.network, account);
          // Finding E16 / the C2 ruling: this write client is a standalone one-shot process's
          // own client, with no composition root to borrow a broadcaster from — construct one
          // bound to the target Safe (when routing through one) rather than hard-failing.
          const broadcaster = args.safeAddress
            ? createDirectSafeBroadcaster(pubClient, walClient, args.safeAddress)
            : undefined;
          return new ReputationRegistryClient({
            reputationRegistryAddress: args.reputationRegistryAddress,
            publicClient: pubClient,
            walletClient: walClient,
            ...(args.safeAddress ? { safeAddress: args.safeAddress } : {}),
            ...(broadcaster ? { broadcaster } : {}),
          });
        })();
      }
      return writeClientPromise;
    };

    return {
      async giveFeedback(gArgs) {
        return (await getWriteClient()).giveFeedback(gArgs);
      },
      async respondToFeedback(rArgs) {
        return (await getWriteClient()).respondToFeedback(rArgs);
      },
      async revokeFeedback(rArgs) {
        return (await getWriteClient()).revokeFeedback(rArgs);
      },
      async readAllFeedback(agentId, opts) {
        return getReadOnly().readAllFeedback(agentId, opts);
      },
      async getSummary(agentId, opts) {
        return getReadOnly().getSummary(agentId, opts);
      },
      async getClients(agentId) {
        return getReadOnly().getClients(agentId);
      },
    };
  },
  pluginReaderFactory: (cfg) => {
    const chainId = cfg.network === 'testnet' ? 84532 : 8453;
    const network: JinnOnchainNetwork = cfg.network === 'testnet' ? 'base-sepolia' : 'base';
    const identityRegistry = getIdentityRegistryAddress(chainId);
    if (!identityRegistry) {
      throw new Error(`No IdentityRegistry address known for chainId ${chainId}.`);
    }
    const publicClient = createJinnPublicClient(cfg.rpcUrl, network);
    return createPluginPublicationReader({
      logSource: createRpcPluginLogSource({ publicClient, identityRegistry, chainId }),
    });
  },
  ipfsFetch: defaultFetchFromIpfs,
  readConfigFile: (configPath) => {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  },
  writeConfigFile: (configPath, value) => {
    writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  },
  resolveCliPassword: defaultResolveCliPassword,
  now: () => Date.now(),
};

const HELP = `Usage:
  jinn solver-plugins show <source-or-path>
  jinn solver-plugins validate <source-or-path>
  jinn solver-plugins pack <path> [--out <file.tgz>]
  jinn solver-plugins publish <source-or-path> [--builder-agent-id <id>]
  jinn solver-plugins revoke <pluginCid> --reason <text> [--builder-agent-id <id>]

  jinn solver-plugins endorse <pluginCid> [--score N --score-decimals N --tag1 <s>]
  jinn solver-plugins warn <pluginCid> --reason <text>
  jinn solver-plugins block <pluginCid> --reason <text>
  jinn solver-plugins review <pluginCid> --score N [--score-decimals N --tag1 <s>]
  jinn solver-plugins respond <pluginCid> --feedback-index N --client <addr> --response-uri <uri>

  jinn solver-plugins list-feedback <pluginCid> [--client <addr>] [--include-revoked]
  jinn solver-plugins discover [--solver-type <id>] [--builder <agentId>] [--include-revoked] [--limit N]
  jinn solver-plugins status <pluginCid>

SolverPlugin show/validate/pack are author/curator tooling — zero chain writes.

publish + revoke are BUILDER actions:
  • Write \`plugin:<cid>\` metadata records on the ERC-8004 IdentityRegistry.
  • Route through the fleet's Stage 1 identity Safe (\`fleet_safe_address\`).
  • Lazily complete Stage 1 (ETH funding + Safe deploy + agent NFT mint) if needed.
  • Never touch Stage 2 (OLAS service / staking) state.

endorse / warn / block / review / respond are OPERATOR-trust write verbs:
  • Submit ERC-8004 ReputationRegistry feedback against the builder's agentId.
  • Anchor the feedback to a specific plug-in (\`manifestRef = "plugin:<cid>"\`).
  • Require JINN_PASSWORD (or --password-fd / keystore-password file) and Stage 1.
  • \`block\` additionally appends <pluginCid> to local \`solverPlugins.blockedCids\`;
    the local effect lands even when the network publish fails. The daemon
    reads the block list at startup — restart for it to take effect.

list-feedback / discover / status are READ verbs (no password required):
  • Read published plug-in records on-chain from the IdentityRegistry
    (the neutral PluginPublicationReader over the configured RPC).
  • \`list-feedback\` reads ReputationRegistry rows for the cid's builder.
  • \`discover\` lists published plug-ins, optionally filtered by SolverType.
  • \`status\` summarises publication state + reputation summary +
    local-block flag.

Attach a plug-in to a SolverNet at runtime with:
  jinn solver-nets add-plugin <solver-net> <source>
`;

export function createSolverPluginsCommand(
  deps: Partial<SolverPluginsDeps> = {},
): CommandModule {
  const resolvedDeps: SolverPluginsDeps = { ...PRODUCTION_DEPS, ...deps };
  return {
    name: 'solver-plugins',
    summary: 'Inspect, validate, pack, publish, and revoke SolverPlugin packages',
    helpText: HELP,
    async run(ctx) {
      const [subverb, ...rest] = ctx.argv;
      if (!subverb || subverb === '--help' || subverb === '-h') {
        ctx.writer.write(HELP + '\n');
        return;
      }
      if (subverb === 'show') return show(ctx, rest);
      if (subverb === 'validate') return validate(ctx, rest);
      if (subverb === 'pack') return pack(ctx, rest);
      if (subverb === 'publish') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            'builder-agent-id': { type: 'string' },
            config: { type: 'string' },
          },
        });
        const source = parsed.positionals[0];
        if (!source) {
          writeJson(ctx, {
            error: {
              code: 'invalid_invocation',
              message: 'solver-plugins publish requires <source-or-path>',
            },
          });
          ctx.exit(1);
          return;
        }
        return publishHandler(
          ctx,
          {
            source,
            configPath: parsed.values.config as string | undefined,
            builderAgentIdOverride: parsed.values['builder-agent-id']
              ? BigInt(parsed.values['builder-agent-id'] as string)
              : undefined,
          },
          resolvedDeps,
        );
      }
      if (subverb === 'revoke') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            'builder-agent-id': { type: 'string' },
            config: { type: 'string' },
            reason: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        if (!pluginCid) {
          writeJson(ctx, {
            error: {
              code: 'invalid_invocation',
              message: 'solver-plugins revoke requires <pluginCid>',
            },
          });
          ctx.exit(1);
          return;
        }
        const reason = parsed.values.reason as string | undefined;
        if (!reason) {
          writeJson(ctx, {
            error: {
              code: 'invalid_invocation',
              message: 'solver-plugins revoke requires --reason <text>',
            },
          });
          ctx.exit(1);
          return;
        }
        return revokeHandler(
          ctx,
          {
            pluginCid,
            reason,
            configPath: parsed.values.config as string | undefined,
            builderAgentIdOverride: parsed.values['builder-agent-id']
              ? BigInt(parsed.values['builder-agent-id'] as string)
              : undefined,
          },
          resolvedDeps,
        );
      }
      if (subverb === 'status') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            config: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        if (!pluginCid) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins status requires <pluginCid>' },
          });
          ctx.exit(1);
          return;
        }
        return statusHandler(
          ctx,
          { pluginCid, configPath: parsed.values.config as string | undefined },
          resolvedDeps,
        );
      }
      if (subverb === 'discover') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            'solver-type': { type: 'string' },
            builder: { type: 'string' },
            'include-revoked': { type: 'boolean' },
            limit: { type: 'string' },
            config: { type: 'string' },
          },
        });
        const limitRaw = parsed.values.limit as string | undefined;
        let limit: number | undefined;
        if (limitRaw !== undefined) {
          limit = Number.parseInt(limitRaw, 10);
          if (!Number.isFinite(limit) || limit <= 0) {
            writeJson(ctx, {
              error: { code: 'invalid_invocation', message: 'solver-plugins discover --limit must be a positive integer' },
            });
            ctx.exit(1);
            return;
          }
        }
        return discoverHandler(
          ctx,
          {
            solverType: parsed.values['solver-type'] as string | undefined,
            builderAgentId: parsed.values.builder as string | undefined,
            includeRevoked: parsed.values['include-revoked'] as boolean | undefined,
            limit,
            configPath: parsed.values.config as string | undefined,
          },
          resolvedDeps,
        );
      }
      if (subverb === 'list-feedback') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            client: { type: 'string' },
            'include-revoked': { type: 'boolean', default: false },
            config: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        if (!pluginCid) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins list-feedback requires <pluginCid>' },
          });
          ctx.exit(1);
          return;
        }
        const clientRaw = parsed.values.client as string | undefined;
        let clientAddress: Address | undefined;
        if (clientRaw) {
          try {
            clientAddress = getAddress(clientRaw);
          } catch {
            writeJson(ctx, {
              error: { code: 'invalid_invocation', message: 'solver-plugins list-feedback --client must be a valid 0x address' },
            });
            ctx.exit(1);
            return;
          }
        }
        return listFeedbackHandler(
          ctx,
          {
            pluginCid,
            client: clientAddress,
            includeRevoked: Boolean(parsed.values['include-revoked']),
            configPath: parsed.values.config as string | undefined,
          },
          resolvedDeps,
        );
      }
      if (subverb === 'block') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            reason: { type: 'string' },
            config: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        const reason = parsed.values.reason as string | undefined;
        if (!pluginCid) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins block requires <pluginCid>' },
          });
          ctx.exit(1);
          return;
        }
        if (!reason) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins block requires --reason <text>' },
          });
          ctx.exit(1);
          return;
        }
        return blockHandler(
          ctx,
          { pluginCid, reason, configPath: parsed.values.config as string | undefined },
          resolvedDeps,
        );
      }
      if (subverb === 'warn') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            reason: { type: 'string' },
            config: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        const reason = parsed.values.reason as string | undefined;
        if (!pluginCid) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins warn requires <pluginCid>' },
          });
          ctx.exit(1);
          return;
        }
        if (!reason) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins warn requires --reason <text>' },
          });
          ctx.exit(1);
          return;
        }
        return warnHandler(
          ctx,
          { pluginCid, reason, configPath: parsed.values.config as string | undefined },
          resolvedDeps,
        );
      }
      if (subverb === 'review') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            score: { type: 'string' },
            'score-decimals': { type: 'string' },
            tag1: { type: 'string' },
            tag2: { type: 'string' },
            config: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        if (!pluginCid) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins review requires <pluginCid>' },
          });
          ctx.exit(1);
          return;
        }
        const scoreRaw = parsed.values.score as string | undefined;
        if (scoreRaw === undefined) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins review requires --score N' },
          });
          ctx.exit(1);
          return;
        }
        const score = Number.parseInt(scoreRaw, 10);
        if (!Number.isFinite(score)) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins review --score must be an integer' },
          });
          ctx.exit(1);
          return;
        }
        const scoreDecimalsRaw = parsed.values['score-decimals'] as string | undefined;
        const scoreDecimals = scoreDecimalsRaw === undefined ? 2 : Number.parseInt(scoreDecimalsRaw, 10);
        return reviewHandler(
          ctx,
          {
            pluginCid,
            score,
            scoreDecimals,
            tag1: parsed.values.tag1 as string | undefined,
            tag2: parsed.values.tag2 as string | undefined,
            configPath: parsed.values.config as string | undefined,
          },
          resolvedDeps,
        );
      }
      if (subverb === 'respond') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            'feedback-index': { type: 'string' },
            client: { type: 'string' },
            'response-uri': { type: 'string' },
            config: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        const feedbackIndexRaw = parsed.values['feedback-index'] as string | undefined;
        const clientRaw = parsed.values.client as string | undefined;
        const responseUri = parsed.values['response-uri'] as string | undefined;
        if (!pluginCid || !feedbackIndexRaw || !clientRaw || !responseUri) {
          writeJson(ctx, {
            error: {
              code: 'invalid_invocation',
              message: 'solver-plugins respond requires <pluginCid> --feedback-index N --client <addr> --response-uri <uri>',
            },
          });
          ctx.exit(1);
          return;
        }
        let clientAddress: Address;
        try {
          clientAddress = getAddress(clientRaw);
        } catch {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins respond --client must be a valid 0x address' },
          });
          ctx.exit(1);
          return;
        }
        let feedbackIndex: bigint;
        try {
          feedbackIndex = BigInt(feedbackIndexRaw);
        } catch {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins respond --feedback-index must be an integer' },
          });
          ctx.exit(1);
          return;
        }
        return respondHandler(
          ctx,
          {
            pluginCid,
            feedbackIndex,
            client: clientAddress,
            responseUri,
            configPath: parsed.values.config as string | undefined,
          },
          resolvedDeps,
        );
      }
      if (subverb === 'endorse') {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            score: { type: 'string' },
            'score-decimals': { type: 'string' },
            tag1: { type: 'string' },
            tag2: { type: 'string' },
            config: { type: 'string' },
          },
        });
        const pluginCid = parsed.positionals[0];
        if (!pluginCid) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins endorse requires <pluginCid>' },
          });
          ctx.exit(1);
          return;
        }
        const scoreRaw = parsed.values.score as string | undefined;
        const score = scoreRaw === undefined ? 100 : Number.parseInt(scoreRaw, 10);
        if (!Number.isFinite(score)) {
          writeJson(ctx, {
            error: { code: 'invalid_invocation', message: 'solver-plugins endorse --score must be an integer' },
          });
          ctx.exit(1);
          return;
        }
        const scoreDecimalsRaw = parsed.values['score-decimals'] as string | undefined;
        const scoreDecimals = scoreDecimalsRaw === undefined ? 2 : Number.parseInt(scoreDecimalsRaw, 10);
        return endorseHandler(
          ctx,
          {
            pluginCid,
            score,
            scoreDecimals,
            tag1: (parsed.values.tag1 as string | undefined) ?? 'endorsement',
            tag2: parsed.values.tag2 as string | undefined,
            configPath: parsed.values.config as string | undefined,
          },
          resolvedDeps,
        );
      }
      writeJson(ctx, {
        error: {
          code: 'invalid_invocation',
          message: `Unknown solver-plugins subverb: ${subverb}`,
          expected: 'show|validate|pack|publish|revoke|endorse|warn|block|review|respond|list-feedback|discover|status',
        },
      });
      ctx.exit(1);
    },
  };
}

// ── show / validate / pack — unchanged ───────────────────────────────────────

async function show(ctx: CommandContext, rest: string[]): Promise<void> {
  const target = rest.find((arg) => !arg.startsWith('--'));
  if (!target) {
    writeJson(ctx, { error: { code: 'invalid_invocation', message: 'solver-plugins show requires <source-or-path>' } });
    ctx.exit(1);
    return;
  }
  try {
    const plugin = await resolveSolverPlugin(target, { noVendor: true });
    writeJson(ctx, {
      verb: 'solver-plugins show',
      plugin: {
        name: plugin.name,
        version: plugin.version,
        solverType: plugin.solverType,
        supports: plugin.supports,
        source: plugin.source,
        sourceKind: plugin.sourceKind,
        root: plugin.root,
        manifestPath: plugin.manifestPath,
        sha256: plugin.sha256,
        jinn: plugin.manifest.jinn,
      },
    });
  } catch (err) {
    writeJson(ctx, {
      error: { code: 'invalid_solver_plugin', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
  }
}

async function validate(ctx: CommandContext, rest: string[]): Promise<void> {
  const target = rest.find((arg) => !arg.startsWith('--'));
  if (!target) {
    writeJson(ctx, { error: { code: 'invalid_invocation', message: 'solver-plugins validate requires <source-or-path>' } });
    ctx.exit(1);
    return;
  }
  try {
    const plugin = await resolveSolverPlugin(target, { noVendor: true });
    writeJson(ctx, {
      verb: 'solver-plugins validate',
      ok: true,
      plugin: {
        name: plugin.name,
        version: plugin.version,
        solverType: plugin.solverType,
        supports: plugin.supports,
        sha256: plugin.sha256,
        manifestPath: plugin.manifestPath,
      },
    });
  } catch (err) {
    writeJson(ctx, {
      verb: 'solver-plugins validate',
      ok: false,
      error: { code: 'invalid_solver_plugin', message: err instanceof Error ? err.message : String(err) },
    });
    ctx.exit(1);
  }
}

async function pack(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: 'string' } } });
  } catch (err) {
    writeJson(ctx, { error: { code: 'invalid_invocation', message: err instanceof Error ? err.message : String(err) } });
    ctx.exit(1);
    return;
  }
  const target = parsed.positionals[0];
  if (!target) {
    writeJson(ctx, { error: { code: 'invalid_invocation', message: 'solver-plugins pack requires <path>' } });
    ctx.exit(1);
    return;
  }
  const root = localRoot(target);
  if (!existsSync(root)) {
    writeJson(ctx, { error: { code: 'not_found', message: `SolverPlugin path not found: ${root}` } });
    ctx.exit(1);
    return;
  }
  try {
    const { path: manifestPath, manifest } = loadSolverPluginManifest(root);
    const sha256 = digestDirectory(root);
    const out = parsed.values.out
      ? resolve(process.cwd(), String(parsed.values.out))
      : resolve(process.cwd(), `${manifest.name}-${manifest.version}.tgz`);
    mkdirSync(dirname(out), { recursive: true });
    const tar = spawnSync('tar', ['-czf', out, '-C', dirname(root), basename(root)], { encoding: 'utf8' });
    if (tar.status !== 0) {
      throw new Error(tar.stderr || `tar exited ${tar.status}`);
    }
    writeJson(ctx, {
      verb: 'solver-plugins pack',
      packagePath: out,
      plugin: { name: manifest.name, version: manifest.version, supports: manifest.jinn.supports, manifestPath, sha256 },
    });
  } catch (err) {
    writeJson(ctx, { error: { code: 'invalid_solver_plugin', message: err instanceof Error ? err.message : String(err) } });
    ctx.exit(1);
  }
}

export default createSolverPluginsCommand();
