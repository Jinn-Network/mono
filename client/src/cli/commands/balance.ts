import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleBalanceV1 } from '../../api/balance-build.js';

async function run(ctx: CommandContext): Promise<void> {
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleBalanceV1(raw);
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'balance',
  summary: 'Flat per-wallet balance map across master and service wallets',
  helpText: `Usage: jinn balance [--json]

Cheaper than \`jinn fleet\` when the only thing you need is current
balances. Each wallet is identified by its stable role name
(master, service.<i>.agent, service.<i>.multisig).

Examples:
  jinn balance --json
  jinn balance --json | jq '.wallets[] | select(.role == "master")'
`,
  run,
};

export default command;
