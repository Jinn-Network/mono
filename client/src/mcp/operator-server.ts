/**
 * Operator-level MCP server for jinn-client.
 *
 * Exposes tools that let an external agent (e.g. Claude Desktop) manage a jinn
 * fleet: read status, bootstrap, submit intents, start/stop the daemon.
 *
 * Entry point: `jinn mcp` command.
 *
 * Design: wraps CLI command modules directly (Option B from the research doc).
 * Each command already accepts an injectable { writer, exit } context, so we
 * capture stdout into a string buffer and return it as the MCP tool response.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CommandModule, CommandContext } from '../cli/command.js';

// ── Read-only command imports ───────────────────────────────────────────────
import defaultInitCommand from '../cli/commands/init.js';
import doctorCommand from '../cli/commands/doctor.js';
import fundRequirementsCommand from '../cli/commands/fund-requirements.js';
import statusCommand from '../cli/commands/status.js';
import fleetCommand from '../cli/commands/fleet.js';
import balanceCommand from '../cli/commands/balance.js';
import historyCommand from '../cli/commands/history.js';

// ── Write (mutating) command imports ────────────────────────────────────────
import bootstrapCommand from '../cli/commands/bootstrap.js';
import submitIntentCommand from '../cli/commands/submit-intent.js';
import defaultStopCommand from '../cli/commands/stop.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface CommandRunResult {
  text: string;
  exitCode: number | null;
}

interface McpToolResponse extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

/**
 * Run a CLI CommandModule in-process, capturing its stdout output as a string.
 *
 * The CLI commands call `ctx.exit()` on completion or error. We intercept that
 * with a no-op so the MCP server process is not terminated. The captured text
 * is always the JSON envelope the command writes.
 */
async function runCommandResult(
  command: CommandModule,
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandRunResult> {
  const chunks: string[] = [];
  let exitCode: number | null = null;
  const writer = {
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
  };
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer,
    exit: (code) => { exitCode = code; },
    env,
  };
  await command.run(ctx);
  return { text: chunks.join(''), exitCode };
}

