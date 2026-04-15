import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleStatusRollupV1 } from '../../api/status-rollup-build.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseCommandArgs(ctx.argv, { ...COMMON_FLAGS });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn status',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleStatusRollupV1(raw);
  emitResult(
    payload,
    (v) => JSON.stringify(v, null, 2),
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

const command: CommandModule = {
  name: 'status',
  summary: 'Daemon liveness + roll-up (poll this for monitoring; pull detail separately)',
  helpText: `Usage: jinn status [--human]

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
  jinn status
  jinn status --human
`,
  run,
};

export default command;
