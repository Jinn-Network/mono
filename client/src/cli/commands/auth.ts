import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  detectAuthContext,
  probeClaudeAuth,
  buildLoginCommand,
  type AuthContext,
} from '../../preflight/claude-auth.js';
import { ConfigLoadError, loadConfig } from '../../config.js';

const CONTEXT_LABELS: Record<string, string> = {
  container: 'inside this container',
  'docker-compose': 'inside the jinn-daemon Docker container',
  bare: 'on this machine',
};

const DEFAULT_CONFIG_PATH = join(homedir(), '.jinn-client', 'config.json');

/**
 * Persist `runtimeMode` into the operator's config file (default:
 * ~/.jinn-client/config.json). Creates the file if absent; merges into
 * existing JSON otherwise. Preserves any unknown keys.
 */
function persistRuntimeMode(mode: AuthContext, configPath: string = DEFAULT_CONFIG_PATH): void {
  let current: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      current = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed existing file — we overwrite rather than merge.
      current = {};
    }
  }
  const envNetwork = process.env['JINN_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet';
  if (current['network'] === undefined) {
    current['network'] = envNetwork;
  }
  const network = current['network'] === 'mainnet' ? 'mainnet' : 'testnet';
  if (current['rpcUrl'] === undefined) {
    current['rpcUrl'] = network === 'testnet'
      ? 'https://base-sepolia-rpc.publicnode.com'
      : 'https://mainnet.base.org';
  }
  current['runtimeMode'] = mode;
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(current, null, 2) + '\n', { encoding: 'utf-8' });
}

/**
 * Interactively prompt the operator for their runtime mode. Uses readline
 * so stdin can be a real TTY. Returns the chosen mode or null if the
 * operator aborts / answers blank.
 */
