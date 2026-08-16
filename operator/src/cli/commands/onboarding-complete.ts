/**
 * `jinn onboarding-complete` — CLI front-end over
 * `POST /v1/operator/onboarding-complete` / `intents/onboarding-complete.ts`.
 *
 * Per spec §10 composition's three-tier CLI/store contract: when the daemon
 * is up, mutate via its control route (this also syncs the daemon's live
 * in-memory config — see `intents/onboarding-complete.ts`'s docstring);
 * when it's down, run the intent standalone (safe precisely because the
 * daemon isn't running to race).
 */
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig as defaultLoadConfig, getConfigPathFromArgs as defaultGetConfigPathFromArgs } from '../../config.js';
import { postToDaemon as defaultPostToDaemon } from '../daemon-control-client.js';
import { onboardingCompleteIntent as defaultOnboardingCompleteIntent } from '../../intents/onboarding-complete.js';

interface OnboardingCompleteResponseBody {
  ok: boolean;
  onboardingComplete?: boolean;
  error?: string;
  detail?: string;
}

export interface OnboardingCompleteDeps extends BaseCommandDeps {
  postToDaemon: typeof defaultPostToDaemon;
  onboardingCompleteIntent: typeof defaultOnboardingCompleteIntent;
}

const PRODUCTION_DEPS: OnboardingCompleteDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  postToDaemon: defaultPostToDaemon,
  onboardingCompleteIntent: defaultOnboardingCompleteIntent,
};

export function createOnboardingCompleteCommand(
  deps: OnboardingCompleteDeps = PRODUCTION_DEPS,
): CommandModule {
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
          hint: 'Run `jinn onboarding-complete --help` for supported flags.',
          exampleCli: 'jinn onboarding-complete --json',
          details: { field: 'argv' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = deps.loadConfig(configPath);

    const emitSuccess = (source: 'daemon' | 'standalone'): void => {
      const payload = {
        schemaVersion: 1 as const,
        generatedAt: new Date().toISOString(),
        verb: 'onboarding-complete' as const,
        ok: true as const,
        onboardingComplete: true as const,
        source,
      };
      emitResult(
        payload,
        () => `Onboarding marked complete (${source === 'daemon' ? 'live daemon' : 'config file, daemon not running'}).`,
        {
          json,
          human,
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
      ctx.exit(0);
    };

    // Tier 1: daemon up — mutate via the control route.
    const remote = await deps.postToDaemon<OnboardingCompleteResponseBody>({
      apiPort: config.apiPort,
      path: '/v1/operator/onboarding-complete',
    });
    if (remote.reachable) {
      const body = remote.body ?? { ok: false };
      if (!body.ok) {
        emitEnvelope(
          {
            code: 'fatal',
            message: body.error ?? body.detail ?? `Daemon returned HTTP ${remote.status ?? 'unknown'} with no error detail.`,
            details: { cause: body.error ?? body.detail },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      emitSuccess('daemon');
      return;
    }

    // Tier 2: daemon down — run the intent standalone.
    const result = await deps.onboardingCompleteIntent({ configPath });
    if (!result.ok) {
      emitEnvelope(
        {
          code: 'fatal',
          message: result.error ?? 'Failed to persist onboardingComplete.',
          details: { cause: result.error },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    emitSuccess('standalone');
  }

  return {
    name: 'onboarding-complete',
    summary: 'Mark onboarding complete (daemon control route if running, config file otherwise)',
    helpText: `Usage: jinn onboarding-complete [--human] [--config <path>]

CLI twin of the dashboard's "Enter dashboard" takeover action
(POST /v1/operator/onboarding-complete). If a daemon is running on the
configured apiPort, mutates it live via that route; otherwise writes
onboardingComplete: true directly to the config file, which the daemon
picks up on its next boot.

Examples:
  jinn onboarding-complete
  jinn onboarding-complete --human
`,
    run,
  };
}

const command: CommandModule = createOnboardingCompleteCommand();
export default command;
