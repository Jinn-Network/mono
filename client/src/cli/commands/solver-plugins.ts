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
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Address, PublicClient, WalletClient } from 'viem';
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
import {
  PluginRegistryPublisher,
  type PluginRegistryPublisherConfig,
} from '../../erc8004/plugin-registry.js';
import { pinFileToIpfs as defaultPinFileToIpfs } from '../../adapters/mech/ipfs-pinfile.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import { publishHandler } from './solver-plugins-publish.js';
import { revokeHandler } from './solver-plugins-revoke.js';

function writeJson(ctx: CommandContext, value: unknown): void {
  ctx.writer.write(JSON.stringify(value) + '\n');
}

function localRoot(target: string): string {
  const stripped = target.startsWith('file:') || target.startsWith('path:')
    ? target.slice(target.indexOf(':') + 1)
    : target;
  return isAbsolute(stripped) ? stripped : resolve(process.cwd(), stripped);
}

export interface PublisherFactoryArgs extends PluginRegistryPublisherConfig {}

export interface SolverPluginsDeps extends BaseCommandDeps {
  bootstrapperFactory: (cfg: ReturnType<typeof defaultLoadConfig>) => Pick<FleetBootstrapper, 'ensureStage1'>;
  pinFileToIpfs: typeof defaultPinFileToIpfs;
  publisherFactory: (
    args: PublisherFactoryArgs,
  ) => {
    publish: PluginRegistryPublisher['publish'];
    revoke: PluginRegistryPublisher['revoke'];
  };
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
  publisherFactory: (args) => new PluginRegistryPublisher(args),
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
