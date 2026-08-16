import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { gatherIntrospectionRaw as defaultGatherIntrospectionRaw } from '../introspection-context.js';
import { assembleFleetV1 as defaultAssembleFleetV1 } from '../../api/fleet-build.js';
import type { FleetV1Response } from '../../api/fleet-build.js';

export interface FleetDeps {
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  assembleFleetV1: typeof defaultAssembleFleetV1;
}

const PRODUCTION_DEPS: FleetDeps = {
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  assembleFleetV1: defaultAssembleFleetV1,
};

function humanFleet(payload: FleetV1Response): string {
  if (payload.services.length === 0) return 'No fleet services found.';
  const lines = ['#  step           serviceId  agentETH      safeETH       safeOLAS      staked  lastEventAt'];
  for (const s of payload.services) {
    lines.push(
      `${String(s.index).padEnd(2)} ${s.step.padEnd(13)} ${String(s.serviceId ?? '-').padEnd(9)} ${s.wallets.agent.balances[0]?.amountWei ?? '0'} ${s.wallets.multisig.balances[0]?.amountWei ?? '0'} ${s.wallets.multisig.balances[1]?.amountWei ?? '0'} ${String(s.staking.staked).padEnd(6)} ${s.activity.lastEventAt ?? '-'}`,
    );
  }
  return lines.join('\n');
}

export function createFleetCommand(deps: FleetDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'fleet',
    summary: 'Per-service fleet detail (wallets, staking, rewards, attention)',
    helpText: `Usage: jinn fleet [--human]

Emits the §4.2 fleet shape: master wallet, each service's agent and
multisig addresses, staking flags, activity counts, and attention hints.

Examples:
  jinn fleet
  jinn fleet --human
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseCommandArgs(ctx.argv, { ...COMMON_FLAGS });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn fleet',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
      const payload = deps.assembleFleetV1(raw);
      emitResult(payload, (v) => humanFleet(v as FleetV1Response), {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      });
    },
  };
}

const command: CommandModule = createFleetCommand();
export default command;
