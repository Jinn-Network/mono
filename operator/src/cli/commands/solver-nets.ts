import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { findWiringByName } from '../../config/participation.js';
import { loadConfig } from '../../config.js';
import {
  buildPredictionOperatorStatus,
  runPredictionSample,
  type PredictionOperatorStatus,
} from '../../solver-nets/prediction-operator-ux.js';
import {
  EVAL_SEMANTICS_VERSION,
  summarizeValidatedPool,
  summarizeWeakSuite,
  type ValidatedPoolSummary,
} from '../../solver-types/_swe-rebench-v2-validated-pool.js';
import { parseMintedEnvironmentBindingV1 } from '../../solver-types/_swe-rebench-v2-minted-pool.js';
import type { MintTasksInput } from '../../solver-types/_swe-rebench-v2-mint-cli.js';

const DEFAULT_CONFIG_PATH = join(homedir(), '.jinn-client', 'config.json');

/**
 * Keeps the public-repository v2 environment binding intact at the CLI edge.
 * Legacy candidates omit it and retain the immutable v1 artifact path.
 */
export function parseMintTaskCandidates(raw: unknown, noPost = false): MintTasksInput['candidates'] {
  const candidates = Array.isArray(raw) ? raw : [raw];
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`mint candidate ${index} must be an object`);
    }
    const c = candidate as Record<string, unknown>;
    if (!c['poolTask'] || typeof c['poolTask'] !== 'object' || Array.isArray(c['poolTask'])) {
      throw new Error(`mint candidate ${index} requires poolTask`);
    }
    if (typeof c['goldPatch'] !== 'string') throw new Error(`mint candidate ${index} requires goldPatch`);
    if (!c['provenance'] || typeof c['provenance'] !== 'object' || Array.isArray(c['provenance'])) {
      throw new Error(`mint candidate ${index} requires provenance`);
    }
    return {
      poolTask: c['poolTask'] as MintTasksInput['candidates'][number]['poolTask'],
      goldPatch: c['goldPatch'],
      provenance: c['provenance'] as MintTasksInput['candidates'][number]['provenance'],
      ...(c['environment'] === undefined ? {} : { environment: parseMintedEnvironmentBindingV1(c['environment']) }),
      ...(c['fixCommit'] === undefined ? {} : { fixCommit: c['fixCommit'] as string }),
      ...(c['row'] === undefined ? {} : { row: c['row'] as MintTasksInput['candidates'][number]['row'] }),
      ...(c['differentialAdmission'] === undefined
        ? {}
        : { differentialAdmission: c['differentialAdmission'] as MintTasksInput['candidates'][number]['differentialAdmission'] }),
      publish: noPost ? false : c['publish'] as boolean | undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// resolveValidatePoolInstanceIds — exported for unit testing
// ---------------------------------------------------------------------------

function readInstanceIdFile(name: 'swe-rebench-v2-seed-pool.json' | 'swe-rebench-v2-known-bad.json' | 'swe-rebench-v2-pytest-missing.json'): string[] {
  // Resolve relative to this compiled file's location. At runtime the file is
  // at dist/cli/commands/<this>.js and the data files are at dist/scripts/<name>
  // (copied there during `yarn build`). In dev/test the source file is at
  // src/cli/commands/<this>.ts and the data files live at scripts/<name>
  // (sibling to src/). In both cases ../../../scripts/<name> resolves correctly:
  //   dist/cli/commands → dist/ → dist/../scripts  (published package)
  //   src/cli/commands  → src/  → src/../scripts   (dev / vitest)
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolvePath(here, '..', '..', '..', 'scripts', name);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { instance_ids?: string[] };
  if (!Array.isArray(parsed.instance_ids)) {
    throw new Error(`${path} does not contain an instance_ids array`);
  }
  return parsed.instance_ids;
}

export function resolveValidatePoolInstanceIds(flags: {
  instanceId?: string[];
  instancesFile?: string;
  seedPositive?: boolean;
  knownBad?: boolean;
  knownPytestMissing?: boolean;
}): string[] {
  const collected: string[] = [];
  if (flags.instanceId) collected.push(...flags.instanceId);
  if (flags.instancesFile) {
    let body: string;
    try {
      body = readFileSync(flags.instancesFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`--instances-file: file not found: ${flags.instancesFile}`);
      }
      throw err;
    }
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      collected.push(line);
    }
  }
  if (flags.seedPositive) {
    collected.push(...readInstanceIdFile('swe-rebench-v2-seed-pool.json'));
  }
  if (flags.knownBad) {
    collected.push(...readInstanceIdFile('swe-rebench-v2-known-bad.json'));
  }
  if (flags.knownPytestMissing) {
    collected.push(...readInstanceIdFile('swe-rebench-v2-pytest-missing.json'));
  }
  return Array.from(new Set(collected));
}