async function runToolCommand(
  command: CommandModule,
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<McpToolResponse> {
  try {
    const result = await runCommandResult(command, argv, env);
    return {
      content: [{ type: 'text' as const, text: result.text }],
      ...(result.exitCode !== null && result.exitCode !== 0 ? { isError: true as const } : {}),
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPidfile(pidPath: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(pidPath)) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

function parseStopCommandNotRunning(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { code?: string; details?: { field?: string } };
    return parsed.code === 'invalid_invocation' && parsed.details?.field === 'daemon_pidfile';
  } catch {
    return false;
  }
}

export async function startDetachedDaemon(env: NodeJS.ProcessEnv): Promise<
  { ok: true; payload: { pid: number | undefined; status: 'already_running' | 'started' | 'starting' } }
  | { ok: false; payload: { status: 'failed'; detail: string } }
> {
  const earningDir =
    env['JINN_EARNING_DIR'] ??
    join(env['HOME'] ?? '.', '.jinn-client', 'earning');
  const pidPath = join(earningDir, 'daemon.pid');

  if (existsSync(pidPath)) {
    try {
      const existingPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      process.kill(existingPid, 0);
      return { ok: true, payload: { pid: existingPid, status: 'already_running' } };
    } catch {
      try {
        unlinkSync(pidPath);
      } catch {
        /* ignore stale pidfile cleanup failures */
      }
    }
  }

  const jinnBinPath = fileURLToPath(new URL('../bin/jinn.js', import.meta.url));
  const child = spawn(process.execPath, [jinnBinPath, 'run'], {
    detached: true,
    stdio: 'ignore',
    env: { ...env },
  });

  const startResult = await Promise.race<
    { status: 'started' | 'starting'; pid: number | undefined } | { status: 'failed'; detail: string }
  >([
    new Promise((resolve) => {
      child.once('error', (err) => {
        resolve({ status: 'failed', detail: err instanceof Error ? err.message : String(err) });
      });
      child.once('exit', (code, signal) => {
        resolve({ status: 'failed', detail: `daemon exited during startup (code=${code ?? 'null'}, signal=${signal ?? 'null'})` });
      });
    }),
    (async () => {
      const pidfileReady = await waitForPidfile(pidPath, 5000);
      return {
        status: pidfileReady ? 'started' as const : 'starting' as const,
        pid: child.pid,
      };
    })(),
  ]);

  child.unref();

  if (startResult.status === 'failed') {
    return { ok: false, payload: { status: 'failed', detail: startResult.detail } };
  }

  return { ok: true, payload: { pid: startResult.pid, status: startResult.status } };
}

export interface StopDetachedDaemonDeps {
  stopCommand?: CommandModule;
}

export async function stopDetachedDaemon(
  env: NodeJS.ProcessEnv,
  deps: StopDetachedDaemonDeps = {},
): Promise<
  { ok: true; payload: Record<string, unknown> } | { ok: false; payload: string }
> {
  const stop = deps.stopCommand ?? defaultStopCommand;
  const result = await runCommandResult(stop, ['--json'], env);
  if (result.exitCode === null || result.exitCode === 0) {
    return { ok: true, payload: JSON.parse(result.text) as Record<string, unknown> };
  }
  if (parseStopCommandNotRunning(result.text)) {
    return { ok: true, payload: { status: 'not_running' } };
  }
  return { ok: false, payload: result.text };
}

// ── Server factory ──────────────────────────────────────────────────────────

export interface OperatorServerDeps {
  initCommand?: CommandModule;
  stopCommand?: CommandModule;
}

export function createOperatorServer(deps: OperatorServerDeps = {}): McpServer {
  const initCommand = deps.initCommand ?? defaultInitCommand;
  const stopCommand = deps.stopCommand ?? defaultStopCommand;
  const server = new McpServer({
    name: 'jinn-operator',
    version: '0.1.0',
  });

  // ━━ Read-only tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool(
    'jinn_init',
    'Create the master wallet and write the encrypted keystore. Idempotent.',
    {},
    async () => runToolCommand(initCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_doctor',
    'Preflight checks: node version, claude binary, keystore, deployment config.',
    {},
    async () => runToolCommand(doctorCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_fund_requirements',
    'List addresses that need funding before bootstrap can advance.',
    {},
    async () => runToolCommand(fundRequirementsCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_status',
    'Daemon liveness and fleet health roll-up. Poll this for monitoring.',
    {},
    async () => runToolCommand(statusCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_fleet',
    'Per-service fleet detail: wallets, staking status, activity counts.',
    {},
    async () => runToolCommand(fleetCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_balance',
    'Flat per-wallet balance map across master and service wallets.',
    {},
    async () => runToolCommand(balanceCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_history',
    'Recent protocol activity: intents, claims, deliveries, evaluations, rewards.',
    {
      limit: z.number().optional().default(50).describe('Max results (default 50)'),
      since: z.string().optional().describe('Only return events after this ISO-8601 timestamp'),
    },
    async ({ limit, since }) => {
      const argv = ['--json', '--limit', String(limit)];
      if (since) argv.push('--since', since);
      return runToolCommand(historyCommand, argv, process.env);
    },
  );

  // ━━ Write (mutating) tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool(
    'jinn_bootstrap',
    'Advance the fleet state machine. Idempotent. May take several minutes. Returns funding_required if wallet needs ETH.',
    {},
    async () => runToolCommand(bootstrapCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_submit_intent',
    'Post a desired state (restoration job) to the protocol. Idempotent by id.',
    {
      id: z.string().describe('Unique intent identifier'),
      description: z.string().describe('Human-readable description of the desired state'),
      dry_run: z.boolean().optional().default(false).describe('Preview without posting on-chain'),
    },
    async ({ id, description, dry_run }) => {
      const argv = ['--id', id, '--description', description, '--json'];
      if (dry_run) argv.push('--dry-run');
      else argv.push('--yes'); // implicit confirmation in MCP context
      return runToolCommand(submitIntentCommand, argv, process.env);
    },
  );

  server.tool(
    'jinn_start_daemon',
    'Start the jinn daemon as a detached background process. Returns the PID.',
    {},
    async () => {
      const result = await startDetachedDaemon(process.env);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.payload),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result.payload),
          },
        ],
      };
    },
  );

  server.tool(
    'jinn_stop_daemon',
    'Stop the running jinn daemon. Idempotent: returns success even if already stopped.',
    {},
    async () => {
      const result = await stopDetachedDaemon(process.env, { stopCommand });
      if (result.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.payload) }] };
      }
      return { content: [{ type: 'text' as const, text: result.payload }], isError: true };
    },
  );

  return server;
}
