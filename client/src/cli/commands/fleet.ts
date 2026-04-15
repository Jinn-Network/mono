import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleFleetV1 } from '../../api/fleet-build.js';

async function run(ctx: CommandContext): Promise<void> {
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
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleFleetV1(raw);
  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

const command: CommandModule = {
  name: 'fleet',
  summary: 'Per-service fleet detail (wallets, staking, rewards, attention)',
  helpText: `Usage: jinn fleet [--human]

Emits the §4.2 fleet shape: master wallet, each service’s agent and
multisig addresses, staking flags, activity counts, and attention hints.

Examples:
  jinn fleet
  jinn fleet --human
`,
  run,
};

export default command;
