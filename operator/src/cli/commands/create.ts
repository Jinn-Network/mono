/**
 * `jinn create harness <pkgName>` — scaffolds a working external
 * Harness package on disk. After
 *   cd <pkgName> && yarn install && yarn test
 * the package's tests pass against a synthetic HarnessContext.
 *
 * Spec: `spec/2026-05-01-harness-pack-architecture.md`.
 */

import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';

/**
 * Resolve the templates directory. During development the file lives
 * at `operator/src/cli/commands/create.ts`, so `../../../templates`
 * resolves to `operator/templates`. After tsc, it lives at
 * `operator/dist/cli/commands/create.js`, so the same offset resolves
 * to `operator/dist/templates` — we copy templates into dist on build.
 * For robustness we probe both locations.
 */
function resolveTemplatesRoot(target: 'harness' | 'plugin'): string {
  const subdir = target === 'harness' ? 'harnesses' : 'plugins';
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(here, `../../../templates/${subdir}/`),
    join(here, `../../templates/${subdir}/`),
    join(here, `../../../../templates/${subdir}/`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

const NETWORK_CHAIN_IDS: Record<string, number> = {
  'base-mainnet': 8453,
  'base-sepolia': 84532,
  sepolia: 11155111,
  'ethereum-mainnet': 1,
};

const QUICKSTART_URL =
  'https://github.com/Jinn-Network/mono/blob/next/client/docs/build/quickstart.md';

export type HarnessPattern = 'forecaster' | 'evaluator' | 'alternative-harness';

export const SUPPORTED_PATTERNS: readonly HarnessPattern[] = [
  'forecaster',
  'evaluator',
  'alternative-harness',
];

export type PluginPattern = 'solver-type-plugin' | 'runtime-plugin';

export const SUPPORTED_PLUGIN_PATTERNS: readonly PluginPattern[] = [
  'solver-type-plugin',
  'runtime-plugin',
];

export interface RunCreateArgs {
  target: 'harness' | 'plugin';
  pattern: HarnessPattern | PluginPattern;
  packageName: string;
  solverTypeString: string;
  network?: string;
  outDir: string;
}

interface TemplateFile {
  src: string;
  dst: string;
}

const FORECASTER_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'tsconfig.json.tmpl', dst: 'tsconfig.json' },
  { src: 'jinn.manifest.json.tmpl', dst: 'jinn.manifest.json' },
  { src: 'src/index.ts.tmpl', dst: 'src/index.ts' },
  { src: 'test/unit.test.ts.tmpl', dst: 'test/unit.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const EVALUATOR_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'tsconfig.json.tmpl', dst: 'tsconfig.json' },
  { src: 'jinn.manifest.json.tmpl', dst: 'jinn.manifest.json' },
  { src: 'src/index.ts.tmpl', dst: 'src/index.ts' },
  { src: 'test/unit.test.ts.tmpl', dst: 'test/unit.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const ALTERNATIVE_HARNESS_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'tsconfig.json.tmpl', dst: 'tsconfig.json' },
  { src: 'jinn.manifest.json.tmpl', dst: 'jinn.manifest.json' },
  { src: 'src/index.ts.tmpl', dst: 'src/index.ts' },
  { src: 'src/harness.ts.tmpl', dst: 'src/harness.ts' },
  { src: 'src/mock-harness.ts.tmpl', dst: 'src/mock-harness.ts' },
  { src: 'src/coordinator.ts.tmpl', dst: 'src/coordinator.ts' },
  { src: 'src/phases/orient.ts.tmpl', dst: 'src/phases/orient.ts' },
  { src: 'src/phases/strategize.ts.tmpl', dst: 'src/phases/strategize.ts' },
  { src: 'src/phases/plan.ts.tmpl', dst: 'src/phases/plan.ts' },
  { src: 'src/phases/execute.ts.tmpl', dst: 'src/phases/execute.ts' },
  { src: 'src/phases/debrief.ts.tmpl', dst: 'src/phases/debrief.ts' },
  { src: 'src/phases/improve.ts.tmpl', dst: 'src/phases/improve.ts' },
  { src: 'src/phases/memory.ts.tmpl', dst: 'src/phases/memory.ts' },
  { src: 'test/unit.test.ts.tmpl', dst: 'test/unit.test.ts' },
  { src: 'test/coordinator.test.ts.tmpl', dst: 'test/coordinator.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const SOLVER_TYPE_PLUGIN_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn.plugin.json.tmpl', dst: 'jinn.plugin.json' },
  { src: 'skills/example/SKILL.md.tmpl', dst: 'skills/example/SKILL.md' },
  { src: 'test/plugin.test.ts.tmpl', dst: 'test/plugin.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'tsconfig.json.tmpl', dst: 'tsconfig.json' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const RUNTIME_PLUGIN_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn.plugin.json.tmpl', dst: 'jinn.plugin.json' },
  { src: '.mcp.json.tmpl', dst: '.mcp.json' },
  { src: 'mcp/server.mjs.tmpl', dst: 'mcp/server.mjs' },
  { src: 'test/plugin.test.ts.tmpl', dst: 'test/plugin.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'tsconfig.json.tmpl', dst: 'tsconfig.json' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

function pluginTemplateFiles(pattern: PluginPattern): TemplateFile[] {
  switch (pattern) {
    case 'solver-type-plugin':
      return SOLVER_TYPE_PLUGIN_FILES;
    case 'runtime-plugin':
      return RUNTIME_PLUGIN_FILES;
    default:
      throw new Error(`unsupported plugin pattern: ${pattern as string}`);
  }
}

function templateFiles(pattern: HarnessPattern): TemplateFile[] {
  switch (pattern) {
    case 'forecaster':
      return FORECASTER_FILES;
    case 'evaluator':
      return EVALUATOR_FILES;
    case 'alternative-harness':
      return ALTERNATIVE_HARNESS_FILES;
    default:
      throw new Error(`unsupported pattern: ${pattern as string}`);
  }
}

function substitute(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    String(vars[key] ?? ''),
  );
}

function packageNameSlug(packageName: string): string {
  return packageName.replace(/^@/, '').replace(/[/]/g, '-');
}

export async function runCreate(args: RunCreateArgs): Promise<string> {
  const targetRoot = join(args.outDir, args.packageName);
  const vars: Record<string, string | number> = {
    packageName: args.packageName,
    packageNameSlug: packageNameSlug(args.packageName),
    solverTypeString: args.solverTypeString,
  };

  let files: TemplateFile[];
  let templatesRoot: string;

  if (args.target === 'harness') {
    const network = args.network ?? 'base-sepolia';
    const networkChainId = NETWORK_CHAIN_IDS[network];
    if (networkChainId === undefined) {
      throw new Error(
        `unknown network ${network}; known: ${Object.keys(NETWORK_CHAIN_IDS).join(', ')}`,
      );
    }
    vars.network = network;
    vars.networkChainId = networkChainId;
    files = templateFiles(args.pattern as HarnessPattern);
    templatesRoot = join(resolveTemplatesRoot('harness'), args.pattern);
  } else if (args.target === 'plugin') {
    files = pluginTemplateFiles(args.pattern as PluginPattern);
    templatesRoot = join(resolveTemplatesRoot('plugin'), args.pattern);
  } else {
    throw new Error(`unsupported target: ${(args as { target: string }).target}`);
  }

  for (const file of files) {
    const srcPath = join(templatesRoot, file.src);
    const dstPath = join(targetRoot, file.dst);
    const text = readFileSync(srcPath, 'utf8');
    mkdirSync(dirname(dstPath), { recursive: true });
    writeFileSync(dstPath, substitute(text, vars));
  }
  return targetRoot;
}

const HELP_TEXT = `\
jinn create harness <packageName>
jinn create plugin <packageName>

Scaffold a new Jinn package on disk.

Subcommands:
  harness    external Harness package (forecaster / evaluator / alternative-harness)
  plugin     SolverPlugin package (solver-type-plugin / runtime-plugin)

Harness options:
  --pattern=<pattern>     Template pattern (default: forecaster)
                          Supported: forecaster, evaluator, alternative-harness
  --solver-type=<value>   SolverType the Harness handles (default: prediction.v1)
  --network=<network>     Default network (default: base-sepolia)
                          One of: base-mainnet, base-sepolia, sepolia, ethereum-mainnet

Plugin options:
  --pattern=<pattern>     Template pattern (default: solver-type-plugin)
                          Supported: solver-type-plugin, runtime-plugin
  --solver-type=<value>   SolverType this plug-in targets (default: swe-rebench-v2.v1;
                          ignored for runtime-plugin)

Common:
  --out-dir=<path>        Where to write the package (default: cwd)
  --help                  Show this help

Examples:
  jinn create harness @example/forecaster
  jinn create plugin  @example/my-skill
  jinn create plugin  @example/my-runtime --pattern runtime-plugin

Quickstart:
  ${QUICKSTART_URL}
`;

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];
  if (!sub || sub === '--help' || ctx.argv.includes('--help')) {
    ctx.writer.write(HELP_TEXT);
    return;
  }
  if (sub !== 'harness' && sub !== 'plugin') {
    ctx.writer.write(
      `error: unknown subcommand '${sub}' (expected 'harness' or 'plugin')\n`,
    );
    ctx.writer.write(HELP_TEXT);
    ctx.exit(1);
    return;
  }
  const packageName = ctx.argv[1];
  if (!packageName || packageName.startsWith('--')) {
    ctx.writer.write(`error: package name required\n`);
    ctx.writer.write(HELP_TEXT);
    ctx.exit(1);
    return;
  }

  const defaultPattern = sub === 'harness' ? 'forecaster' : 'solver-type-plugin';
  const defaultSolverType = sub === 'harness' ? 'prediction.v1' : 'swe-rebench-v2.v1';

  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv.slice(2),
      options: {
        ...COMMON_FLAGS,
        pattern: { type: 'string' as const, default: defaultPattern },
        'solver-type': { type: 'string' as const, default: defaultSolverType },
        network: { type: 'string' as const, default: 'base-sepolia' },
        'out-dir': { type: 'string' as const },
      },
      allowPositionals: false,
    });
  } catch (err) {
    ctx.writer.write(`error: ${(err as Error).message}\n`);
    ctx.exit(1);
    return;
  }
  const flags = parsed.values;
  const outDir = String(flags['out-dir'] ?? process.cwd());
  const pattern = String(flags.pattern ?? defaultPattern);

  if (sub === 'harness') {
    if (!SUPPORTED_PATTERNS.includes(pattern as HarnessPattern)) {
      ctx.writer.write(
        `error: unsupported --pattern '${pattern}' (supported: ${SUPPORTED_PATTERNS.join(', ')})\n`,
      );
      ctx.exit(1);
      return;
    }
  } else {
    if (!SUPPORTED_PLUGIN_PATTERNS.includes(pattern as PluginPattern)) {
      ctx.writer.write(
        `error: unsupported --pattern '${pattern}' (supported: ${SUPPORTED_PLUGIN_PATTERNS.join(', ')})\n`,
      );
      ctx.exit(1);
      return;
    }
  }

  let target: string;
  try {
    target = await runCreate({
      target: sub,
      pattern: pattern as HarnessPattern | PluginPattern,
      packageName,
      solverTypeString: String(flags['solver-type'] ?? defaultSolverType),
      network: sub === 'harness' ? String(flags.network ?? 'base-sepolia') : undefined,
      outDir,
    });
  } catch (err) {
    ctx.writer.write(`error: ${(err as Error).message}\n`);
    ctx.exit(1);
    return;
  }
  ctx.writer.write(
    `Created ${packageName} at ${target}\n` +
    `Next: cd ${target} && yarn install && yarn test\n` +
    `Quickstart: ${QUICKSTART_URL}\n`,
  );
}

export const createCommand: CommandModule = {
  name: 'create',
  summary: 'Scaffold a new Jinn external harness or SolverPlugin package',
  helpText: HELP_TEXT,
  run,
};

export default createCommand;
