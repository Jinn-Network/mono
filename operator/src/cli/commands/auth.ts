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
import { defaultTokenPath, ensureUiToken, rotateUiToken } from '../../api/ui-token.js';

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
  const pairingVerb = ctx.argv[0];
  if (pairingVerb === 'rotate' || pairingVerb === 'token') {
    const rest = ctx.argv.slice(1);
    let json = false;
    let human = false;
    let configPath: string | undefined;
    try {
      const parsed = parseArgs({
        args: rest,
        options: {
          json: { type: 'boolean' },
          human: { type: 'boolean' },
          config: { type: 'string' },
        },
        allowPositionals: false,
      });
      json = Boolean(parsed.values.json);
      human = Boolean(parsed.values.human);
      configPath =
        typeof parsed.values.config === 'string' && parsed.values.config.length > 0
          ? parsed.values.config
          : undefined;
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: `jinn auth ${pairingVerb}`,
          details: { field: 'flags' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    let stateDir: string | undefined;
    try {
      stateDir = loadConfig(configPath).stateDir;
    } catch {
      stateDir = undefined;
    }
    const path = defaultTokenPath(stateDir);
    const token = pairingVerb === 'rotate' ? rotateUiToken(path) : ensureUiToken(path);
    emitResult(
      {
        schemaVersion: 1 as const,
        generatedAt: new Date().toISOString(),
        verb: `auth ${pairingVerb}` as const,
        token,
      },
      () => token,
      {
        json,
        human,
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
    ctx.exit(0);
    return;
  }

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
  summary: 'Pairing and legacy Claude-auth: `jinn auth rotate` / `jinn auth token`, plus runtime mode',
  helpText: `Usage:
  jinn auth rotate [--json] [--human] [--config <path>]
  jinn auth token [--json] [--human] [--config <path>]
  jinn auth [--mode <bare|docker-compose|container>] [--human] [--json] [--config <path>]

Pairing (daemon-down OK):
  rotate   Replace the UI token and print it once.
  token    Print the current UI token, creating one if missing.

Legacy compatibility still supports runtime-mode persistence and Claude login.

Examples:
  jinn auth rotate --json
  jinn auth token
  jinn auth --mode bare --json
`,
  run,
};

export default command;
