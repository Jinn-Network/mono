/**
 * `jinn bootstrap-retry` — CLI front-end over `POST /v1/setup/bootstrap/retry`.
 *
 * The other front-end for `intents/bootstrap-retry.ts` (spec §4.1/§11,
 * §10 composition tier 1). Unlike `jinn bootstrap` (which drives the state
 * machine standalone — daemon down), this verb only means something against
 * an already-running, currently-halted daemon: it can't invoke the intent
 * in-process (see `intents/bootstrap-retry.ts`'s docstring), so it always
 * calls the daemon's own control route over loopback.
 */
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig as defaultLoadConfig, getConfigPathFromArgs as defaultGetConfigPathFromArgs } from '../../config.js';
import { postToDaemon as defaultPostToDaemon } from '../daemon-control-client.js';

interface RetryResponseBody {
  ok: boolean;
  error?: string;
}

export interface BootstrapRetryDeps extends BaseCommandDeps {
  postToDaemon: typeof defaultPostToDaemon;
}

const PRODUCTION_DEPS: BootstrapRetryDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  postToDaemon: defaultPostToDaemon,
};

export function createBootstrapRetryCommand(deps: BootstrapRetryDeps = PRODUCTION_DEPS): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    let json = false;
    let human = false;
    let configPath: string | undefined;
    try {
      const parsed = parseCommandArgs(ctx.argv, { ...COMMON_FLAGS });
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
          hint: 'Run `jinn bootstrap-retry --help` for supported flags.',
          exampleCli: 'jinn bootstrap-retry --json',
          details: { field: 'argv' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = deps.loadConfig(configPath);
    const remote = await deps.postToDaemon<RetryResponseBody>({
      apiPort: config.apiPort,
      path: '/v1/setup/bootstrap/retry',
    });

    if (!remote.reachable) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Could not reach a running daemon on 127.0.0.1:${config.apiPort} (${remote.error ?? 'connection failed'}).`,
          hint: '`jinn bootstrap-retry` only works against a running, halted daemon. Start it with `jinn run`, or use `jinn bootstrap` to drive the state machine standalone.',
          exampleCli: 'jinn run',
          details: { field: 'apiPort', apiPort: config.apiPort },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const body = remote.body ?? { ok: false };
    if (!body.ok) {
      // #2407 L3: a 401 means the ui-token was wrong/missing/rotated — a
      // distinct, actionable cause from "the daemon isn't currently halted,"
      // which is what every OTHER non-ok response means (the route itself
      // never returns ok:false for any other reason — see
      // api/setup-retry-endpoint.ts).
      const isUnauthorized = remote.status === 401;
      emitEnvelope(
        {
          code: 'fatal',
          message: isUnauthorized
            ? 'Daemon returned HTTP 401 Unauthorized.'
            : body.error ?? `Daemon returned HTTP ${remote.status ?? 'unknown'} with no error detail.`,
          hint: isUnauthorized
            ? 'The ui-token (~/.jinn-client/ui-token) did not match what the daemon expects — it may have been rotated. Re-check the token file, or restart the daemon to regenerate it.'
            : 'The daemon may not currently be halted — bootstrap-retry only does something while it is.',
          details: { cause: body.error, status: remote.status },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      verb: 'bootstrap-retry' as const,
      ok: true as const,
    };
    emitResult(
      payload,
      () => 'Retry signaled. Poll `jinn status` or the dashboard to watch bootstrap resume.',
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
    name: 'bootstrap-retry',
    summary: 'Signal a running, halted daemon to retry its bootstrap state machine',
    helpText: `Usage: jinn bootstrap-retry [--human] [--config <path>]

Requires an already-running daemon (this is the CLI twin of the dashboard's
"Retry" button, POST /v1/setup/bootstrap/retry) — it has nothing to do
against a daemon that is not currently halted mid-bootstrap. For a
standalone daemon-down retry, use \`jinn bootstrap\` instead.

Examples:
  jinn bootstrap-retry
  jinn bootstrap-retry --human
`,
    run,
  };
}

const command: CommandModule = createBootstrapRetryCommand();
export default command;
