import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { gatherIntrospectionRaw as defaultGatherIntrospectionRaw } from '../introspection-context.js';
import { assembleBalanceV1 as defaultAssembleBalanceV1 } from '../../api/balance-build.js';
import type { BalanceV1Response } from '../../api/balance-build.js';

export interface BalanceDeps {
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  assembleBalanceV1: typeof defaultAssembleBalanceV1;
}

const PRODUCTION_DEPS: BalanceDeps = {
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  assembleBalanceV1: defaultAssembleBalanceV1,
};

function humanBalance(payload: BalanceV1Response): string {
  const lines = ['role                  address         nativeWei        bondWei'];
  for (const w of payload.wallets) {
    lines.push(
      `${w.role.padEnd(20)} ${(w.address ?? '0x').slice(0, 12).padEnd(12)} ${(w.balances.find((b) => b.asset === 'native')?.amountWei ?? '0').padEnd(15)} ${w.balances.find((b) => b.asset === 'bond')?.amountWei ?? '0'}`,
    );
  }
  return lines.join('\n');
}

export function createBalanceCommand(deps: BalanceDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'balance',
    summary: 'Flat per-wallet balance map across master and service wallets',
    helpText: `Usage: jinn balance [--human]

Cheaper than \`jinn fleet\` when the only thing you need is current
balances. Each wallet is identified by its stable role name
(master, service.<i>.agent, service.<i>.multisig).

Examples:
  jinn balance
  jinn balance --human
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
            exampleCli: 'jinn balance',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
      const payload = deps.assembleBalanceV1(raw);
      emitResult(payload, (v) => humanBalance(v as BalanceV1Response), {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      });
    },
  };
}

const command: CommandModule = createBalanceCommand();
export default command;
