/**
 * `jinn restart` — CLI twin of `POST /api/admin/restart`.
 *
 * Daemon-up: POST the control route with the UI token. Daemon-down: emit
 * `daemon_not_running` (the pidfile stop path is not a restart).
 */
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import {
  requestDaemon as defaultRequestDaemon,
  type DaemonPostResult,
} from '../daemon-control-client.js';

export interface RestartCommandDeps extends BaseCommandDeps {
  requestDaemon: typeof defaultRequestDaemon;
}

const PRODUCTION_DEPS: RestartCommandDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  requestDaemon: defaultRequestDaemon,
};

export function createRestartCommand(deps: Partial<RestartCommandDeps> = {}): CommandModule {
  const resolved: RestartCommandDeps = { ...PRODUCTION_DEPS, ...deps };

  async function run(ctx: CommandContext): Promise<void> {
    let json = false;
    let human = false;
    let configPath: string | undefined;
    let forceRespawn = false;
    try {
      const parsed = parseCommandArgs(ctx.argv, {
        ...COMMON_FLAGS,
        'force-respawn': { type: 'boolean' },
      });
      json = Boolean(parsed.values.json);
      human = Boolean(parsed.values.human);
      forceRespawn = Boolean(parsed.values['force-respawn']);
      configPath =
        typeof parsed.values.config === 'string' && parsed.values.config.length > 0
          ? parsed.values.config
          : undefined;
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          hint: 'Run `jinn restart --help` for usage.',
          exampleCli: 'jinn restart',
          details: { field: 'argv' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = resolved.loadConfig(configPath);
    const remote: DaemonPostResult<{ ok?: boolean; scheduled?: boolean; error?: string }> =
      await resolved.requestDaemon({
        apiPort: config.apiPort,
        path: '/api/admin/restart',
        method: 'POST',
        body: { forceRespawn },
      });

    if (!remote.reachable) {
      emitEnvelope(
        {
          code: 'fatal',
          message: 'No daemon is listening; `jinn restart` cannot start a stopped daemon.',
          hint: 'Run `jinn run` to start the daemon.',
          exampleCli: 'jinn run',
          details: { reason: 'daemon_not_running', cause: remote.error },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    if (remote.status !== 200 || remote.body?.ok !== true) {
      emitEnvelope(
        {
          code: 'fatal',
          message: remote.body?.error ?? `Daemon returned HTTP ${remote.status ?? 'unknown'}.`,
          details: { cause: remote.body?.error },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    emitResult(
      {
        schemaVersion: 1 as const,
        generatedAt: new Date().toISOString(),
        verb: 'restart' as const,
        ok: true as const,
        scheduled: true as const,
      },
      () => 'Daemon restart scheduled.',
      {
        json,
        human,
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
    ctx.exit(0);
  }

  return {
    name: 'restart',
    summary: 'Ask a running daemon to restart via POST /api/admin/restart',
    helpText: `Usage: jinn restart [--force-respawn] [--json] [--human] [--config <path>]

POSTs /api/admin/restart when the daemon is up. When it is down, exits with
daemon_not_running — this is not \`jinn run\`.

Examples:
  jinn restart
  jinn restart --force-respawn --json
`,
    run,
  };
}

const command: CommandModule = createRestartCommand();
export default command;
