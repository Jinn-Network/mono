import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleBalanceV1 } from '../../api/balance-build.js';

async function run(ctx: CommandContext): Promise<void> {
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
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleBalanceV1(raw);
  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

const command: CommandModule = {
  name: 'balance',
  summary: 'Flat per-wallet balance map across master and service wallets',
  helpText: `Usage: jinn balance [--human]

Cheaper than \`jinn fleet\` when the only thing you need is current
balances. Each wallet is identified by its stable role name
(master, service.<i>.agent, service.<i>.multisig).

Examples:
  npx jinn balance
  npx jinn balance --human
`,
  run,
};

export default command;
