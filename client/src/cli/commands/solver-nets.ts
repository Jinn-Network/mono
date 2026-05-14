import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { loadConfig } from '../../config.js';
import { buildHarnesses } from '../../harnesses/impls/index.js';
import { canonicalHarnessName, CLAUDE_CODE_HARNESS, harnessNameMatches } from '../../harnesses/names.js';
import { loadSolverNets } from '../../solver-nets/registry.js';
import {
  buildPredictionOperatorStatus,
  runPredictionSample,
  type PredictionOperatorStatus,
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
    harness: CLAUDE_CODE_HARNESS,
    plugins: [],
    taskGenerator: { enabled: true },
  };
}

function sourceOf(entry: SolverPluginEntry): string {
  return typeof entry === 'string' ? entry : entry.source;
}

/**
 * Strip legacy fields (e.g. `canonicalPlugin`, `referencePlugins`) from a
 * persisted operator config block before display.
 *
 * The runtime model is layered substrate (auto-injected Network Tools +
 * contract `defaultRuntimePlugins` + operator `plugins[]`); the single
 * primary-plugin model was removed by jinn-mono-l2zl.14 and is no longer
 * configurable. Operator configs written before that change may still carry
 * `canonicalPlugin` on disk, but operators must not see it surfaced as a
 * current concept.
 *
 * If a legacy `canonicalPlugin.source` is present and not already in
 * `plugins[]`, it is promoted into `plugins[]` so display-time sanitization
 * does not silently discard operator intent.
 */
const LEGACY_SOLVERNET_FIELDS = new Set(['canonicalPlugin', 'referencePlugins']);

function sanitizeLegacySolverNet(raw: unknown): SolverNetConfig {
  if (typeof raw !== 'object' || raw === null) {
    // Malformed config slot (`null`, number, string) — emit a safe minimal
    // shape rather than letting the bad value reach the renderer or JSON
    // envelope. `readConfig` uses `JSON.parse` without zod, so any shape can
    // slip through here.
    return { solverType: 'unknown' };
  }
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (LEGACY_SOLVERNET_FIELDS.has(key)) continue;
    out[key] = value;
  }
  const legacyCanonical = source['canonicalPlugin'];
  if (legacyCanonical && typeof legacyCanonical === 'object') {
    const legacySource = (legacyCanonical as { source?: unknown }).source;
    if (typeof legacySource === 'string' && legacySource.length > 0) {
      const current = Array.isArray(out['plugins']) ? (out['plugins'] as SolverPluginEntry[]) : [];
      if (!current.some((entry) => sourceOf(entry) === legacySource)) {
        out['plugins'] = [...current, legacySource];
      }
    }
  }
  return out as unknown as SolverNetConfig;
}

