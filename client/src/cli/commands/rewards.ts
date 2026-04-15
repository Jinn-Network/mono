import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleRewardsV1 } from '../../api/rewards-build.js';

async function run(ctx: CommandContext): Promise<void> {
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
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleRewardsV1(raw);
  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

const command: CommandModule = {
  name: 'rewards',
  summary: 'Earned vs claimed per service, per asset; next checkpoint time',
  helpText: `Usage: jinn rewards [--human]

Returns the current pending reward balance per service, per asset
role. Uses \`reward\` as the asset name; look up the concrete token
in \`jinn version\`.

Examples:
  jinn rewards
  jinn rewards --human
`,
  run,
};

export default command;
