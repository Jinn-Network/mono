/**
 * Operator-level MCP server for jinn-client.
 *
 * Exposes tools that let an external agent (e.g. Claude Desktop) manage a jinn
 * fleet: read status, bootstrap, submit Tasks, start/stop the daemon.
 *
 * Entry point: `jinn mcp` command.
 *
 * Design: wraps CLI command modules directly (Option B from the research doc).
 * Each command already accepts an injectable { writer, exit } context, so we
 * capture stdout into a string buffer and return it as the MCP tool response.
 *
 * Mutating tools (`jinn_init`, `jinn_bootstrap`, `jinn_tasks_submit`,
 * `jinn_start_daemon`, `jinn_stop_daemon`) require an explicit `confirm: true`
 * parameter in the tool call. Without `confirm: true` the tool returns a
 * structured `mcp_preview` envelope describing what would happen and the exact
 * follow-up tool call needed to execute (audit finding W2 / `jinn-mono-964.2`).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';
import type { CommandModule, CommandContext } from '../cli/command.js';
import { resolveStoredUiToken } from '../api/ui-token.js';

// ── Read-only command imports ───────────────────────────────────────────────
import defaultInitCommand from '../cli/commands/init.js';
import authCommand from '../cli/commands/auth.js';
import doctorCommand from '../cli/commands/doctor.js';
import fundRequirementsCommand from '../cli/commands/fund-requirements.js';
import statusCommand from '../cli/commands/status.js';
import fleetCommand from '../cli/commands/fleet.js';
import balanceCommand from '../cli/commands/balance.js';
import historyCommand from '../cli/commands/history.js';
import logsCommand from '../cli/commands/logs.js';
import rewardsCommand from '../cli/commands/rewards.js';
import solverNetsCommand from '../cli/commands/solver-nets.js';

// ── Write (mutating) command imports ────────────────────────────────────────
import bootstrapCommand from '../cli/commands/bootstrap.js';
import tasksCommand from '../cli/commands/tasks.js';
import defaultStopCommand from '../cli/commands/stop.js';
import claimRewardsCommand from '../cli/commands/claim-rewards.js';
import defaultRunCommand from '../cli/commands/run.js';
import updateCommand from '../cli/commands/update.js';
import { checkPidfileLiveness } from '../preflight/pidfile-liveness.js';

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

// ── Confirmation / preview envelope ─────────────────────────────────────────

/**
 * Stable shape returned when a mutating MCP tool is invoked without
 * `confirm: true`. Designed for an agent caller: includes the exact follow-up
 * tool name and parameters needed to actually perform the action.
 *
 * `schemaVersion` is bumped if the envelope shape changes in a
 * non-backwards-compatible way (clients should reject unknown versions).
 */
interface McpPreviewEnvelope {
  schemaVersion: 1;
  status: 'preview';
  tool: string;
  description: string;
  effects: string[];
  followUp: {
    tool: string;
    arguments: Record<string, unknown>;
  };
  hint: string;
}

function buildPreviewEnvelope(args: {
  tool: string;
  description: string;
  effects: string[];
  /**
   * Args supplied by the caller (excluding the `confirm` field). The follow-up
   * envelope echoes these back with `confirm: true` filled in so the agent can
   * call the same tool again exactly to mutate.
   */
  callerArgs?: Record<string, unknown>;
}): McpPreviewEnvelope {
  const followUpArgs: Record<string, unknown> = {
    ...(args.callerArgs ?? {}),
    confirm: true,
  };
  return {
    schemaVersion: 1,
    status: 'preview',
    tool: args.tool,
    description: args.description,
    effects: args.effects,
    followUp: {
      tool: args.tool,
      arguments: followUpArgs,
    },
    hint: `This MCP tool mutates state. Re-invoke '${args.tool}' with confirm: true to execute. Returned without performing any action.`,
  };
}

