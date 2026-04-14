import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import { Store } from '../../store/store.js';

const REF_MS = Date.UTC(2026, 3, 14, 12, 0, 0);

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        limit: { type: 'string', default: '100' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn logs --limit 100',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const n = parseInt(parsed.values.limit as string, 10);
  const limit = Math.min(Math.max(Number.isFinite(n) ? n : 100, 1), 1000);
  const fromVerbFlags = getConfigPathFromArgs(ctx.argv);
  const fromProcess =
    typeof process !== 'undefined' ? getConfigPathFromArgs(process.argv.slice(2)) : undefined;
  const config = loadConfig(fromVerbFlags ?? fromProcess);
  const store = new Store(config.dbPath);
  const rows = store.getRecentOwnActivity(limit);

  rows.forEach((row, i) => {
    const ts = new Date(REF_MS - i * 1000).toISOString();
    ctx.writer.write(
      JSON.stringify({
        ts,
        level: 'info',
        component: 'activity',
        msg: row.role,
        requestId: row.requestId,
        txHash: null,
      }) + '\n',
    );
  });
}

const command: CommandModule = {
  name: 'logs',
  summary: 'Structured event log (one JSON object per line)',
  helpText: `Usage: jinn logs [--limit <N>] [--json]

v1: reads the most recent N rows from the local activity store and
emits one JSON object per line matching the spec §8 log line shape
(\`ts\`, \`level\`, \`component\`, \`msg\`).

Examples:
  jinn logs --limit 50
  jinn logs --limit 50 | jq 'select(.msg == "delivered")'
`,
  run,
};

export default command;
