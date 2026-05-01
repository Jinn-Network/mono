/**
 * `jinn plug-ins {list|add|remove|show}` — operator-facing CLI for managing
 * Path 1 plug-ins (the bundled `claude-code-learner` impl's plug-in
 * surface). Edits `learnerPlugIns[]` in the operator config file with
 * install-time manifest validation.
 *
 * Spec: spec/2026-04-30-plug-in-surface.md §4.4.2.
 * Plan: docs/superpowers/plans/2026-04-30-plug-in-surface-path-1-mechanism.md
 * Task 6.
 *
 * Note the plural `plug-ins` (vs. existing singular `jinn plugin install`,
 * which manages AI-host MCP servers and is unrelated).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { loadPlugInManifest } from '../../restorer/plug-ins/manifest.js';
import type { Slot } from '../../restorer/plug-ins/types.js';

const DEFAULT_CONFIG_PATH = join(homedir(), '.jinn-client', 'config.json');

interface PlugInEntry {
  name: string;
  entry: string;
}

interface ConfigShape {
  learnerPlugIns?: PlugInEntry[];
  [k: string]: unknown;
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

function emitJson(ctx: CommandContext, payload: unknown): void {
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

function emitError(
  ctx: CommandContext,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  emitJson(ctx, { error: { code, message, ...(details ? { details } : {}) } });
  ctx.exit(1);
}

// ---------------------------------------------------------------------------
// Programmatic API (used by tests; mirrors the CLI dispatcher)
// ---------------------------------------------------------------------------

/**
 * Optional prompt injection for testing. Called with a question string,
 * returns the user's answer (or a resolved string for non-interactive paths).
 */
export type PromptFn = (question: string) => Promise<string>;

export interface RunPlugInsArgs {
  argv: readonly string[];
  configPath?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  /** Injectable prompt function. Defaults to readline-based TTY prompt. */
  prompt?: PromptFn;
}

export async function runPlugIns({
  argv,
  configPath = DEFAULT_CONFIG_PATH,
  stdout,
  stderr,
  prompt,
}: RunPlugInsArgs): Promise<number> {
  const out = stdout ?? { write: (s: string) => process.stdout.write(s) };
  const err = stderr ?? { write: (s: string) => process.stderr.write(s) };
  const verb = argv[0];
  if (!existsSync(configPath)) {
    // Initialise a minimal config so list works on a fresh install.
    writeConfig(configPath, { learnerPlugIns: [] });
  }
  switch (verb) {
    case 'list':
      return list(configPath, out);
    case 'add':
      return add(argv.slice(1), configPath, err, prompt);
    case 'remove':
      return remove(argv.slice(1), configPath, err);
    case 'show':
      return show(argv.slice(1), configPath, out, err);
    default:
      err.write(`Usage: jinn plug-ins {list|add|remove|show} ...\n`);
      return 1;
  }
}

function list(
  configPath: string,
  stdout: { write(s: string): void },
): number {
  const cfg = readConfig(configPath);
  const entries = cfg.learnerPlugIns ?? [];
  if (entries.length === 0) {
    stdout.write('No plug-ins installed.\n');
    return 0;
  }
  for (const e of entries) {
    stdout.write(`${e.name}\t${e.entry}\n`);
  }
  return 0;
}

/** Default TTY prompt implementation using readline. */
function defaultPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Non-interactive: return empty string (will be treated as 'n').
      resolve('');
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Slot types that require operator confirmation because they run executable code. */
const EXECUTABLE_SLOT_TYPES = new Set(['mcp-tool', 'memory-backend', 'hook']);

/** Build a human-readable summary of executable slots for the confirmation prompt. */
function summariseExecutableSlots(slots: readonly Slot[]): string {
  const lines: string[] = [];
  for (const slot of slots) {
    if (slot.type === 'mcp-tool') {
      lines.push(`  mcp-tool: ${slot.command} ${slot.args.join(' ')}`);
    } else if (slot.type === 'memory-backend') {
      lines.push(`  memory-backend: ${slot.command} ${slot.args.join(' ')}`);
    } else if (slot.type === 'hook') {
      lines.push(`  hook (${slot.event}): ${slot.entry}`);
    }
  }
  return lines.join('\n');
}

