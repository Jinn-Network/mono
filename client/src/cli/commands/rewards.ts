import { parseArgs } from 'node:util';
import { formatUnits } from 'viem';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import { gatherIntrospectionRaw as defaultGatherIntrospectionRaw } from '../introspection-context.js';
import { assembleRewardsV1 as defaultAssembleRewardsV1, type RewardsV1Response } from '../../api/rewards-build.js';

export interface RewardsDeps {
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  assembleRewardsV1: typeof defaultAssembleRewardsV1;
}

const PRODUCTION_DEPS: RewardsDeps = {
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  assembleRewardsV1: defaultAssembleRewardsV1,
};

function formatRewardAmount(wei: string): string {
  try {
    // stOLAS / JINN / OLAS all use 18 decimals. This command reports the
    // staking collector queue, not spendable operator tJINN.
    return `${formatUnits(BigInt(wei), 18)} collector-token`;
  } catch {
    return `${wei} wei`;
  }
}

function humanRewards(payload: RewardsV1Response): string {
  const lines: string[] = [];
  if (payload.services.length === 0) {
    lines.push('No services staked yet. Run `jinn bootstrap` to stake one.');
  } else {
    const anyPending = payload.services.some((s) => s.pending !== '0');
    lines.push(
      anyPending
        ? 'Pending staking collector claims:'
        : 'Pending staking collector claims: none yet.',
    );
    for (const s of payload.services) {
      lines.push(`  Service #${s.index}: ${formatRewardAmount(s.pending)} pending · ${formatRewardAmount(s.claimed)} claimed`);
    }
    lines.push('Operator tJINN/JINN earnings are reported from the Sepolia tJINN Safe balance, not this collector queue.');
  }
  lines.push(
    `Last claim tick: ${payload.lastClaimAt ?? 'never (daemon not yet run the claim loop)'}`,
  );
  lines.push(
    `Next checkpoint: ${payload.nextCheckpointAt ?? 'not reported by the staking contract'}`,
  );
  return lines.join('\n');
}

export function createRewardsCommand(deps: RewardsDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'rewards',
    summary: 'Staking collector queue per service; next checkpoint time',
    helpText: `Usage: jinn rewards [--human]

Returns the current staking collector claim queue per service. This is
the OLAS-style distributor maintenance path; operator tJINN/JINN earnings
are the Sepolia tJINN Safe balance shown in status / the app.

Examples:
  jinn rewards
  jinn rewards --human
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: {
            json: { type: 'boolean', default: false },
            human: { type: 'boolean', default: false },
            config: { type: 'string' },
          },
          allowPositionals: false,
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn rewards',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
      const payload = deps.assembleRewardsV1(raw);
      emitResult(payload, (v) => humanRewards(v as RewardsV1Response), {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      });
    },
  };
}

const command: CommandModule = createRewardsCommand();
export default command;