// ---------------------------------------------------------------------------
// describeSweRebenchV2PoolFreshness — exported for unit testing
// ---------------------------------------------------------------------------

export async function describeSweRebenchV2PoolFreshness(opts: {
  stateDir: string;
}): Promise<
  | { status: 'ready'; semanticsVersion: string; scorable: number; unscorable: number; total: number }
  | { status: 'stale'; reason: string; cli: string }
> {
  const path = join(opts.stateDir, 'validated-pool.json');
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {
      status: 'stale',
      reason: 'validated-pool.json is absent or unreadable',
      cli: 'jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad',
    };
  }
  if (typeof raw !== 'object' || raw === null) {
    return {
      status: 'stale',
      reason: 'validated-pool.json is malformed',
      cli: 'jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad',
    };
  }
  const file = raw as { evalSemanticsVersion?: string; entries?: Record<string, { scorable?: boolean }> };
  if (file.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION) {
    return {
      status: 'stale',
      reason: `validated-pool.json was built for semanticsVersion=${file.evalSemanticsVersion ?? 'unknown'}, current=${EVAL_SEMANTICS_VERSION}`,
      cli: 'jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad',
    };
  }
  const entries = file.entries ?? {};
  const scorable = Object.values(entries).filter((e) => e.scorable === true).length;
  const unscorable = Object.values(entries).length - scorable;
  return {
    status: 'ready',
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    scorable,
    unscorable,
    total: scorable + unscorable,
  };
}

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

function solverNetFromWiring(workKind: string, harness?: string, plugins: SolverPluginEntry[] = []): SolverNetConfig {
  return {
    enabled: true,
    solverType: workKind,
    ...(harness ? { harness } : {}),
    plugins,
    taskGenerator: { enabled: false },
  };
}

/**
 * Resolve the SolverNet a read-only subverb (show/doctor/sample) should
 * operate against. Per issue #421 F4:
 *
 *   1. Prefer the still-on-disk legacy file shape (`cfg.solverNets[name]`)
 *      when present, so display-time sanitization (e.g. promoting
 *      `canonicalPlugin.source` into `plugins[]`) keeps working on configs
 *      the operator hasn't rewritten yet. The on-disk file is untouched by
 *      the in-memory migration; this branch surfaces what's literally on
 *      disk.
 *   2. Otherwise consult `loadConfig().joinedSolverNets` — the canonical
 *      view for an operator who has rejoined via the SPA (where there is
 *      no legacy on-disk block to fall back to).
 *   3. Otherwise surface `undefined` so the caller can emit
 *      `Unknown SolverNet: <name>`. The synthetic `predictionDefault()`
 *      shim is gone — it was masking the rejoined-via-SPA case.
 */