function writeJson(ctx: CommandContext, value: unknown): void {
  ctx.writer.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(ctx: CommandContext, message: string): void {
  writeJson(ctx, { error: { code: 'invalid_invocation', message } });
  ctx.exit(1);
}

function emit(ctx: CommandContext, value: unknown, human: boolean, json: boolean, render: (v: unknown) => string): void {
  emitResult(value, render, {
    json,
    human,
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

function renderSolverNetHuman(value: unknown): string {
  const v = value as { name?: string; configPath?: string; solverNet?: Partial<SolverNetConfig> };
  const net: Partial<SolverNetConfig> = v.solverNet ?? {};
  const plugins = (net.plugins ?? []).map((p) => sourceOf(p));
  const lines = [
    `SolverNet: ${v.name ?? '(unknown)'}`,
    `  configPath: ${v.configPath ?? '(unknown)'}`,
    `  enabled: ${net.enabled ?? '(default true)'}`,
    `  solverType: ${net.solverType ?? '(unset)'}`,
    `  harness: ${net.harness ?? '(default)'}`,
    `  plugins: ${plugins.length === 0 ? '(none)' : plugins.join(', ')}`,
    `  taskGenerator: ${net.taskGenerator?.enabled === false ? 'disabled' : 'enabled'}`,
  ];
  return lines.join('\n');
}

function renderPredictionStatusHuman(value: unknown): string {
  const status = value as PredictionOperatorStatus & { verb?: string; configPath?: string };
  const lines = [
    `SolverNet: ${status.solverNet.name}`,
    `  configPath: ${status.configPath}`,
    `  enabled: ${status.solverNet.enabled}`,
    `  solverType: ${status.solverNet.solverType}`,
    `  roles: ${status.solverNet.roles.join(', ') || '(none)'}`,
    `  harness: ${status.solverNet.harness ?? '(unset)'}`,
    `  taskGenerator: ${status.solverNet.taskGeneratorEnabled ? 'enabled' : 'disabled'}`,
    `  status: ${status.ok ? 'OK' : 'attention needed'}`,
  ];
  if (status.runtimePlugins.length > 0) {
    lines.push('  runtimePlugins:');
    for (const plugin of status.runtimePlugins) {
      lines.push(`    - ${plugin.name ?? plugin.source ?? '(unknown)'} [${plugin.provenance}]`);
    }
  }
  if (status.harness) {
    const readiness = status.harness.readiness.ready ? 'ready' : `not ready (${status.harness.readiness.reason})`;
    lines.push(`  harnessDetail: ${status.harness.name} v${status.harness.version} — ${readiness}`);
  }
  if (status.diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const diagnostic of status.diagnostics) {
      lines.push(`  ${diagnostic.severity.toUpperCase()}  ${diagnostic.code}: ${diagnostic.message}`);
      if (diagnostic.nextAction?.cli) {
        lines.push(`    next: ${diagnostic.nextAction.cli}`);
      }
    }
  }
  lines.push(`Next: ${status.nextAction.description}`);
  if (status.nextAction.cli) lines.push(`  cli: ${status.nextAction.cli}`);
  return lines.join('\n');
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
  jinn solver-nets list [--human|--json] [--config <path>]
  jinn solver-nets show <name> [--human|--json] [--config <path>]
  jinn solver-nets enable <name> [--harness <name>] [--config <path>]
  jinn solver-nets disable <name> [--config <path>]
  jinn solver-nets set-harness <name> <harness> [--config <path>]
  jinn solver-nets add-plugin <name> <source> [--config <path>]
  jinn solver-nets remove-plugin <name> <source-or-name> [--config <path>]
  jinn solver-nets doctor <name> [--human|--json] [--config <path>]
  jinn solver-nets sample <name> [--closed-window]
  jinn solver-nets validate-pool swe-rebench-v2 [--limit <n>] [--force]
            Run the gold patch of each pool instance through the eval harness
            and cache which instances are scorable; the generator then posts
            only those. Requires Docker + \`jinn harnesses enable
            swe-rebench-v2-evaluator\`.

Output flags:
  --human   Render readable terminal output instead of JSON (supported by
            list, show, doctor).
  --json    Force JSON output (the default).`,

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
        limit: { type: 'string' },
        force: { type: 'boolean' },
        human: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
    const human = Boolean(parsed.values['human']);
    const json = Boolean(parsed.values['json']);
    const [name, arg2] = parsed.positionals;

    if (!subverb || subverb === 'list') {
      const loaded = loadConfig(configPath);
      const value = {
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
      };
      emit(ctx, value, human, json, (v) => {
        const list = v as typeof value;
        if (list.solverNets.length === 0) return 'No SolverNets configured.';
        return list.solverNets
          .map((n) => `${n.name}  ${n.enabled ? 'enabled' : 'disabled'}  ${n.solverType}  harness=${n.harness ?? '(default)'}  plugins=${n.pluginCount}  generator=${n.taskGeneratorEnabled ? 'on' : 'off'}`)
          .join('\n');
      });
      return;
    }

    if (subverb === 'validate-pool') {
      if (name !== 'swe-rebench-v2') {
        fail(ctx, 'solver-nets validate-pool currently supports only `swe-rebench-v2`');
        return;
      }
      // The upstream eval harness must be set up (`jinn harnesses enable
      // swe-rebench-v2-evaluator`) — that's where the eval.py repo lives.
      const { readEnabledState, defaultSweRebenchV2EvaluatorImplStateDir } =
        await import('../../harnesses/impls/swe-rebench-v2-evaluator/harness.js');
      const enabled = readEnabledState(defaultSweRebenchV2EvaluatorImplStateDir());
      if (!enabled || !existsSync(enabled.upstreamRepoDir)) {
        fail(ctx, 'swe-rebench-v2 evaluator is not set up — run `jinn harnesses enable swe-rebench-v2-evaluator` first');
        return;
      }
      const upstreamRepoDir = enabled.upstreamRepoDir;
      // Docker must be reachable, or every gold-eval would be classified as
      // ungradeable and the whole pool wrongly marked unscorable.
      if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
        fail(ctx, 'Docker daemon not reachable — start Docker, then re-run `jinn solver-nets validate-pool swe-rebench-v2`');
        return;
      }

      const { loadSweRebenchV2Pool, getSweRebenchV2ValidatedPoolStore } = await import('../../solver-types/swe-rebench-v2.js');
      const { HttpHfFetcher } = await import('../../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js');
      const { PythonEvalRunner } = await import('../../harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js');
      const { validatePoolInstances, EVAL_SEMANTICS_VERSION } = await import('../../solver-types/_swe-rebench-v2-validated-pool.js');

      const limitRaw = parsed.values['limit'] as string | undefined;
      const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      const limit = Number.isFinite(limitParsed as number) && (limitParsed as number) > 0 ? (limitParsed as number) : undefined;
      const force = Boolean(parsed.values['force']);

      process.stderr.write('[validate-pool] loading the SWE-rebench v2 pool…\n');
      const poolTasks = await loadSweRebenchV2Pool();
      const store = getSweRebenchV2ValidatedPoolStore();
      const summary = await validatePoolInstances(
        poolTasks,
        {
          fetcher: new HttpHfFetcher(),
          runner: new PythonEvalRunner({ upstreamRepoDir }),
          store,
          semanticsVersion: EVAL_SEMANTICS_VERSION,
          upstreamRepoDir,
          log: (m) => process.stderr.write(`${m}\n`),
        },
        { limit, force },
      );
      emit(
        ctx,
        { verb: 'solver-nets validate-pool', solverNet: 'swe-rebench-v2', evalSemanticsVersion: EVAL_SEMANTICS_VERSION, poolSize: poolTasks.length, ...summary },
        human,
        json,
        (v) => {
          const s = v as { poolSize: number; checked: number; scorable: number; unscorable: number; skipped: number };
          return `pool=${s.poolSize}  checked=${s.checked}  scorable=${s.scorable}  unscorable=${s.unscorable}  skipped(non-pytest)=${s.skipped}`;
        },
      );
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
      const sanitized = sanitizeLegacySolverNet(net);
      emit(
        ctx,
        { verb: `solver-nets ${subverb}`, configPath, name, solverNet: sanitized },
        human,
        json,
        renderSolverNetHuman,
      );
      return;
    }

    if (subverb === 'doctor') {
      if (net.solverType === 'prediction.v1') {
        const loaded = loadConfig(configPath);
        const status = await buildPredictionOperatorStatus({ config: loaded, configPath, name });
        emit(
          ctx,
          { verb: 'solver-nets doctor', ...status },
          human,
          json,
          renderPredictionStatusHuman,
        );
        return;
      }
      const sanitized = sanitizeLegacySolverNet(net);
      emit(
        ctx,
        { verb: 'solver-nets doctor', configPath, name, solverNet: sanitized },
        human,
        json,
        renderSolverNetHuman,
      );
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
      if (typeof parsed.values.harness === 'string') net.harness = canonicalHarnessName(parsed.values.harness);
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
        }).find((candidate) => harnessNameMatches(candidate.name, selectedHarness));
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
      const harness = canonicalHarnessName(arg2);
      net.harness = harness;
      writeConfig(configPath, cfg);
      writeJson(ctx, { verb: 'solver-nets set-harness', configPath, name, harness });
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
