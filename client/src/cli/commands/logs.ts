import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import { Store } from '../../store/store.js';

const REF_MS = Date.UTC(2026, 3, 14, 12, 0, 0);

interface LogLine {
  ts: string;
  level: 'info';
  component: 'activity';
  msg: string;
  requestId: string | null;
  txHash: string | null;
}

interface LogsPayload {
  schemaVersion: 1;
  generatedAt: string;
  events: LogLine[];
  cursor: { next: string | null };
}

function humanLogs(payload: LogsPayload): string {
  if (payload.events.length === 0) {
    return 'No events yet.';
  }
  return payload.events
    .map((line) => `${line.ts} ${line.component} ${line.msg} request=${line.requestId}`)
    .join('\n');
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        limit: { type: 'string', default: '100' },
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
  const events: LogLine[] = rows.map((row, i) => ({
    ts: new Date(REF_MS - i * 1000).toISOString(),
    level: 'info',
    component: 'activity',
    msg: row.role,
    requestId: row.requestId,
    txHash: null,
  }));
  const payload: LogsPayload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    events,
    cursor: { next: null },
  };

  emitResult(payload, (v) => humanLogs(v as LogsPayload), {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

const command: CommandModule = {
  name: 'logs',
  summary: 'Structured event log (one JSON object per line)',
  helpText: `Usage: jinn logs [--limit <N>] [--human]

Emits a JSON envelope containing up to N recent rows from the local
activity store. Event entries match the spec §8 log line shape
(\`ts\`, \`level\`, \`component\`, \`msg\`). When the store is empty,
\`events\` is \`[]\` and \`cursor.next\` is \`null\`.

Examples:
  jinn logs --limit 50
  jinn logs --human
`,
  run,
};

export default command;
