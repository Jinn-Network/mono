import { parseArgs } from 'node:util';
import { formatUnits } from 'viem';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import { gatherIntrospectionRaw as defaultGatherIntrospectionRaw } from '../introspection-context.js';
import { assembleRewardsV1 as defaultAssembleRewardsV1, type RewardsV1Response } from '../../api/rewards-build.js';
import { sumPendingStakingRewards as defaultSumPendingStakingRewards } from '../../api/gather-status.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';

export interface RewardsDeps {
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  assembleRewardsV1: typeof defaultAssembleRewardsV1;
  sumPendingStakingRewards: typeof defaultSumPendingStakingRewards;
}

const PRODUCTION_DEPS: RewardsDeps = {
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  assembleRewardsV1: defaultAssembleRewardsV1,
  sumPendingStakingRewards: defaultSumPendingStakingRewards,
};

function formatRewardAmount(wei: string): string {
  try {
    return `${formatUnits(BigInt(wei), 18)} OLAS`;
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
        ? 'Pending OLAS rewards:'
        : 'Pending OLAS rewards: none yet.',
    );
    for (const s of payload.services) {
      lines.push(`  Service #${s.index}: ${formatRewardAmount(s.pending)} pending · ${formatRewardAmount(s.claimed)} claimed`);
    }
    if (payload.readState === 'error') {
      lines.push(`Reward read unavailable: ${payload.error ?? 'unknown error'}`);
    }
    lines.push('Operator OLAS rewards accrue through staking and can be claimed when pending.');
  }
  lines.push(
    `Last successful claim: ${payload.lastClaimAt ?? 'never'}`,
  );
  lines.push(
    `Last claim tick: ${payload.lastClaimTickAt ?? 'never (daemon not yet run the claim loop)'}`,
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

Returns the current OLAS staking collector claim queue per service. This is
the OLAS staking distributor maintenance path; operator OLAS staking rewards
accumulate via the stOLAS curating-agent rail and are shown in status / the app.

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
      // On-demand staking reward read — kept off the /v1/status hot path (#992).
      // jinn rewards is the sanctioned ops-only surface for the OLAS staking
      // collector queue. Resolve rpcUrl/network from config and read against
      // the fleet that gather-status already loaded into `raw`.
      if (raw.fleet && raw.rpc.ok) {
        const configPath =
          getConfigPathFromArgs(ctx.argv ?? []) ?? getConfigPathFromArgs(process.argv.slice(2));
        try {
          const config = loadConfig(configPath);
          const rpcUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl;
          const pr = await deps.sumPendingStakingRewards(rpcUrl, config.network, raw.fleet);
          if ('sum' in pr) {
            raw.pendingStakingRewardsWei = pr.sum;
            raw.pendingByService = pr.pendingByService;
            if (pr.nextCheckpointAt) raw.nextCheckpointAt = pr.nextCheckpointAt;
          } else {
            raw.pendingStakingRewardsError = pr.error;
          }
        } catch (err) {
          raw.pendingStakingRewardsError = err instanceof Error ? err.message : String(err);
        }
      }
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
