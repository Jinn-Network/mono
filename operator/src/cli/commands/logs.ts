import { parseArgs } from 'node:util';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { Store } from '../../store/store.js';

interface LogLine {
  id: number;
  ts: string;
  level: 'info' | 'error';
  component: 'activity';
  msg: string;
  requestId: string | null;
  serviceIndex: number | null;
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
    .map((line) => `${line.ts.slice(11, 19)} ${line.level} ${line.component} ${line.msg}${line.requestId ? ` req=${line.requestId.slice(0, 10)}…` : ''}${line.txHash ? ` tx=${line.txHash.slice(0, 10)}…` : ''}`)
    .join('\n');
}

function toLogLine(row: ReturnType<Store['getRecentActivityEvents']>[number]): LogLine | null {
  if (!row.ts) return null;
  return {
    id: row.id,
    ts: row.ts,
    level: row.outcome === 'failed' ? 'error' : 'info',
    component: 'activity',
    msg: row.kind,
    requestId: row.requestId,
    serviceIndex: row.serviceIndex,
    txHash: row.txHash,
  };
}

export interface LogsDeps extends BaseCommandDeps {
  storeFactory: (path: string) => Store;
}

const PRODUCTION_DEPS: LogsDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  storeFactory: (path) => new Store(path),
};

export function createLogsCommand(deps: LogsDeps = PRODUCTION_DEPS): CommandModule {
  return {
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
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: {
            limit: { type: 'string', default: '100' },
            json: { type: 'boolean', default: false },
            human: { type: 'boolean', default: false },
            follow: { type: 'boolean', default: false },
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
      const fromVerbFlags = deps.getConfigPathFromArgs(ctx.argv);
      const fromProcess =
        typeof process !== 'undefined' ? deps.getConfigPathFromArgs(process.argv.slice(2)) : undefined;
      const config = deps.loadConfig(fromVerbFlags ?? fromProcess);
      const store = deps.storeFactory(config.dbPath);
      const rows = store.getRecentActivityEvents(limit);
      const events: LogLine[] = rows
        .map(toLogLine)
        .filter((v): v is LogLine => v !== null)
        .sort((a, b) => a.id - b.id);
      const payload: LogsPayload = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        events,
        cursor: { next: null },
      };

      if (Boolean(parsed.values.follow)) {
        let lastSeenId = events.length > 0 ? events[events.length - 1]!.id : 0;
        for (;;) {
          const next = store.getActivityEventsAfterId(lastSeenId, 500);
          for (const row of next) {
            const line = toLogLine(row);
            if (!line) continue;
            lastSeenId = line.id;
            ctx.writer.write(Boolean(parsed.values.human) ? `${humanLogs({ ...payload, events: [line] })}\n` : `${JSON.stringify(line)}\n`);
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      emitResult(payload, (v) => humanLogs(v as LogsPayload), {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      });
    },
  };
}

const command: CommandModule = createLogsCommand();
export default command;
