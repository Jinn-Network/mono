import { parseArgs } from 'node:util';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import {
  gatherIntrospectionRaw as defaultGatherIntrospectionRaw,
} from '../introspection-context.js';
import {
  assembleHistoryV1 as defaultAssembleHistoryV1,
} from '../../api/history-build.js';
import { emitEnvelope } from '../../errors/envelope.js';
import type { HistoryV1Response } from '../../api/history-build.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { Store } from '../../store/store.js';

function humanHistory(payload: HistoryV1Response): string {
  if (payload.events.length === 0) return 'No history events yet.';
  const lines = ['TIME      KIND                 SVC  REQUEST      TX'];
  for (const e of payload.events) {
    lines.push(
      `${e.at.slice(11, 19)}  ${e.kind.padEnd(20)}  ${String(e.serviceIndex).padEnd(3)}  ${(e.taskId ?? '-').slice(0, 10)}  ${(e.txHash ?? '-').slice(0, 10)}`,
    );
  }
  return lines.join('\n');
}

export interface HistoryDeps extends BaseCommandDeps {
  storeFactory: (path: string) => Store;
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  assembleHistoryV1: typeof defaultAssembleHistoryV1;
}

const PRODUCTION_DEPS: HistoryDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  storeFactory: (path) => new Store(path),
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  assembleHistoryV1: defaultAssembleHistoryV1,
};

export function createHistoryCommand(deps: HistoryDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'history',
    summary: 'Recent protocol activity (Tasks, claims, deliveries, evaluations, rewards)',
    helpText: `Usage: jinn history [--since <ISO-8601>] [--limit <N>] [--human]

Returns recent protocol events from the local activity log. Each
event has a stable \`kind\` enum (task_posted, request_claimed,
delivery_submitted, evaluation_submitted, reward_claimed, other).

Examples:
  jinn history --limit 20
  jinn history --human
`,
    async run(ctx: CommandContext): Promise<void> {
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
      const n = parseInt(parsed.values.limit as string, 10);
      const effLimit = Math.min(Math.max(Number.isFinite(n) ? n : 50, 1), 500);
      const fromVerbFlags = deps.getConfigPathFromArgs(ctx.argv);
      const fromProcess =
        typeof process !== 'undefined' ? deps.getConfigPathFromArgs(process.argv.slice(2)) : undefined;
      const config = deps.loadConfig(fromVerbFlags ?? fromProcess);
      const store = deps.storeFactory(config.dbPath);
      const since = parsed.values.since as string | undefined;
      const cursor = parsed.values.cursor as string | undefined;
      const fromStore = store.getRecentActivityEvents(effLimit, { since, cursor });
      const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
      const payload = deps.assembleHistoryV1(
        raw,
        {
          limit: effLimit,
          since,
          cursor,
        },
        fromStore,
      );
      emitResult(payload, (v) => humanHistory(v as HistoryV1Response), {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      });
    },
  };
}

const command: CommandModule = createHistoryCommand();
export default command;
