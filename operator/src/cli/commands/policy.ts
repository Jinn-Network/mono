/**
 * `jinn policy` — CLI front-end over `intents/policy.ts` and `intents/claim-policy-write.ts`.
 *
 * `jinn policy show` prints the resolved claim policy. `jinn policy set` writes it via the
 * same intent the PUT route uses (daemon-up: control route; daemon-down: config file).
 */
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
  DEFAULT_CONFIG_PATH,
} from '../../config.js';
import { describeClaimPolicyIntent } from '../../intents/policy.js';
import { writeClaimPolicyIntent } from '../../intents/claim-policy-write.js';
import {
  requestDaemon as defaultRequestDaemon,
  type DaemonPostResult,
} from '../daemon-control-client.js';
import { ClaimPolicyConfigSchema, type ClaimPolicyConfig } from '../../config/shape-v2.js';

export interface PolicyCommandDeps extends BaseCommandDeps {
  requestDaemon: typeof defaultRequestDaemon;
  writeClaimPolicyIntent: typeof writeClaimPolicyIntent;
}

const PRODUCTION_DEPS: PolicyCommandDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  requestDaemon: defaultRequestDaemon,
  writeClaimPolicyIntent,
};

const SET_FLAGS = {
  ...COMMON_FLAGS,
  mode: { type: 'string' as const },
  'spend-cap-wei': { type: 'string' as const },
  'ai-unit-cap': { type: 'string' as const },
};

function parseSetPolicy(values: Record<string, unknown>): ClaimPolicyConfig {
  const raw: Record<string, unknown> = {};
  if (typeof values.mode === 'string') raw.mode = values.mode;
  if (typeof values['spend-cap-wei'] === 'string') raw.spendCapWei = values['spend-cap-wei'];
  if (typeof values['ai-unit-cap'] === 'string') {
    raw.aiUnitCap = Number.parseInt(values['ai-unit-cap'], 10);
  }
  const parsed = ClaimPolicyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'claimPolicy'}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

export function createPolicyCommand(deps: Partial<PolicyCommandDeps> = {}): CommandModule {
  const resolved: PolicyCommandDeps = { ...PRODUCTION_DEPS, ...deps };
  async function run(ctx: CommandContext): Promise<void> {
    const [subverb, ...rest] = ctx.argv;
    if (subverb !== 'show' && subverb !== 'set') {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown \`jinn policy\` subverb ${subverb ? `"${subverb}"` : '(none)'}. Use: show | set.`,
          hint: 'Run `jinn policy --help` for usage.',
          exampleCli: 'jinn policy show --json',
          details: { field: 'subverb' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    if (subverb === 'show') {
      let json = false;
      let human = false;
      let configPath: string | undefined;
      try {
        const parsed = parseCommandArgs(rest, { ...COMMON_FLAGS });
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
            hint: 'Run `jinn policy --help` for supported flags.',
            exampleCli: 'jinn policy show --json',
            details: { field: 'argv' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const config = resolved.loadConfig(configPath);
      const result = describeClaimPolicyIntent({ claimPolicy: config.claimPolicy });
      emitResult(
        result,
        (value) => {
          const policy = (value as typeof result).claimPolicy;
          if (policy === null) return 'No claim policy configured (posture: claim nothing).';
          const caps = [
            policy.spendCapWei !== undefined ? `spend cap ${policy.spendCapWei} wei` : undefined,
            policy.aiUnitCap !== undefined ? `AI-unit cap ${policy.aiUnitCap}` : undefined,
          ].filter((line): line is string => line !== undefined);
          return [`Claim policy mode: ${policy.mode}`, ...caps].join('\n');
        },
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

    let json = false;
    let human = false;
    let configPath: string | undefined;
    let claimPolicy: ClaimPolicyConfig;
    try {
      const parsed = parseCommandArgs(rest, SET_FLAGS);
      json = Boolean(parsed.values.json);
      human = Boolean(parsed.values.human);
      configPath =
        typeof parsed.values.config === 'string' && parsed.values.config.length > 0
          ? parsed.values.config
          : undefined;
      claimPolicy = parseSetPolicy(parsed.values as Record<string, unknown>);
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          hint: 'Run `jinn policy set --help` for supported flags.',
          exampleCli: 'jinn policy set --mode every-runnable',
          details: { field: 'argv' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = resolved.loadConfig(configPath);
    const remote: DaemonPostResult<{ restartRequired?: boolean; error?: string }> =
      await resolved.requestDaemon({
        apiPort: config.apiPort,
        path: '/v1/operator/claim-policy',
        method: 'PUT',
        body: { claimPolicy },
      });
    if (remote.reachable) {
      if (remote.status !== 200) {
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
          verb: 'policy set' as const,
          restartRequired: true as const,
          claimPolicy,
          source: 'daemon' as const,
        },
        () => 'Claim policy written (live daemon). Restart required.',
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

    const result = resolved.writeClaimPolicyIntent({
      claimPolicy,
      configPath: configPath ?? DEFAULT_CONFIG_PATH,
    });
    emitResult(
      { ...result, source: 'standalone' as const },
      () => 'Claim policy written to config file (daemon not running). Restart required.',
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
    name: 'policy',
    summary: 'Show or set the resolved claim policy',
    helpText: `Usage:
  jinn policy show [--json] [--human] [--config <path>]
  jinn policy set --mode <claim-nothing|every-runnable|match-legacy-manifest-digest> [--spend-cap-wei <n>] [--ai-unit-cap <n>]

\`set\` writes via PUT /v1/operator/claim-policy when the daemon is up, otherwise
directly to the config file. Always restart-required.

Examples:
  jinn policy show
  jinn policy set --mode every-runnable --ai-unit-cap 5
`,
    run,
  };
}

const command: CommandModule = createPolicyCommand();
export default command;