async function add(
  rest: readonly string[],
  configPath: string,
  stderr: { write(s: string): void },
  promptFn?: PromptFn,
): Promise<number> {
  // Parse flags: --yes and --entry <path>, ignore unknown flags gracefully.
  const { values, positionals } = parseArgs({
    args: rest as string[],
    options: {
      entry: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const name = positionals[0];
  if (!name) {
    stderr.write(`error: name required\n`);
    return 1;
  }
  const entry = values.entry as string | undefined;
  if (!entry) {
    stderr.write(`error: --entry <path> required\n`);
    return 1;
  }
  const yes = Boolean(values.yes);
  const absEntry = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);

  let manifest;
  try {
    manifest = await loadPlugInManifest(absEntry);
  } catch (err) {
    stderr.write(`error: invalid plug-in: ${(err as Error).message}\n`);
    return 1;
  }
  if (manifest.name !== name) {
    stderr.write(
      `error: name "${name}" mismatches manifest name "${manifest.name}"\n`,
    );
    return 1;
  }

  // Check for executable slots: mcp-tool, memory-backend, hook.
  const executableSlots = (manifest.slots as readonly Slot[]).filter(
    (s) => EXECUTABLE_SLOT_TYPES.has(s.type),
  );
  if (executableSlots.length > 0) {
    const summary = summariseExecutableSlots(executableSlots);
    stderr.write(
      `warning: plug-in "${name}" declares executable slot(s) that will run on your machine:\n${summary}\n`,
    );
    if (!yes) {
      const ask = promptFn ?? defaultPrompt;
      let answer: string;
      try {
        answer = await ask('Install anyway? [y/N] ');
      } catch {
        answer = '';
      }
      if (!answer.trim().toLowerCase().startsWith('y')) {
        stderr.write(`error: confirmation_required\n`);
        return 1;
      }
    }
  }

  const cfg = readConfig(configPath);
  const next = cfg.learnerPlugIns ?? [];
  if (next.some((e) => e.name === name)) {
    stderr.write(`error: plug-in ${name} already installed\n`);
    return 1;
  }
  next.push({ name, entry: absEntry });
  cfg.learnerPlugIns = next;
  writeConfig(configPath, cfg);
  return 0;
}

async function remove(
  rest: readonly string[],
  configPath: string,
  stderr: { write(s: string): void },
): Promise<number> {
  const name = rest[0];
  if (!name) {
    stderr.write(`error: name required\n`);
    return 1;
  }
  const cfg = readConfig(configPath);
  const list = cfg.learnerPlugIns ?? [];
  const next = list.filter((e) => e.name !== name);
  if (next.length === list.length) {
    stderr.write(`error: plug-in ${name} not installed\n`);
    return 1;
  }
  cfg.learnerPlugIns = next;
  writeConfig(configPath, cfg);
  return 0;
}

async function show(
  rest: readonly string[],
  configPath: string,
  stdout: { write(s: string): void },
  stderr: { write(s: string): void },
): Promise<number> {
  const name = rest[0];
  if (!name) {
    stderr.write(`error: name required\n`);
    return 1;
  }
  const cfg = readConfig(configPath);
  const entry = (cfg.learnerPlugIns ?? []).find((e) => e.name === name);
  if (!entry) {
    stderr.write(`error: plug-in ${name} not installed\n`);
    return 1;
  }
  const manifest = await loadPlugInManifest(entry.entry);
  stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// CommandModule wrapper for cli/index.ts
// ---------------------------------------------------------------------------

const HELP_TEXT = `\
jinn plug-ins <list|add|remove|show> [options]

Manage Path 1 plug-ins for the bundled claude-code-learner impl.
A plug-in declares one or more slot contributions (phase-agent override,
topic explorer, MCP tool, skill bundle, memory backend, hook) via a
\`jinn-plugin.json\` manifest at its package root.

Subcommands:
  list                              Print installed plug-ins
  add <name> --entry <pkg-path>     Validate manifest + append to config
  remove <name>                     Drop the named entry from config
  show <name>                       Print the named plug-in's manifest

Options:
  --config <path>                   Config file (default: ~/.jinn-client/config.json)
  --yes                             Skip confirmation prompt for executable slots
                                    (mcp-tool, memory-backend, hook)

Examples:
  jinn plug-ins list
  jinn plug-ins add @example/news-explorer --entry ./node_modules/@example/news-explorer
  jinn plug-ins add @example/news-explorer --entry ./node_modules/@example/news-explorer --yes
  jinn plug-ins remove @example/news-explorer
  jinn plug-ins show @example/news-explorer
`;

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    ctx.writer.write(HELP_TEXT);
    return;
  }

  // Strip an optional --config <path> from anywhere in argv before passing
  // through to runPlugIns (which uses positional + --entry parsing).
  let configPath = DEFAULT_CONFIG_PATH;
  const filteredArgv: string[] = [];
  for (let i = 0; i < ctx.argv.length; i++) {
    const a = ctx.argv[i];
    if (a === '--config' && i + 1 < ctx.argv.length) {
      configPath = ctx.argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith('--config=')) {
      configPath = a.slice('--config='.length);
      continue;
    }
    filteredArgv.push(a);
  }

  // Route stdout via ctx.writer (structured output shim) and stderr via
  // process.stderr directly so the two streams are not mixed.
  const code = await runPlugIns({
    argv: filteredArgv,
    configPath,
    stdout: { write: (s: string) => ctx.writer.write(s) },
    stderr: { write: (s: string) => process.stderr.write(s) },
  });
  if (code !== 0) {
    // Mirror impls.ts: emit a JSON error envelope on non-zero exit so callers
    // that pipe to jq still see structured output. Keep it minimal — text
    // already went to writer above for human readers.
    ctx.exit(code);
  }
}

const command: CommandModule = {
  name: 'plug-ins',
  summary: 'Manage Path 1 plug-ins for the claude-code-learner impl',
  helpText: HELP_TEXT,
  run,
};

export default command;