function previewResponse(envelope: McpPreviewEnvelope): McpToolResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
  };
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

  const liveness = checkPidfileLiveness({ pidPath });
  if (liveness.decision === 'refuse') {
    return { ok: true, payload: { pid: liveness.pid, status: 'already_running' } };
  }
  if (liveness.decision === 'unlink-stale') {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore stale pidfile cleanup failures */
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

// ── Live-state helpers (HTTP calls into the running daemon) ─────────────────
//
// The 5 live-state tools below talk to the daemon's HTTP API on the same
// machine (JINN_API_PORT, default 7331). The protected routes (/v1/events/*,
// /v1/bootstrap, /api/admin/*) are gated by `requireUiToken`. The MCP server
// is a child process spawned by the embedded claude session, so it does not
// have the SPA's cookie. It authenticates by reading the UI token from disk
// and sending it as the `x-jinn-ui-token` header (the same middleware accepts
// both forms — see api/handshake.ts).

function uiTokenFromDisk(): string | null {
  return resolveStoredUiToken() ?? null;
}

function authHeaders(): Record<string, string> {
  const t = uiTokenFromDisk();
  return t ? { 'x-jinn-ui-token': t } : {};
}

function apiPort(): number {
  return Number(process.env['JINN_API_PORT'] ?? 7331);
}

// ── Server factory ──────────────────────────────────────────────────────────

export interface OperatorServerDeps {
  initCommand?: CommandModule;
  stopCommand?: CommandModule;
  runCommand?: CommandModule;
  bootstrapCommand?: CommandModule;
  tasksCommand?: CommandModule;
}

export function createOperatorServer(deps: OperatorServerDeps = {}): McpServer {
  const initCommand = deps.initCommand ?? defaultInitCommand;
  const stopCommand = deps.stopCommand ?? defaultStopCommand;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const bootstrapCmd = deps.bootstrapCommand ?? bootstrapCommand;
  const tasksCmd = deps.tasksCommand ?? tasksCommand;
  const server = new McpServer({
    name: 'jinn-operator',
    version: '0.1.0',
  });

  // ━━ Read-only tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool(
    'jinn_auth',
    [
      'Read-only diagnostic: check Claude authentication status and the resolved runtime mode (bare/docker-compose/container).',
      'Does NOT attempt login — it only probes and reports. Do not use this as first-run setup; call jinn_run and complete auth in the app if prompted.',
      'Returns authenticated:true + context + email on success; returns an error envelope if not authenticated.',
      'Fast (<1s).',
    ].join(' '),
    {},
    async () => runToolCommand(authCommand, ['--json', '--mode', 'bare'], process.env),
  );

  server.tool(
    'jinn_doctor',
    'Preflight checks: node version, claude binary, keystore, deployment config. Read-only. Fast (<5s).',
    {},
    async () => runToolCommand(doctorCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_fund_requirements',
    [
      'Read-only: list addresses and amounts that need funding before bootstrap can advance.',
      'Note: the underlying command may hydrate wallet state as a side effect of checking funding.',
      'Returns an array of funding gaps; empty array means all funded.',
    ].join(' '),
    {},
    async () => runToolCommand(fundRequirementsCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_status',
    'Daemon liveness and fleet health roll-up. Read-only. Poll this to monitor progress. Fast (<2s).',
    {},
    async () => runToolCommand(statusCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_fleet',
    'Per-service fleet detail: wallets, staking status, activity counts. Read-only. Fast (<5s).',
    {},
    async () => runToolCommand(fleetCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_balance',
    'Flat per-wallet balance map across master and service wallets. Read-only. Requires RPC. Fast (<5s).',
    {},
    async () => runToolCommand(balanceCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_history',
    'Recent protocol activity: tasks, claims, deliveries, evaluations, rewards. Read-only from local DB. Fast (<2s).',
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

  server.tool(
    'jinn_logs',
    [
      'Recent activity event log from the local SQLite store.',
      'Read-only. Fast (<2s). Returns events with ts, level, component, msg fields.',
      'Call with limit=100 for monitoring; increase for deeper history.',
    ].join(' '),
    {
      limit: z.number().optional().default(100).describe('Max events to return (default 100, max 1000)'),
    },
    async ({ limit }) => {
      const argv = ['--json', '--limit', String(limit)];
      return runToolCommand(logsCommand, argv, process.env);
    },
  );

  server.tool(
    'jinn_rewards',
    [
      'Pending and claimed reward balances per staked service.',
      'Read-only. Requires RPC access. Fast (<5s).',
      'Returns per-service pending/claimed amounts and next checkpoint time.',
    ].join(' '),
    {},
    async () => runToolCommand(rewardsCommand, ['--json'], process.env),
  );

  server.tool(
    'jinn_solver_nets_list',
    'List configured SolverNets with their enabled state. Read-only. Fast (<2s).',
    {},
    async () => runToolCommand(solverNetsCommand, ['list', '--json'], process.env),
  );

  server.tool(
    'jinn_solver_nets_show',
    'Detailed status for one SolverNet. Read-only. Fast (<2s).',
    {
      name: z.string().describe('SolverNet name, e.g. prediction.v1'),
    },
    async ({ name }) => runToolCommand(solverNetsCommand, ['show', name, '--json'], process.env),
  );

  // ━━ Write (mutating) tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //
  // Every tool in this section requires `confirm: true` to mutate state.
  // Without `confirm: true` the tool returns a stable `mcp_preview` envelope
  // describing the planned effects and the exact follow-up tool call to
  // perform the action. This is the agent-visible counterpart of CLI
  // `--dry-run` / `--yes`. See audit finding W2 (jinn-mono-964.2).

  server.tool(
    'jinn_init',
    [
      'MUTATING. Create the master wallet and write the encrypted keystore.',
      'Idempotent: re-runs return the existing master address.',
      'Requires confirm: true; default is preview (no filesystem write).',
    ].join(' '),
    {
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe('Must be true to actually create the keystore. Default false returns a preview.'),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return previewResponse(
          buildPreviewEnvelope({
            tool: 'jinn_init',
            description:
              'Would generate (or load, if present) the master wallet mnemonic and write an encrypted keystore using JINN_PASSWORD.',
            effects: [
              'Writes encrypted mnemonic keystore under the configured earning directory if absent.',
              'Writes master_address into the fleet-state JSON.',
              'Reads JINN_PASSWORD (or --password-fd) from the daemon environment.',
            ],
          }),
        );
      }
      return runToolCommand(initCommand, ['--json'], process.env);
    },
  );

  server.tool(
    'jinn_run',
    [
      'MUTATING: Run the Jinn daemon end-to-end. Initializes the keystore (if missing),',
      'bootstraps the fleet (with funding poll), and starts the daemon loops.',
      'Idempotent — safe to call repeatedly; resumes from the last completed step.',
      'Long-running: can take up to 30 minutes if funding is required.',
      'Returns a progress stream via --json-progress; poll jinn_status to monitor after this returns.',
      'Use no_daemon=true to exit after bootstrap (useful for CI or when the daemon is managed separately).',
      'Requires confirm: true; default is preview (no mutation).',
    ].join(' '),
    {
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe('Must be true to actually start the run flow. Default false returns a preview.'),
      no_daemon: z.boolean().optional().default(false).describe('Stop after bootstrap; do not start the daemon'),
      funding_timeout: z
        .string()
        .optional()
        .describe("Bound the wait when the wallet needs funding. Accepts '30s', '15m', '1h', or 'none'."),
    },
    async ({ confirm, no_daemon, funding_timeout }) => {
      if (!confirm) {
        return previewResponse(
          buildPreviewEnvelope({
            tool: 'jinn_run',
            description:
              'Would init the keystore (if missing), bootstrap the fleet, and start the daemon loops end-to-end.',
            effects: [
              'May write the encrypted keystore and an auto-generated keystore-password file.',
              'Advances the bootstrap state machine: Safe deployment, OLAS service registration, staking, mech.',
              'May post on-chain transactions and request testnet faucet funds.',
              'Starts long-lived daemon loops unless no_daemon=true.',
            ],
            callerArgs: {
              ...(no_daemon ? { no_daemon: true } : {}),
              ...(funding_timeout ? { funding_timeout } : {}),
            },
          }),
        );
      }
      const argv = ['--json', '--json-progress'];
      if (no_daemon) argv.push('--no-daemon');
      if (funding_timeout) argv.push('--funding-timeout', funding_timeout);
      return runToolCommand(runCommand, argv, process.env);
    },
  );

  server.tool(
    'jinn_bootstrap',
    [
      'MUTATING. Advance the fleet state machine. Idempotent.',
      'May take several minutes; can post on-chain transactions and request testnet faucet funds.',
      'Returns funding_required if a wallet needs ETH.',
      'Requires confirm: true; default is preview (no chain or filesystem mutation).',
    ].join(' '),
    {
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe('Must be true to actually run the bootstrap state machine. Default false returns a preview.'),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return previewResponse(
          buildPreviewEnvelope({
            tool: 'jinn_bootstrap',
            description:
              'Would advance the fleet bootstrap state machine from its current step toward a complete, runnable state.',
            effects: [
              'May deploy/activate Safes and OLAS services on-chain (gas-paying).',
              'May request testnet faucet funds.',
              'May update local fleet-state JSON and keystore files.',
            ],
          }),
        );
      }
      return runToolCommand(bootstrapCmd, ['--json'], process.env);
    },
  );

  server.tool(
    'jinn_tasks_submit',
    [
      'MUTATING. Post a Task to the protocol.',
      'Idempotent by id. Sends an on-chain transaction and pays gas when confirmed.',
      'Requires confirm: true; default is preview (uses CLI --dry-run, no on-chain action).',
    ].join(' '),
    {
      id: z.string().describe('Unique Task identifier'),
      description: z.string().describe('Human-readable Task description'),
      solver_net: z.string().optional().default('prediction').describe('SolverNet name, default prediction'),
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe('Must be true to actually submit on-chain. Default false returns a preview using --dry-run.'),
    },
    async ({ id, description, solver_net, confirm }) => {
      const argv = ['submit', '--id', id, '--description', description, '--solver-net', solver_net, '--json'];
      if (!confirm) {
        argv.push('--dry-run');
        // Run the underlying command in --dry-run so the preview includes the
        // CLI's own plan output, then wrap it in our MCP preview envelope by
        // reusing the dry-run JSON payload as the description body.
        const result = await runCommandResult(tasksCmd, argv, process.env);
        const envelope = buildPreviewEnvelope({
          tool: 'jinn_tasks_submit',
          description: `Would post Task '${id}' on-chain using the configured creator Safe.`,
          effects: [
            'Posts a SignedTaskV1 to IPFS via the configured registry.',
            'Calls JinnRouterV3.createTask (gas-paying transaction).',
            'Idempotent by --id from the same creator Safe.',
          ],
          callerArgs: { id, description, solver_net },
        });
        const merged = {
          ...envelope,
          cliDryRun: safeJsonParse(result.text),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(merged) }],
          ...(result.exitCode !== null && result.exitCode !== 0
            ? { isError: true as const }
            : {}),
        };
      }
      argv.push('--yes');
      return runToolCommand(tasksCmd, argv, process.env);
    },
  );

  server.tool(
    'jinn_claim_rewards',
    [
      'MUTATING. Pull pending protocol rewards to the fleet multisigs.',
      'Idempotent: zero-delta exits 0.',
      'Requires confirm: true; default is preview (uses CLI --dry-run, no on-chain action).',
    ].join(' '),
    {
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe('Must be true to actually claim on-chain. Default false returns a preview using --dry-run.'),
    },
    async ({ confirm }) => {
      if (!confirm) {
        const result = await runCommandResult(claimRewardsCommand, ['--dry-run', '--json'], process.env);
        const envelope = buildPreviewEnvelope({
          tool: 'jinn_claim_rewards',
          description: 'Would pull pending protocol rewards to the fleet multisigs.',
          effects: [
            'Submits claim transactions on-chain (gas-paying).',
            'No-op if there are no pending rewards.',
          ],
        });
        const merged = {
          ...envelope,
          cliDryRun: safeJsonParse(result.text),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(merged) }],
          ...(result.exitCode !== null && result.exitCode !== 0
            ? { isError: true as const }
            : {}),
        };
      }
      return runToolCommand(claimRewardsCommand, ['--yes', '--json'], process.env);
    },
  );

  server.tool(
    'jinn_update',
    [
      'MUTATING: Update the client package and refresh host integrations.',
      'Step 1: npm update -g @jinn-network/client',
      'Step 2: jinn integrations install (refreshes skills in all configured AI tools).',
      'May take 1-2 minutes. Use skip_npm=true to only refresh integrations with the current version.',
    ].join(' '),
    {
      skip_npm: z.boolean().optional().default(false).describe('Skip the npm update step'),
      skip_plugins: z.boolean().optional().default(false).describe('Skip the integrations refresh step'),
    },
    async ({ skip_npm, skip_plugins }) => {
      const argv = ['--json'];
      if (skip_npm) argv.push('--skip-npm');
      if (skip_plugins) argv.push('--skip-plugins');
      return runToolCommand(updateCommand, argv, process.env);
    },
  );

  server.tool(
    'jinn_start_daemon',
    [
      'MUTATING. Start the jinn daemon as a detached background process.',
      'Spawns a long-lived child process and writes a pidfile.',
      'Requires confirm: true; default is preview (does not spawn a process).',
    ].join(' '),
    {
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe('Must be true to actually start the daemon. Default false returns a preview.'),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return previewResponse(
          buildPreviewEnvelope({
            tool: 'jinn_start_daemon',
            description:
              'Would spawn the jinn daemon as a detached child process running `jinn run`.',
            effects: [
              'Spawns a detached node child process.',
              'Writes a pidfile under the earning directory.',
              'Daemon will poll RPC, post and claim deliveries, and may pay gas.',
            ],
          }),
        );
      }
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
    [
      'MUTATING. Stop the running jinn daemon.',
      'Idempotent: returns success even if already stopped.',
      'Requires confirm: true; default is preview (does not signal any process).',
    ].join(' '),
    {
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe('Must be true to actually stop the daemon. Default false returns a preview.'),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return previewResponse(
          buildPreviewEnvelope({
            tool: 'jinn_stop_daemon',
            description: 'Would send a stop signal to the running jinn daemon, if any.',
            effects: [
              'Reads the daemon pidfile under the earning directory.',
              'Sends SIGTERM to the daemon process.',
              'Removes the pidfile on graceful exit.',
            ],
          }),
        );
      }
      const result = await stopDetachedDaemon(process.env, { stopCommand });
      if (result.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.payload) }] };
      }
      return { content: [{ type: 'text' as const, text: result.payload }], isError: true };
    },
  );

  // ━━ Live-state tools (HTTP into the running daemon) ━━━━━━━━━━━━━━━━━━━━━━
  //
  // Unlike the read-only and write tools above, which run CLI command modules
  // in-process, these tools call the daemon's HTTP API directly. They require
  // the daemon to be running. Auth uses the UI token loaded from
  // ~/.jinn-client/ui-token sent in the `x-jinn-ui-token` header.

  server.tool(
    'activity_list',
    'List recent structured daemon events. Filter by kinds: intent, reward, fleet, system, error, log.',
    {
      kinds: z.array(z.enum(['intent', 'reward', 'fleet', 'system', 'error', 'log'])).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async ({ kinds, limit }) => {
      const port = apiPort();
      const q = new URLSearchParams();
      if (kinds && kinds.length > 0) q.set('kinds', kinds.join(','));
      if (limit !== undefined) q.set('limit', String(limit));
      const url = `http://127.0.0.1:${port}/v1/events/recent?${q.toString()}`;
      try {
        const res = await fetch(url, { headers: authHeaders() });
        const body = (await res.json()) as { events: unknown[] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'bootstrap_state',
    'Get the current bootstrap state machine: mode (setup|running|uninitialized), current step, services, master address, chain.',
    {},
    async () => {
      const port = apiPort();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/bootstrap`, { headers: authHeaders() });
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'daemon_restart',
    'Request a daemon restart. Requires confirm=true. The daemon will shut down gracefully and the process will exit; the supervising shell or systemd unit must restart it.',
    { confirm: z.boolean().optional() },
    async ({ confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                preview: 'would request daemon shutdown',
                confirm_with: 'daemon_restart with confirm=true',
              }),
            },
          ],
        };
      }
      const port = apiPort();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/admin/restart`, {
          method: 'POST',
          headers: authHeaders(),
        });
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'loop_pause',
    'Pause a daemon loop by name (creator | engine_watcher | engine_tick | delivery_watcher | reward_claim | balance_topup | jinn_claim | peer_sync). NOTE: stubbed in v1-Slim; returns not_implemented.',
    {
      loop: z.string(),
      confirm: z.boolean().optional(),
    },
    async ({ loop, confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                preview: `would pause loop=${loop}`,
                confirm_with: `loop_pause with confirm=true and loop=${loop}`,
              }),
            },
          ],
        };
      }
      const port = apiPort();
      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/admin/loop/${encodeURIComponent(loop)}/pause`,
          { method: 'POST', headers: authHeaders() },
        );
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'loop_resume',
    'Resume a previously-paused daemon loop. NOTE: stubbed in v1-Slim; returns not_implemented.',
    {
      loop: z.string(),
      confirm: z.boolean().optional(),
    },
    async ({ loop, confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                preview: `would resume loop=${loop}`,
                confirm_with: `loop_resume with confirm=true and loop=${loop}`,
              }),
            },
          ],
        };
      }
      const port = apiPort();
      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/admin/loop/${encodeURIComponent(loop)}/resume`,
          { method: 'POST', headers: authHeaders() },
        );
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
