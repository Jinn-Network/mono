import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { loadConfig } from '../../config.js';
import { buildHarnesses } from '../../harnesses/impls/index.js';
import { loadSolverNets } from '../../solver-nets/registry.js';
import {
  buildPredictionOperatorStatus,
  runPredictionSample,
} from '../../solver-nets/prediction-operator-ux.js';

const DEFAULT_CONFIG_PATH = join(homedir(), '.jinn-client', 'config.json');

type SolverPluginEntry = string | { name?: string; source: string; version?: string };

interface SolverNetConfig {
  enabled?: boolean;
  solverType: string;
  harness?: string;
  plugins?: SolverPluginEntry[];
  taskGenerator?: { enabled?: boolean };
}

interface ConfigShape {
  solverNets?: Record<string, SolverNetConfig>;
  [key: string]: unknown;
}

function configPathFrom(argv: string[]): string {
  const idx = argv.indexOf('--config');
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1]! : DEFAULT_CONFIG_PATH;
}

function readConfig(path: string): ConfigShape {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ConfigShape;
  } catch {
    return {};
  }
}

function writeConfig(path: string, cfg: ConfigShape): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function ensureSolverNets(cfg: ConfigShape): Record<string, SolverNetConfig> {
  cfg.solverNets ??= {};
  return cfg.solverNets;
}

function predictionDefault(): SolverNetConfig {
  return {
    enabled: true,
    solverType: 'prediction.v1',
    harness: 'claude-code-learner',
    plugins: [],
    taskGenerator: { enabled: true },
  };
}

function sourceOf(entry: SolverPluginEntry): string {
  return typeof entry === 'string' ? entry : entry.source;
}

function writeJson(ctx: CommandContext, value: unknown): void {
  ctx.writer.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(ctx: CommandContext, message: string): void {
  writeJson(ctx, { error: { code: 'invalid_invocation', message } });
  ctx.exit(1);
}

function enableArgs(rest: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) continue;
    const stripped = arg.slice(2);
    const eq = stripped.indexOf('=');
    const key = eq >= 0 ? stripped.slice(0, eq) : stripped;
    if (key === 'config' || key === 'harness' || key === 'json' || key === 'human') {
      if (eq < 0 && (key === 'config' || key === 'harness')) i += 1;
      continue;
    }
    out[key] = eq >= 0
      ? stripped.slice(eq + 1)
      : rest[i + 1] && !rest[i + 1]!.startsWith('--')
        ? rest[++i]
        : '';
  }
  return out;
}