async function promptRuntimeMode(): Promise<AuthContext | null> {
  process.stderr.write('\nHow do you want to run the Jinn daemon?\n');
  process.stderr.write('  1) bare            — Node directly on host (simplest; Claude auth lives on this machine)\n');
  process.stderr.write('  2) docker-compose  — long-lived operator via the bundled compose file\n');
  process.stderr.write('  3) container       — I run the Jinn image in my own orchestrator\n\n');

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question('Choose [1-3, default=1]: ', (a) => resolve(a.trim()));
    });
    if (answer === '' || answer === '1' || answer.toLowerCase() === 'bare') return 'bare';
    if (answer === '2' || answer.toLowerCase() === 'docker-compose') return 'docker-compose';
    if (answer === '3' || answer.toLowerCase() === 'container') return 'container';
    return null;
  } finally {
    rl.close();
  }
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        json: { type: 'boolean' },
        human: { type: 'boolean' },
        mode: { type: 'string' },
        config: { type: 'string' },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const cwd = process.cwd();
  const configPath =
    typeof parsed.values.config === 'string' && parsed.values.config.length > 0
      ? parsed.values.config
      : undefined;
  const modeFlag = typeof parsed.values.mode === 'string' ? parsed.values.mode : undefined;
  let config: ReturnType<typeof loadConfig> | { runtimeMode?: AuthContext };
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (
      error instanceof ConfigLoadError &&
      error.code === 'config_file_not_found' &&
      modeFlag !== undefined
    ) {
      config = {};
    } else {
      throw error;
    }
  }
  const claudePath =
    'claudePath' in config && typeof config.claudePath === 'string'
      ? config.claudePath
      : 'claude';

  // ── Resolve runtime mode ─────────────────────────────────────────────────
  // Order: --mode flag > config.runtimeMode > (interactive prompt if TTY)
  // > filesystem-based auto-detect (legacy fallback).
  let runtimeMode: AuthContext | undefined;
  if (modeFlag) {
    if (modeFlag !== 'bare' && modeFlag !== 'docker-compose' && modeFlag !== 'container') {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `--mode must be one of bare, docker-compose, container (got ${modeFlag})`,
          exampleCli: 'jinn run',
          details: { field: 'mode' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    runtimeMode = modeFlag;
    persistRuntimeMode(runtimeMode, configPath ?? DEFAULT_CONFIG_PATH);
    process.stderr.write(`[auth] runtime mode set to '${runtimeMode}' (persisted to config).\n`);
  } else if (config.runtimeMode) {
    runtimeMode = config.runtimeMode;
  } else if (ctx.stdoutIsTty) {
    const picked = await promptRuntimeMode();
    if (picked !== null) {
      runtimeMode = picked;
      persistRuntimeMode(runtimeMode, configPath ?? DEFAULT_CONFIG_PATH);
      process.stderr.write(`[auth] runtime mode set to '${runtimeMode}' (persisted).\n\n`);
    }
  }
  // If still unset (non-TTY, no flag, no config), fall through to filesystem detection below.

  const context = detectAuthContext({ cwd, configuredMode: runtimeMode });
  const probe = probeClaudeAuth({ context, cwd, claudePath });

  if (probe.authenticated) {
    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      authenticated: true as const,
      context,
      detail: probe.detail,
      ...(probe.email !== undefined ? { email: probe.email } : {}),
    };
    emitResult(payload, (v) => JSON.stringify(v, null, 2), {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    });
    return;
  }

  // Not authenticated
  if (!ctx.stdoutIsTty) {
    const contextLabel = CONTEXT_LABELS[context] ?? context;
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Claude is not authenticated ${contextLabel}. Run \`jinn run\` and complete setup in the operator app.`,
        exampleCli: 'jinn run',
        details: { field: 'auth', context },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // TTY — prompt and run interactive login
  const contextLabel = CONTEXT_LABELS[context] ?? context;
  process.stderr.write(
    `Claude is not authenticated ${contextLabel}. Starting legacy CLI login…\n`,
  );

  if (context === 'docker-compose') {
    process.stderr.write(
      'A browser URL will appear in the output below. Open it to complete authentication.\n',
    );
  }

  const { command, args } = buildLoginCommand(context, cwd, claudePath);
  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.status !== 0) {
    emitEnvelope(
      {
        code: 'fatal',
        message: `Login command exited with code ${result.status ?? 'null'}.`,
        exampleCli: 'jinn run',
        details: { context },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // Re-probe to verify
  const reProbe = probeClaudeAuth({ context, cwd, claudePath });

  if (reProbe.authenticated) {
    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      authenticated: true as const,
      context,
      detail: reProbe.detail,
      ...(reProbe.email !== undefined ? { email: reProbe.email } : {}),
    };
    emitResult(payload, (v) => JSON.stringify(v, null, 2), {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    });
    return;
  }

  emitEnvelope(
    {
      code: 'fatal',
      message: 'Login completed but Claude is still not authenticated. Run `jinn run` and complete setup in the operator app.',
      exampleCli: 'jinn run',
      details: { context },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'auth',
  summary: 'Legacy compatibility: check Claude authentication and persist daemon runtime mode',
  helpText: `Usage: jinn auth [--mode <bare|docker-compose|container>] [--human] [--json] [--config <path>]

Compatibility command. New operators should install the client and run \`jinn run\`;
the operator app handles Claude auth and runtime setup if needed.

This command still supports two legacy/scripted concerns:

1. Runtime mode — how the operator wants to run the daemon. Persisted to
   config once (so downstream commands don't re-detect by cwd heuristics).
2. Claude authentication — verified; in a TTY this command can still launch
   the legacy interactive login flow if missing.

Runtime-mode resolution order:
  --mode flag          > scripted / CI
  config.runtimeMode   > persisted from app setup or legacy \`jinn auth\`
  interactive prompt   > TTY fallback — asks the operator to pick
  filesystem heuristic > last-resort: container (/.dockerenv) → docker-compose (cwd jinn-daemon compose) → bare

Behaviour:
  - If runtime mode is unset and you're in a TTY, you'll be prompted. The
    answer persists to ~/.jinn-client/config.json (or the --config path).
  - If authenticated → emits JSON result with authenticated:true, context, detail.
  - If not authenticated in non-TTY → emits invalid_invocation (exit 11).
  - If not authenticated in a TTY → runs the appropriate login command.

Flags:
  --mode <m>   Set runtime mode non-interactively (bare | docker-compose | container).
  --config <p> Path to config file (default: ~/.jinn-client/config.json).
  --json       Force JSON output.
  --human      Force human-readable output.

Examples:
  jinn run                           # public first-run path
  jinn auth --mode bare --json       # compatibility: set mode and report auth status
  jinn auth --mode docker-compose --json
`,
  run,
};

export default command;
