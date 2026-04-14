import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleRewardsV1 } from '../../api/rewards-build.js';

async function run(ctx: CommandContext): Promise<void> {
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleRewardsV1(raw);
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'rewards',
  summary: 'Earned vs claimed per service, per asset; next checkpoint time',
  helpText: `Usage: jinn rewards [--json]

Returns the current pending reward balance per service, per asset
role. Uses \`reward\` as the asset name; look up the concrete token
in \`jinn version\`.

Examples:
  jinn rewards --json
  jinn rewards --json | jq '.services[] | .pending'
`,
  run,
};

export default command;
