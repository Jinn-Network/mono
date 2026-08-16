/**
 * `jinn policy` — CLI front-end over `intents/policy.ts`.
 *
 * Read-only. `jinn policy show` prints the resolved claim policy (config shape v2's
 * `claimPolicy`, spec §9). Per the intent-module law (DR-2026-08-05 decision 3 / headless §4.1)
 * this front-end does config loading + argv parsing + output only; the pure decision lives in the
 * intent module, which takes config in and returns a versioned result out.
 */
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { describeClaimPolicyIntent } from '../../intents/policy.js';

export type PolicyCommandDeps = BaseCommandDeps;

const PRODUCTION_DEPS: PolicyCommandDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
};

export function createPolicyCommand(deps: PolicyCommandDeps = PRODUCTION_DEPS): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    const [subverb, ...rest] = ctx.argv;
    if (subverb !== 'show') {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown \`jinn policy\` subverb ${subverb ? `"${subverb}"` : '(none)'}. Use: show.`,
          hint: 'Run `jinn policy --help` for usage.',
          exampleCli: 'jinn policy show --json',
          details: { field: 'subverb' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

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

    const config = deps.loadConfig(configPath);
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
  }

  return {
    name: 'policy',
    summary: 'Show the resolved claim policy (read-only)',
    helpText: `Usage: jinn policy show [--json] [--human] [--config <path>]

Read-only. Prints the operator's configured claim policy (config shape v2's
\`claimPolicy\`): its predicate mode and any per-claim spend / AI-unit caps.
Mutation stays in the config file (restart-required).

Examples:
  jinn policy show
  jinn policy show --json
`,
    run,
  };
}

const command: CommandModule = createPolicyCommand();
export default command;
