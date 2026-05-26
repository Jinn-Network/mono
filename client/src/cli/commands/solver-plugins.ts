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
import { pinFileToIpfs as defaultPinFileToIpfs } from '../../adapters/mech/ipfs-pinfile.js';
import { fetchFromIpfs as defaultFetchFromIpfs } from '../../adapters/mech/ipfs.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import { createJinnPublicClient, createJinnWalletClient, type JinnOnchainNetwork } from '../../earning/viem-clients.js';
import { walletPrivateKeyAtIndex, decryptMnemonic } from '../../earning/wallet.js';
import { FleetStateStore } from '../../earning/store.js';
import { privateKeyToAccount } from 'viem/accounts';
import { publishHandler } from './solver-plugins-publish.js';
import { revokeHandler } from './solver-plugins-revoke.js';
import { ReputationRegistryClient } from '../../erc8004/reputation.js';
import { createDiscoveryAPI } from '../../discovery/factory.js';
import type { DiscoveryAPI } from '../../discovery/types.js';

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
  discoveryApiFactory: (cfg: ReturnType<typeof defaultLoadConfig>) => DiscoveryAPI;
  ipfsFetch: typeof defaultFetchFromIpfs;
  readConfigFile: ConfigFileIo['readConfigFile'];
  writeConfigFile: ConfigFileIo['writeConfigFile'];
  resolveCliPassword: typeof defaultResolveCliPassword;
  now: () => number;
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
          const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
          const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);
          const account = privateKeyToAccount(agentKey);
          const walClient = createJinnWalletClient(args.rpcUrl, args.network, account);
          return new ReputationRegistryClient({
            reputationRegistryAddress: args.reputationRegistryAddress,
            publicClient: pubClient,
            walletClient: walClient,
            ...(args.safeAddress ? { safeAddress: args.safeAddress } : {}),
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
  discoveryApiFactory: (cfg) => {
    const chainId = cfg.network === 'testnet' ? 84532 : 8453;
    return createDiscoveryAPI(cfg.discovery ?? { mode: 'onchain' }, {
      rpcUrl: cfg.rpcUrl,
      chainId,
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

SolverPlugin show/validate/pack are author/curator tooling — zero chain writes.

publish + revoke are BUILDER actions:
  • Write \`plugin:<cid>\` metadata records on the ERC-8004 IdentityRegistry.
  • Route through the fleet's Stage 1 identity Safe (\`fleet_safe_address\`).
  • Lazily complete Stage 1 (ETH funding + Safe deploy + agent NFT mint) if needed.
  • Never touch Stage 2 (OLAS service / staking) state.

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
      writeJson(ctx, {
        error: {
          code: 'invalid_invocation',
          message: `Unknown solver-plugins subverb: ${subverb}`,
          expected: 'show|validate|pack|publish|revoke',
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
    const plugin = await resolveSolverPlugin(target);
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
    const plugin = await resolveSolverPlugin(target);
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
