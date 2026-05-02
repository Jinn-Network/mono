/**
 * `jinn solver-plugins show|validate|pack` — author/curator tooling.
 *
 * These commands inspect SolverPlugin packages. They do not activate plugins;
 * operators attach plugins to SolverNets with `jinn solver-nets add-plugin`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { digestDirectory, loadSolverPluginManifest, resolveSolverPlugin } from '../../plugins/index.js';

function writeJson(ctx: CommandContext, value: unknown): void {
  ctx.writer.write(JSON.stringify(value) + '\n');
}

function localRoot(target: string): string {
  const stripped = target.startsWith('file:') || target.startsWith('path:')
    ? target.slice(target.indexOf(':') + 1)
    : target;
  return isAbsolute(stripped) ? stripped : resolve(process.cwd(), stripped);
}

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
      error: {
        code: 'invalid_solver_plugin',
        message: err instanceof Error ? err.message : String(err),
      },
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
        sha256: plugin.sha256,
        manifestPath: plugin.manifestPath,
      },
    });
  } catch (err) {
    writeJson(ctx, {
      verb: 'solver-plugins validate',
      ok: false,
      error: {
        code: 'invalid_solver_plugin',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
  }
}

async function pack(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: 'string' },
      },
    });
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
      plugin: {
        name: manifest.name,
        version: manifest.version,
        solverType: manifest.jinn.solverType,
        manifestPath,
        sha256,
      },
    });
  } catch (err) {
    writeJson(ctx, {
      error: {
        code: 'invalid_solver_plugin',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    ctx.exit(1);
  }
}

const command: CommandModule = {
  name: 'solver-plugins',
  summary: 'Inspect, validate, and pack SolverPlugin packages',
  helpText: `Usage:
  jinn solver-plugins show <source-or-path>
  jinn solver-plugins validate <source-or-path>
  jinn solver-plugins pack <path> [--out <file.tgz>]

SolverPlugin commands are author and curator tooling. They do not activate a
plugin for runtime use. Attach runtime plugins with:
  jinn solver-nets add-plugin <solver-net> <source>
`,
  async run(ctx) {
    const [subverb, ...rest] = ctx.argv;
    if (!subverb || subverb === '--help' || subverb === '-h') {
      ctx.writer.write(command.helpText + '\n');
      return;
    }
    if (subverb === 'show') return show(ctx, rest);
    if (subverb === 'validate') return validate(ctx, rest);
    if (subverb === 'pack') return pack(ctx, rest);
    writeJson(ctx, {
      error: {
        code: 'invalid_invocation',
        message: `Unknown solver-plugins subverb: ${subverb}`,
        expected: 'show|validate|pack',
      },
    });
    ctx.exit(1);
  },
};

export default command;