const command: CommandModule = {
  name: 'solver-nets',
  summary: 'Manage SolverNet activation, Harness selection, and SolverNet-scoped plugins',
  helpText: `Usage:
  jinn solver-nets list [--config <path>]
  jinn solver-nets show <name> [--config <path>]
  jinn solver-nets enable <name> [--harness <name>] [--config <path>]
  jinn solver-nets disable <name> [--config <path>]
  jinn solver-nets set-harness <name> <harness> [--config <path>]
  jinn solver-nets add-plugin <name> <source> [--config <path>]
  jinn solver-nets remove-plugin <name> <source-or-name> [--config <path>]
  jinn solver-nets doctor <name> [--config <path>]
  jinn solver-nets sample <name> [--closed-window]`,

  async run(ctx) {
    const [subverb, ...rest] = ctx.argv;
    const configPath = configPathFrom(ctx.argv);
    const cfg = readConfig(configPath);
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: false,
      options: {
        config: { type: 'string' },
        harness: { type: 'string' },
        'closed-window': { type: 'boolean' },
      },
    });
    const [name, arg2] = parsed.positionals;

    if (!subverb || subverb === 'list') {
      const loaded = loadConfig(configPath);
      writeJson(ctx, {
        verb: 'solver-nets list',
        configPath,
        solverNets: Object.entries(loaded.solverNets).map(([netName, net]) => ({
          name: netName,
          enabled: net.enabled,
          solverType: net.solverType,
          harness: net.harness,
          pluginCount: net.plugins.length,
          taskGeneratorEnabled: net.taskGenerator.enabled,
        })),
      });
      return;
    }

    if (!name) {
      fail(ctx, `solver-nets ${subverb} requires <name>`);
      return;
    }

    const solverNets = ensureSolverNets(cfg);
    if (name === 'prediction' && !solverNets[name]) {
      solverNets[name] = predictionDefault();
    }
    const net = solverNets[name];
    if (!net) {
      fail(ctx, `Unknown SolverNet: ${name}`);
      return;
    }

    if (subverb === 'show') {
      writeJson(ctx, { verb: `solver-nets ${subverb}`, configPath, name, solverNet: net });
      return;
    }

    if (subverb === 'doctor') {
      if (net.solverType === 'prediction.v1') {
        const loaded = loadConfig(configPath);
        const status = await buildPredictionOperatorStatus({ config: loaded, configPath, name });
        writeJson(ctx, { verb: 'solver-nets doctor', ...status });
        return;
      }
      writeJson(ctx, { verb: 'solver-nets doctor', configPath, name, solverNet: net });
      return;
    }

    if (subverb === 'sample') {
      if (net.solverType !== 'prediction.v1') {
        fail(ctx, `solver-nets sample only supports prediction.v1 SolverNets; ${name} is ${net.solverType}`);
        return;
      }
      const sample = await runPredictionSample({
        closedWindow: Boolean(parsed.values['closed-window']),
      });
      writeJson(ctx, { verb: 'solver-nets sample', configPath, name, ...sample });
      return;
    }

    if (subverb === 'enable') {
      net.enabled = true;
      if (typeof parsed.values.harness === 'string') net.harness = parsed.values.harness;
      writeConfig(configPath, cfg);
      const loaded = loadConfig(configPath);
      const registry = await loadSolverNets(loaded);
      const loadedNet = registry.get(name);
      const selectedHarness = loadedNet?.harness ?? net.harness;
      let enableResult: unknown = null;
      if (loadedNet && selectedHarness) {
        const harness = buildHarnesses({
          stub: true,
          rpcUrl: loaded.rpcUrl,
          archiveRpcUrl: loaded.archiveRpcUrl,
          claudePath: loaded.claudePath,
          claudeModel: loaded.claudeModel,
          implStateDirRoot: loaded.engine.implStateDirRoot,
        }).find((candidate) => candidate.name === selectedHarness);
        if (harness?.onEnable) {
          enableResult = await harness.onEnable({
            solverNet: { name: loadedNet.name, solverType: loadedNet.solverType },
            runtimePlugins: loadedNet.runtimePlugins,
            args: enableArgs(rest),
          });
        }
      }
      writeJson(ctx, { verb: 'solver-nets enable', configPath, name, solverNet: net, enableResult });
      return;
    }

    if (subverb === 'disable') {
      net.enabled = false;
      writeConfig(configPath, cfg);
      writeJson(ctx, { verb: 'solver-nets disable', configPath, name, solverNet: net });
      return;
    }

    if (subverb === 'set-harness') {
      if (!arg2) {
        fail(ctx, 'solver-nets set-harness requires <harness>');
        return;
      }
      net.harness = arg2;
      writeConfig(configPath, cfg);
      writeJson(ctx, { verb: 'solver-nets set-harness', configPath, name, harness: arg2 });
      return;
    }

    if (subverb === 'add-plugin') {
      if (!arg2) {
        fail(ctx, 'solver-nets add-plugin requires <source>');
        return;
      }
      const current = net.plugins ?? [];
      if (!current.some((entry) => sourceOf(entry) === arg2)) {
        net.plugins = [...current, arg2];
      }
      writeConfig(configPath, cfg);
      writeJson(ctx, { verb: 'solver-nets add-plugin', configPath, name, source: arg2 });
      return;
    }

    if (subverb === 'remove-plugin') {
      if (!arg2) {
        fail(ctx, 'solver-nets remove-plugin requires <source-or-name>');
        return;
      }
      const current = net.plugins ?? [];
      net.plugins = current.filter((entry) =>
        typeof entry === 'string' ? entry !== arg2 : entry.source !== arg2 && entry.name !== arg2,
      );
      writeConfig(configPath, cfg);
      writeJson(ctx, { verb: 'solver-nets remove-plugin', configPath, name, removed: arg2 });
      return;
    }

    fail(ctx, `Unknown solver-nets subverb: ${subverb}`);
  },
};

export default command;
