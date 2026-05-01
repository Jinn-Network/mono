/**
 * `jinn create restorer <pkgName>` — scaffolds a working external
 * restorer impl package on disk. After
 *   cd <pkgName> && yarn install && yarn test
 * the package's tests pass against a synthetic RestorationContext.
 *
 * Spec: `spec/2026-04-30-plug-in-surface.md` §3 (acceptance #4),
 * `spec/2026-04-30-plug-in-surface.md` §3.3.1 (forecaster pattern).
 */

import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';

/**
 * Resolve the templates directory. During development the file lives
 * at `client/src/cli/commands/create.ts`, so `../../../templates`
 * resolves to `client/templates`. After tsc, it lives at
 * `client/dist/cli/commands/create.js`, so the same offset resolves
 * to `client/dist/templates` — we copy templates into dist on build.
 * For robustness we probe both locations.
 */
function resolveTemplatesRoot(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(here, '../../../templates/restorer/'), // src/cli/commands -> client/templates
    join(here, '../../templates/restorer/'),    // dist/cli/commands -> client/templates
    join(here, '../../../../templates/restorer/'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback: first candidate (will surface a clear ENOENT below).
  return candidates[0];
}

const TEMPLATES_ROOT = resolveTemplatesRoot();
const PLUG_IN_TEMPLATES_ROOT = TEMPLATES_ROOT.replace(/restorer\/$/, 'plug-in/');

const NETWORK_CHAIN_IDS: Record<string, number> = {
  'base-mainnet': 8453,
  'base-sepolia': 84532,
  sepolia: 11155111,
  'ethereum-mainnet': 1,
};

export type RestorerPattern = 'forecaster' | 'evaluator' | 'alternative-harness';

export const SUPPORTED_PATTERNS: readonly RestorerPattern[] = [
  'forecaster',
  'evaluator',
  'alternative-harness',
];

export interface RunCreateArgs {
  kind: 'restorer';
  pattern: RestorerPattern;
  packageName: string;
  kindString: string;
  network: string;
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

// ---------------------------------------------------------------------------
// Plug-in scaffolder (`jinn create plug-in`) — Path 1 plug-in templates.
// Spec: spec/2026-04-30-plug-in-surface.md §4.6. One pattern per slot type.
// ---------------------------------------------------------------------------

export type PlugInPattern =
  | 'phase-agent-override'
  | 'topic-explorer'
  | 'mcp-tool'
  | 'skill-bundle'
  | 'memory-backend'
  | 'hook';

export const SUPPORTED_PLUG_IN_PATTERNS: readonly PlugInPattern[] = [
  'phase-agent-override',
  'topic-explorer',
  'mcp-tool',
  'skill-bundle',
  'memory-backend',
  'hook',
];

const PHASE_AGENT_OVERRIDE_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn-plugin.json.tmpl', dst: 'jinn-plugin.json' },
  { src: 'agents/agent.md.tmpl', dst: 'agents/{{phaseAgentName}}.md' },
  { src: 'test/manifest.test.ts.tmpl', dst: 'test/manifest.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const TOPIC_EXPLORER_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn-plugin.json.tmpl', dst: 'jinn-plugin.json' },
  { src: 'agents/explorer.md.tmpl', dst: 'agents/{{topic}}-explorer.md' },
  { src: 'test/manifest.test.ts.tmpl', dst: 'test/manifest.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const MCP_TOOL_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn-plugin.json.tmpl', dst: 'jinn-plugin.json' },
  { src: 'src/server.ts.tmpl', dst: 'src/server.ts' },
  { src: 'test/server.test.ts.tmpl', dst: 'test/server.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const SKILL_BUNDLE_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn-plugin.json.tmpl', dst: 'jinn-plugin.json' },
  {
    src: '.claude-plugin/plugin.json.tmpl',
    dst: '.claude-plugin/plugin.json',
  },
  { src: 'skills/example/SKILL.md.tmpl', dst: 'skills/example/SKILL.md' },
  { src: 'test/manifest.test.ts.tmpl', dst: 'test/manifest.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const MEMORY_BACKEND_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn-plugin.json.tmpl', dst: 'jinn-plugin.json' },
  { src: 'src/server.ts.tmpl', dst: 'src/server.ts' },
  { src: 'test/server.test.ts.tmpl', dst: 'test/server.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const HOOK_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn-plugin.json.tmpl', dst: 'jinn-plugin.json' },
  { src: 'hooks/event.sh.tmpl', dst: 'hooks/{{event}}.sh' },
  { src: 'test/manifest.test.ts.tmpl', dst: 'test/manifest.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

function plugInTemplateFiles(pattern: PlugInPattern): TemplateFile[] {
  switch (pattern) {
    case 'phase-agent-override':
      return PHASE_AGENT_OVERRIDE_FILES;
    case 'topic-explorer':
      return TOPIC_EXPLORER_FILES;
    case 'mcp-tool':
      return MCP_TOOL_FILES;
    case 'skill-bundle':
      return SKILL_BUNDLE_FILES;
    case 'memory-backend':
      return MEMORY_BACKEND_FILES;
    case 'hook':
      return HOOK_FILES;
    default:
      throw new Error(`unsupported plug-in pattern: ${pattern as string}`);
  }
}

export interface RunCreatePlugInArgs {
  kind: 'plug-in';
  pattern: PlugInPattern;
  packageName: string;
  phase?: string;
  agent?: string;
  topic?: string;
  event?: string;
  outDir: string;
}

export async function runCreatePlugIn(
  args: RunCreatePlugInArgs,
): Promise<string> {
  const targetRoot = join(args.outDir, args.packageName);
  const phaseAgentName =
    args.phase && args.agent ? `${args.phase}-${args.agent}` : 'agent';
  const vars: Record<string, string | number> = {
    packageName: args.packageName,
    phase: args.phase ?? '',
    agent: args.agent ?? '',
    topic: args.topic ?? '',
    event: args.event ?? '',
    phaseAgentName,
  };
  for (const file of plugInTemplateFiles(args.pattern)) {
    const srcPath = join(PLUG_IN_TEMPLATES_ROOT, args.pattern, file.src);
    const dstPath = join(targetRoot, substitute(file.dst, vars));
    const text = readFileSync(srcPath, 'utf8');
    mkdirSync(dirname(dstPath), { recursive: true });
    writeFileSync(dstPath, substitute(text, vars));
  }
  return targetRoot;
}

function templateFiles(pattern: RestorerPattern): TemplateFile[] {
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
  if (args.kind !== 'restorer') {
    throw new Error(`unsupported kind: ${args.kind as string}`);
  }
  const networkChainId = NETWORK_CHAIN_IDS[args.network];
  if (networkChainId === undefined) {
    throw new Error(
      `unknown network ${args.network}; known: ${Object.keys(NETWORK_CHAIN_IDS).join(', ')}`,
    );
  }
  const targetRoot = join(args.outDir, args.packageName);
  const vars: Record<string, string | number> = {
    packageName: args.packageName,
    packageNameSlug: packageNameSlug(args.packageName),
    kindString: args.kindString,
    network: args.network,
    networkChainId,
  };

  for (const file of templateFiles(args.pattern)) {
    const srcPath = join(TEMPLATES_ROOT, args.pattern, file.src);
    const dstPath = join(targetRoot, file.dst);
    const text = readFileSync(srcPath, 'utf8');
    mkdirSync(dirname(dstPath), { recursive: true });
    writeFileSync(dstPath, substitute(text, vars));
  }
  return targetRoot;
}

const HELP_TEXT = `\
jinn create <restorer|plug-in> <packageName>

Scaffold a new Jinn package on disk.

Subcommands:
  restorer    Path 2 — external restorer impl (forecaster / evaluator / alternative-harness)
  plug-in     Path 1 — claude-code-learner plug-in (six slot patterns)

Restorer options:
  --pattern=<pattern>     Template pattern (default: forecaster)
                          Supported: forecaster, evaluator, alternative-harness
  --kind=<kindString>     Intent kind the impl handles (default: prediction.v0)
  --network=<network>     Default network (default: base-sepolia)
                          One of: base-mainnet, base-sepolia, sepolia, ethereum-mainnet

Plug-in options:
  --pattern=<pattern>     Slot type (default: phase-agent-override)
                          Supported: phase-agent-override, topic-explorer, mcp-tool,
                          skill-bundle, memory-backend, hook
  --phase=<phase>         For phase-agent-override / topic-explorer / hook
  --agent=<agent>         For phase-agent-override (e.g. step-worker, planner)
  --topic=<topic>         For topic-explorer (kebab-case topic name)
  --event=<event>         For hook (session-start | pre-phase | post-phase | session-end)

Common:
  --out-dir=<path>        Where to write the package (default: cwd)
  --help                  Show this help

Examples:
  jinn create restorer @example/forecaster
  jinn create plug-in @example/calib --pattern=phase-agent-override --phase=execute --agent=step-worker
  jinn create plug-in @example/news --pattern=topic-explorer --phase=orient --topic=news-context
  jinn create plug-in @example/poly --pattern=mcp-tool
  jinn create plug-in @example/skills --pattern=skill-bundle
  jinn create plug-in @example/vec --pattern=memory-backend
  jinn create plug-in @example/precheck --pattern=hook --event=pre-phase --phase=execute
`;

async function run(ctx: CommandContext): Promise<void> {
  // Manual parsing — we want positional: subcommand + packageName.
  const sub = ctx.argv[0];
  if (!sub || sub === '--help' || ctx.argv.includes('--help')) {
    ctx.writer.write(HELP_TEXT);
    return;
  }
  if (sub !== 'restorer' && sub !== 'plug-in') {
    ctx.writer.write(
      `error: unknown subcommand '${sub}' (expected 'restorer' or 'plug-in')\n`,
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

  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv.slice(2),
      options: {
        ...COMMON_FLAGS,
        pattern: {
          type: 'string' as const,
          default: sub === 'plug-in' ? 'phase-agent-override' : 'forecaster',
        },
        kind: { type: 'string' as const, default: 'prediction.v0' },
        network: { type: 'string' as const, default: 'base-sepolia' },
        phase: { type: 'string' as const },
        agent: { type: 'string' as const },
        topic: { type: 'string' as const },
        event: { type: 'string' as const },
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

  if (sub === 'plug-in') {
    const pattern = String(
      flags.pattern ?? 'phase-agent-override',
    ) as PlugInPattern;
    if (!SUPPORTED_PLUG_IN_PATTERNS.includes(pattern)) {
      ctx.writer.write(
        `error: unsupported --pattern '${pattern}' (supported: ${SUPPORTED_PLUG_IN_PATTERNS.join(', ')})\n`,
      );
      ctx.exit(1);
      return;
    }
    let target: string;
    try {
      target = await runCreatePlugIn({
        kind: 'plug-in',
        pattern,
        packageName,
        phase: flags.phase ? String(flags.phase) : undefined,
        agent: flags.agent ? String(flags.agent) : undefined,
        topic: flags.topic ? String(flags.topic) : undefined,
        event: flags.event ? String(flags.event) : undefined,
        outDir,
      });
    } catch (err) {
      ctx.writer.write(`error: ${(err as Error).message}\n`);
      ctx.exit(1);
      return;
    }
    ctx.writer.write(
      `Created ${packageName} at ${target}\nNext: cd ${target} && yarn install && yarn test\n`,
    );
    return;
  }

  const pattern = String(flags.pattern ?? 'forecaster') as RestorerPattern;
  if (!SUPPORTED_PATTERNS.includes(pattern)) {
    ctx.writer.write(
      `error: unsupported --pattern '${pattern}' (supported: ${SUPPORTED_PATTERNS.join(', ')})\n`,
    );
    ctx.exit(1);
    return;
  }

  let target: string;
  try {
    target = await runCreate({
      kind: 'restorer',
      pattern,
      packageName,
      kindString: String(flags.kind ?? 'prediction.v0'),
      network: String(flags.network ?? 'base-sepolia'),
      outDir,
    });
  } catch (err) {
    ctx.writer.write(`error: ${(err as Error).message}\n`);
    ctx.exit(1);
    return;
  }
  ctx.writer.write(
    `Created ${packageName} at ${target}\nNext: cd ${target} && yarn install && yarn test\n`,
  );
}

export const createCommand: CommandModule = {
  name: 'create',
  summary: 'Scaffold a new Jinn external restorer impl package',
  helpText: HELP_TEXT,
  run,
};

export default createCommand;
