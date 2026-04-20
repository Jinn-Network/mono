import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleHistoryV1 } from '../../api/history-build.js';
import { emitEnvelope } from '../../errors/envelope.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        limit: { type: 'string', default: '50' },
        since: { type: 'string' },
        cursor: { type: 'string' },
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
        exampleCli: 'jinn history --limit 50',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const limit = parseInt(parsed.values.limit as string, 10);
  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const payload = assembleHistoryV1(raw, {
    limit: Number.isFinite(limit) ? limit : 50,
    since: parsed.values.since as string | undefined,
    cursor: parsed.values.cursor as string | undefined,
  });
  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

const command: CommandModule = {
  name: 'history',
  summary: 'Recent protocol activity (intents, claims, deliveries, evaluations, rewards)',
  helpText: `Usage: jinn history [--since <ISO-8601>] [--limit <N>] [--human]

Returns recent protocol events from the local activity log. Each
event has a stable \`kind\` enum (intent_posted, request_claimed,
delivery_submitted, evaluation_submitted, reward_claimed, other).

Examples:
  jinn history --limit 20
  jinn history --human
`,
  run,
};

export default command;
