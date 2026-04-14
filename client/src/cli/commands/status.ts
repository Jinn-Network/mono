import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleStatusRollupV1 } from '../../api/status-rollup-build.js';

async function run(ctx: CommandContext): Promise<void> {
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleStatusRollupV1(raw);
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'status',
  summary: 'Daemon liveness + roll-up (poll this for monitoring; pull detail separately)',
  helpText: `Usage: jinn status [--json]

Emits the §4.1 roll-up: daemon state, RPC reachability, fleet size /
complete / needsAttention counts, pending earnings total, and a
top-level exit hint.

A monitoring loop needs only these fields:
  - rpc.ok
  - fleet.needsAttention
  - exit.blocking

All of (rpc.ok === true && fleet.needsAttention === 0 && exit.blocking === false)
means healthy. Pull \`jinn fleet\` or \`jinn history\` for detail.

Examples:
  jinn status --json
  jinn status --json | jq '.rpc.ok and (.fleet.needsAttention == 0)'
`,
  run,
};

export default command;