function resolveReadOnlySolverNet(
  configPath: string,
  _cfg: ConfigShape,
  name: string,
): SolverNetConfig | undefined {
  try {
    const loaded = loadConfig(configPath);
    const wiring = findWiringByName(loaded.executionWiring, name);
    if (!wiring) return undefined;
    return solverNetFromWiring(wiring.workKind, wiring.harness, [...wiring.plugins]);
  } catch {
    return undefined;
  }
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

const command: CommandModule = {
  name: 'solver-nets',
  summary: 'Manage SolverNet activation, Harness selection, and SolverNet-scoped plugins',
  helpText: `Usage:
  jinn solver-nets list [--human|--json] [--config <path>]
  jinn solver-nets show <name> [--human|--json] [--config <path>]
  jinn solver-nets doctor <name> [--human|--json] [--config <path>]
  jinn solver-nets sample <name> [--closed-window]
  jinn solver-nets validate-pool swe-rebench-v2 [--limit <n>] [--force]
                                [--instance-id <id>]... [--instances-file <path>]
                                [--seed-positive] [--known-bad]
                                [--known-pytest-missing]
                                [--recheck-discrimination [--limit <n>]]
            Run the gold patch of each pool instance through the eval harness
            and cache which instances are scorable; the generator then posts
            only those. Requires Docker + \`jinn harnesses enable
            swe-rebench-v2-evaluator\`.
            --recheck-discrimination runs ONLY the known-bad discrimination
            eval (no gold-patch re-run) against already-scorable entries that
            predate the check (\`discrimination: undefined\`). Flags failures
            (benchmark pool: scorable stays true — never hard-rejects an
            existing entry); \`--limit\` bounds how many entries one run
            rechecks.
            --seed-positive scopes the run to instances in
            operator/scripts/swe-rebench-v2-seed-pool.json (gold eval runs;
            most expected to record scorable:true).
            --known-bad scopes the run to instances in
            operator/scripts/swe-rebench-v2-known-bad.json (gold eval runs;
            expected to record scorable:false).
            --known-pytest-missing scopes the run to instances in
            operator/scripts/swe-rebench-v2-pytest-missing.json (Stage-1 #493
            sample of ungradeable:pytest_missing instances; under v4
            EVAL_SEMANTICS_VERSION + the pytest-install guard these should
            re-validate as scorable:true).
            Repeatable --instance-id and --instances-file scope the run to
            a specific subset.
  jinn solver-nets validate-pool-report swe-rebench-v2 [--human|--json]
  jinn solver-nets yield-report
  jinn solver-nets mint-tasks swe-rebench-v2 --candidates <json> [--no-post]
            Read-only report of the local validated-pool.json: total entries,
            scorable/unscorable counts, histogram by normalised reason, and
            the highest-yield unscorable blocker. Does not run any eval.
  jinn solver-nets screen-held-out swe-rebench-v2 [--repo <org>] [--instance-id <id> ...]
      [--runs 3] [--held-out-count 10] [--max-candidates 60] [--per-repo-cap 3]
      [--prover-harness codex|claude-code] [--prover-model <m>]

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
        // Repeatable instance-id input flags (jinn-mono-fufn Task 7):
        'instance-id': { type: 'string', multiple: true },
        'instances-file': { type: 'string' },
        'seed-positive': { type: 'boolean' },
        'known-bad': { type: 'boolean' },
        'known-pytest-missing': { type: 'boolean' },
        'recheck-discrimination': { type: 'boolean' },
        // screen-held-out (#986)
        runs: { type: 'string' },
        'held-out-count': { type: 'string' },
        'max-candidates': { type: 'string' },
        'per-repo-cap': { type: 'string' },
        'prover-harness': { type: 'string' },
        'prover-model': { type: 'string' },
        repo: { type: 'string' },
        candidates: { type: 'string' },
        'no-post': { type: 'boolean' },
      },
    });
    const human = Boolean(parsed.values['human']);
    const json = Boolean(parsed.values['json']);
    const [name] = parsed.positionals;

    if (!subverb || subverb === 'list') {
      // Issue #421: the legacy `solverNets` block has been retired. `loadConfig`
      // migrates any on-disk legacy entries into joinedSolverNets with
      // synthetic `legacy:<short-name>` keys, so the joined-only iteration
      // here surfaces both modern and migrated entries.
      const loaded = loadConfig(configPath);
      const joined = (loaded.executionWiring ?? []).map((entry) => ({
        name: entry.workKind,
        source: 'executionWiring' as const,
        manifestCid: entry.legacyManifestDigest,
        enabled: true,
        solverType: entry.workKind,
        harness: entry.harness,
        pluginCount: entry.plugins.length,
        taskGeneratorEnabled: false,
      }));
      const value = {
        verb: 'solver-nets list',
        configPath,
        solverNets: joined,
      };
      emit(ctx, value, human, json, (v) => {
        const list = v as typeof value;
        if (list.solverNets.length === 0) return 'No SolverNets configured.';
        return list.solverNets
          .map((n) =>
            `${n.name}  ${n.enabled ? 'enabled' : 'disabled'}  ${n.solverType}  ` +
            `harness=${n.harness ?? '(default)'}  plugins=${n.pluginCount}  ` +
            `generator=${n.taskGeneratorEnabled ? 'on' : 'off'}  source=${n.source}  cid=${n.manifestCid}`,
          )
          .join('\n');
      });
      return;
    }

    if (subverb === 'validate-pool-report') {
      if (name !== 'swe-rebench-v2') {
        fail(ctx, 'solver-nets validate-pool-report currently supports only `swe-rebench-v2`');
        return;
      }
      const stateDir = loadConfig(configPath).sweRebenchV2StateDir;
      const path = join(stateDir, 'validated-pool.json');
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        fail(ctx, `validated-pool.json is absent or unreadable at ${path}`);
        return;
      }
      let summary: ValidatedPoolSummary;
      try {
        summary = summarizeValidatedPool(raw);
      } catch (err) {
        fail(ctx, `validated-pool.json is malformed: ${(err as Error).message}`);
        return;
      }
      const evalSemanticsVersion = (raw as { evalSemanticsVersion?: string }).evalSemanticsVersion ?? 'unknown';
      const freshness = await describeSweRebenchV2PoolFreshness({ stateDir });
      const highestYieldBlocker = summary.byReason.find((b) => b.reason !== 'gold-patch-resolves')?.reason ?? null;
      const { PoolCacheStore } = await import('../../solver-types/_swe-rebench-v2-pool-cache.js');
      const cachedPool = await new PoolCacheStore({ stateDir }).read();
      const poolInstanceIds = cachedPool && cachedPool.tasks.length > 0
        ? new Set(cachedPool.tasks.map((t) => t.instance_id))
        : undefined;
      const weakSuite = summarizeWeakSuite(raw, poolInstanceIds);
      const value = {
        verb: 'solver-nets validate-pool-report',
        solverNet: 'swe-rebench-v2',
        evalSemanticsVersion,
        currentEvalSemanticsVersion: EVAL_SEMANTICS_VERSION,
        stateDir,
        ...summary,
        highestYieldBlocker,
        weakSuite,
        freshness,
      };
      emit(ctx, value, human, json, (v) => {
        const s = v as typeof value;
        const lines: string[] = [
          `SolverNet: swe-rebench-v2`,
          `  stateDir: ${s.stateDir}`,
          `  evalSemanticsVersion (file): ${s.evalSemanticsVersion}`,
          `  evalSemanticsVersion (current): ${s.currentEvalSemanticsVersion}`,
          `  total entries: ${s.totalEntries}`,
          `  scorable: ${s.scorable}`,
          `  unscorable: ${s.unscorable}`,
          `Histogram (by normalised reason, descending):`,
        ];
        for (const bucket of s.byReason) {
          lines.push(`  ${String(bucket.count).padStart(6)}  ${bucket.reason}`);
        }
        if (s.highestYieldBlocker) {
          lines.push(`Highest-yield unscorable blocker: ${s.highestYieldBlocker}`);
        }
        // D3 second half: weak-suite rate over discrimination-checked entries;
        // entries that predate the check (or await a recheck) are surfaced
        // separately as unchecked, never folded into the rate.
        const pct = s.weakSuite.rate !== null ? (s.weakSuite.rate * 100).toFixed(1) : 'n/a';
        lines.push(`weak-suite rate: ${s.weakSuite.flagged}/${s.weakSuite.checked} checked (${pct}%)`);
        const uncheckedTotal = s.weakSuite.unchecked.backlog + s.weakSuite.unchecked.orphaned;
        if (uncheckedTotal > 0) {
          lines.push(`  ${uncheckedTotal} scorable entr${uncheckedTotal === 1 ? 'y' : 'ies'} unchecked — backlog=${s.weakSuite.unchecked.backlog}  orphaned=${s.weakSuite.unchecked.orphaned}`);
          if (s.weakSuite.unchecked.backlog > 0) {
            lines.push(`  run \`validate-pool --recheck-discrimination\` for the backlog`);
          }
        }
        // #806: gold-patch-not-resolved entries whose PASS_TO_PASS tests broke
        // (p2p_broke > 0) are usually an environment/setup problem, not a
        // non-resolving gold patch — a chase-able, recoverable capacity blocker.
        const p2pBroke = s.byReason.find((b) => b.reason === 'gold-patch-not-resolved:p2p-broke');
        if (p2pBroke && p2pBroke.count > 0) {
          lines.push(
            `Candidate capacity blocker: ${p2pBroke.count} gold-patch-not-resolved entr${p2pBroke.count === 1 ? 'y' : 'ies'} broke PASS_TO_PASS (environment/setup problem, likely recoverable — investigate before treating as non-resolving patches)`,
          );
        }
        if (s.freshness.status === 'stale') {
          lines.push(`Freshness: stale — ${s.freshness.reason}`);
          lines.push(`  run: ${s.freshness.cli}`);
        }
        return lines.join('\n');
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
      const { validatePoolInstances, recheckDiscrimination, EVAL_SEMANTICS_VERSION } = await import('../../solver-types/_swe-rebench-v2-validated-pool.js');

      const limitRaw = parsed.values['limit'] as string | undefined;
      const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      const limit = Number.isFinite(limitParsed as number) && (limitParsed as number) > 0 ? (limitParsed as number) : undefined;
      const force = Boolean(parsed.values['force']);

      const instanceIds = resolveValidatePoolInstanceIds({
        instanceId: parsed.values['instance-id'] as string[] | undefined,
        instancesFile: parsed.values['instances-file'] as string | undefined,
        seedPositive: Boolean(parsed.values['seed-positive']),
        knownBad: Boolean(parsed.values['known-bad']),
        knownPytestMissing: Boolean(parsed.values['known-pytest-missing']),
      });

      process.stderr.write('[validate-pool] loading the SWE-rebench v2 pool…\n');
      let poolTasks = await loadSweRebenchV2Pool();
      if (instanceIds.length > 0) {
        const wanted = new Set(instanceIds);
        poolTasks = poolTasks.filter((t) => wanted.has(t.instance_id));
        process.stderr.write(`[validate-pool] restricted to ${poolTasks.length} of ${wanted.size} requested instance ids\n`);
      }
      const store = getSweRebenchV2ValidatedPoolStore(
        loadConfig(configPath).sweRebenchV2StateDir,
      );

      if (Boolean(parsed.values['recheck-discrimination'])) {
        const result = await recheckDiscrimination({
          pool: poolTasks,
          store,
          fetcher: new HttpHfFetcher(),
          runner: new PythonEvalRunner({ upstreamRepoDir }),
          semanticsVersion: EVAL_SEMANTICS_VERSION,
          limit,
          log: (m) => process.stderr.write(`${m}\n`),
        });
        emit(
          ctx,
          { verb: 'solver-nets validate-pool --recheck-discrimination', solverNet: 'swe-rebench-v2', evalSemanticsVersion: EVAL_SEMANTICS_VERSION, poolSize: poolTasks.length, ...result },
          human,
          json,
          (v) => {
            const s = v as { checked: number; flagged: string[]; skipped: { alreadyVerdicted: number; limitExceeded: number; orphanedPoolTask: number; evalError: number } };
            const sk = s.skipped;
            return [
              `recheck-discrimination: checked=${s.checked}  flagged=${s.flagged.length}`,
              `  skipped: alreadyVerdicted=${sk.alreadyVerdicted}  limitExceeded=${sk.limitExceeded}  orphanedPoolTask=${sk.orphanedPoolTask}  evalError=${sk.evalError}`,
            ].join('\n');
          },
        );
        return;
      }

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

    if (subverb === 'screen-held-out') {
      if (name !== 'swe-rebench-v2') {
        fail(ctx, 'solver-nets screen-held-out currently supports only `swe-rebench-v2`');
        return;
      }
      // Docker must be reachable (spec §8 precondition) or every base/prover
      // grade is unscorable and the screen yields nothing — fail loud instead.
      if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
        fail(ctx, 'Docker daemon not reachable — start Docker, then re-run `jinn solver-nets screen-held-out swe-rebench-v2`');
        return;
      }
      const num = (key: string, dflt: number): number => {
        const raw = parsed.values[key] as string | undefined;
        const v = raw ? Number.parseInt(raw, 10) : NaN;
        return Number.isFinite(v) && v > 0 ? v : dflt;
      };
      const { runScreenHeldOut } = await import('../../eval/screen-runner.js');
      const instanceIds = resolveValidatePoolInstanceIds({
        instanceId: parsed.values['instance-id'] as string[] | undefined,
        instancesFile: parsed.values['instances-file'] as string | undefined,
        seedPositive: Boolean(parsed.values['seed-positive']),
        knownBad: Boolean(parsed.values['known-bad']),
        knownPytestMissing: Boolean(parsed.values['known-pytest-missing']),
      });
      const proverHarnessRaw = parsed.values['prover-harness'] as string | undefined;
      if (proverHarnessRaw && proverHarnessRaw !== 'codex' && proverHarnessRaw !== 'claude-code') {
        fail(ctx, `--prover-harness must be 'codex' or 'claude-code' (got ${JSON.stringify(proverHarnessRaw)})`);
        return;
      }
      const summary = await runScreenHeldOut({
        R: num('runs', 3),
        heldOutCount: num('held-out-count', 10),
        maxCandidates: num('max-candidates', 60),
        perRepoCap: num('per-repo-cap', 3),
        ...(proverHarnessRaw ? { proverHarness: proverHarnessRaw as 'codex' | 'claude-code' } : {}),
        ...(parsed.values['prover-model'] ? { proverModel: parsed.values['prover-model'] as string } : {}),
        ...(instanceIds.length ? { instanceIds } : {}),
        ...(parsed.values['repo'] ? { repo: parsed.values['repo'] as string } : {}),
        ...(parsed.values['config'] ? { configPath: parsed.values['config'] as string } : {}),
        log: (m) => process.stderr.write(`${m}\n`),
      });
      emit(
        ctx,
        {
          verb: 'solver-nets screen-held-out', solverNet: 'swe-rebench-v2',
          heldOut: summary.heldOutCount, baseCodeDigest: summary.baseCodeDigest,
          slatePath: summary.slatePath, reportPath: summary.reportPath,
          screened: summary.result.screened.length, proverUnscorable: summary.proverUnscorable,
        },
        human, json,
        (v) => {
          const s = v as { heldOut: number; baseCodeDigest: string; slatePath: string; proverUnscorable: number };
          const warn = s.proverUnscorable > 0
            ? `\n  WARNING: prover returned no gradeable result on ${s.proverUnscorable} candidate(s) — ` +
              `prover may be UNAVAILABLE (check codex >=0.133.0 + auth); re-run before trusting an empty slate`
            : '';
          return `held-out=${s.heldOut}  base=${s.baseCodeDigest}\n  slate: ${s.slatePath}\n` +
            `  next: jinn eval v2 --checkpoint <trained-cid> --parent ${s.baseCodeDigest}${warn}`;
        },
      );
      return;
    }

    if (!name) {
      fail(ctx, `solver-nets ${subverb} requires <name>`);
      return;
    }

    const mutationSubverbs = new Set([
      'enable',
      'disable',
      'set-harness',
      'add-plugin',
      'remove-plugin',
    ]);
    if (mutationSubverbs.has(subverb)) {
      fail(
        ctx,
        `solver-nets ${subverb} was retired. Edit executionWiring in the operator config and restart.`,
      );
      return;
    }

    const isReadOnlySubverb = subverb === 'show' || subverb === 'doctor' || subverb === 'sample';

    if (!isReadOnlySubverb && subverb !== 'yield-report' && subverb !== 'mint-tasks') {
      fail(ctx, `Unknown solver-nets subverb: ${subverb}`);
      return;
    }

    const net = resolveReadOnlySolverNet(configPath, cfg, name);
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
        const status = await buildPredictionOperatorStatus({ config: loaded, configPath });
        emit(
          ctx,
          { verb: 'solver-nets doctor', ...status },
          human,
          json,
          renderPredictionStatusHuman,
        );
        return;
      }
      if (net.solverType === 'swe-rebench-v2.v1') {
        const stateDir = loadConfig(configPath).sweRebenchV2StateDir;
        const freshness = await describeSweRebenchV2PoolFreshness({ stateDir });
        const sanitized = sanitizeLegacySolverNet(net);
        emit(
          ctx,
          { verb: 'solver-nets doctor', configPath, name, solverNet: sanitized, validatedPoolFreshness: freshness },
          human,
          json,
          (v) => {
            const lines = [renderSolverNetHuman(v)];
            if (freshness.status === 'ready') {
              lines.push(`  validated-pool: ready (semanticsVersion=${freshness.semanticsVersion}, ${freshness.scorable} scorable, ${freshness.unscorable} unscorable, ${freshness.total} total)`);
            } else {
              lines.push(`  validated-pool: stale — ${freshness.reason}`);
              lines.push(`    run: ${freshness.cli}`);
            }
            return lines.join('\n');
          },
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

    if (subverb === 'yield-report') {
      const { computeExemplarPairYield } = await import('../../solver-types/_swe-rebench-v2-yield.js');
      const stats = (await import('../../solver-types/_swe-rebench-v2-yield-report-data.js')).loadYieldStatsFromEnv();
      writeJson(ctx, { verb: 'solver-nets yield-report', report: computeExemplarPairYield(stats) });
      return;
    }

    if (subverb === 'mint-tasks') {
      if (name !== 'swe-rebench-v2') {
        fail(ctx, 'solver-nets mint-tasks currently supports only `swe-rebench-v2`');
        return;
      }
      const candidatesPath = parsed.values['candidates'] as string | undefined;
      if (!candidatesPath) {
        fail(ctx, 'solver-nets mint-tasks requires --candidates <json> (see docs/runbooks/task-creator-amd64-gold-proof.md)');
        return;
      }
      const { readEnabledState, defaultSweRebenchV2EvaluatorImplStateDir } =
        await import('../../harnesses/impls/swe-rebench-v2-evaluator/harness.js');
      const enabled = readEnabledState(defaultSweRebenchV2EvaluatorImplStateDir());
      if (!enabled || !existsSync(enabled.upstreamRepoDir)) {
        fail(ctx, 'swe-rebench-v2 evaluator is not set up — run `jinn harnesses enable swe-rebench-v2-evaluator` first');
        return;
      }
      const upstreamRepoDir = enabled.upstreamRepoDir;
      if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
        fail(ctx, 'Docker daemon not reachable — start Docker, then re-run `jinn solver-nets mint-tasks`');
        return;
      }

      const loaded = loadConfig(configPath);
      const stateDir = loaded.sweRebenchV2StateDir;
      const raw = JSON.parse(readFileSync(resolvePath(candidatesPath), 'utf8')) as unknown;
      const noPost = Boolean(parsed.values['no-post']);
      const candidates = parseMintTaskCandidates(raw, noPost);

      const { runMintTasksPipeline } = await import('../../solver-types/_swe-rebench-v2-mint-cli.js');
      const { getDefaultMintedPoolStore } = await import('../../solver-types/_swe-rebench-v2-minted-pool.js');
      const { getSweRebenchV2ValidatedPoolStore } = await import('../../solver-types/swe-rebench-v2.js');
      const { HttpHfFetcher } = await import('../../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js');
      const { RoutingTaskRowFetcher, parseMintedPoolArtifact } =
        await import('../../harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js');
      const { PythonEvalRunner } = await import('../../harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js');
      const { createGitHubPublicRepoChecker } = await import('../../solver-types/_swe-rebench-v2-guards.js');
      const { fetchFromIpfs } = await import('../../adapters/mech/ipfs.js');
      const { parseJinnDifferentialAttesterPolicyV1 } = await import('../../task-creator/environment/jinn-differential-policy.js');
      const approvedAttesters = process.env.JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS;
      const jinnDifferentialAttesterPolicy = approvedAttesters
        ? parseJinnDifferentialAttesterPolicyV1(
            approvedAttesters.split(',').map((value) => value.trim()).filter(Boolean),
            'JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS',
          )
        : undefined;

      process.stderr.write(`[mint-tasks] admitting ${candidates.length} candidate(s)…\n`);
      const result = await runMintTasksPipeline({
        candidates,
        stateDir,
        ipfsRegistryUrl: loaded.ipfsRegistryUrl,
        ipfsGatewayUrl: loaded.ipfsGatewayUrl,
        validatedStore: getSweRebenchV2ValidatedPoolStore(stateDir),
        mintedStore: getDefaultMintedPoolStore(stateDir),
        fetcher: new RoutingTaskRowFetcher({
          hf: new HttpHfFetcher(),
          fetchMintedArtifact: async (cid) =>
            parseMintedPoolArtifact(await fetchFromIpfs(loaded.ipfsGatewayUrl, cid)),
        }),
        runner: new PythonEvalRunner({ upstreamRepoDir }),
        upstreamRepoDir,
        publicRepoChecker: createGitHubPublicRepoChecker({
          token: process.env.GITHUB_TOKEN,
        }),
        ...(jinnDifferentialAttesterPolicy ? { jinnDifferentialAttesterPolicy } : {}),
      });
      emit(
        ctx,
        { verb: 'solver-nets mint-tasks', solverNet: 'swe-rebench-v2', ...result },
        human,
        json,
        (v) => {
          const s = v as { admitted: string[]; rejected: Array<{ instance_id: string; reason: string }> };
          return `admitted=${s.admitted.length}  rejected=${s.rejected.length}` +
            (result.artifactCid ? `  artifact=${result.artifactCid}` : '');
        },
      );
      return;
    }

    fail(ctx, `Unknown solver-nets subverb: ${subverb}`);
  },
};

export default command;
