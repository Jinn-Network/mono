import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleFleetV1 } from '../../api/fleet-build.js';

async function run(ctx: CommandContext): Promise<void> {
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleFleetV1(raw);
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'fleet',
  summary: 'Per-service fleet detail (wallets, staking, rewards, attention)',
  helpText: `Usage: jinn fleet [--json]

Emits the §4.2 fleet shape: master wallet, each service’s agent and
multisig addresses, staking flags, activity counts, and attention hints.

Examples:
  jinn fleet --json
  jinn fleet --json | jq '.services[] | .attention'
`,
  run,
};

export default command;
