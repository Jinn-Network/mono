import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
  loadConfig as defaultLoadConfig,
} from '../../config.js';
import { Store } from '../../store/store.js';
import {
  DEFAULT_PREDICTION_BRIER_SCOREBOARD_WINDOW_DAYS,
  DEFAULT_PREDICTION_SCOREBOARD_REPORT_PATH,
  buildPredictionBrierScoreboard,
  renderPredictionBrierScoreboardMarkdown,
} from '../../corpus/index.js';

interface PredictionScoreboardResult {
  outputPath: string;
  scoredVerdictCount: number;
  distinctTaskCount: number;
  activeOperatorCount: number;
  meanBrierSpread: number | null;
  status: 'ok' | 'insufficient_data';
}

export interface PredictionScoreboardDeps extends BaseCommandDeps {
  storeFactory: (path: string) => Pick<Store, 'queryEnvelopeProjections' | 'close'>;
  writeTextFile: (path: string, content: string) => void;
  nowIso: () => string;
}

const PRODUCTION_DEPS: PredictionScoreboardDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  storeFactory: (path) => new Store(path),
  writeTextFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  },
  nowIso: () => new Date().toISOString(),
};

function humanResult(result: PredictionScoreboardResult): string {
  const spread = result.meanBrierSpread === null ? '-' : result.meanBrierSpread.toFixed(6);
  return [
    `Prediction SolverNet scoreboard written to ${result.outputPath}`,
    `Scored Verdicts: ${result.scoredVerdictCount}`,
    `Shared Tasks: ${result.distinctTaskCount}`,
    `Active operators: ${result.activeOperatorCount}`,
    `Mean Brier spread: ${spread}`,
  ].join('\n');
}

export function createPredictionScoreboardCommand(
  deps: PredictionScoreboardDeps = PRODUCTION_DEPS,
): CommandModule {
  return {
    name: 'prediction-scoreboard',
    summary: 'Render the Prediction SolverNet Brier scoreboard Markdown report',
    helpText: `Usage: jinn prediction-scoreboard [--output <path>] [--as-of <ISO>] [--window-days <N>] [--limit <N>] [--json|--human]

Queries local prediction.v1 envelope projections, computes the trailing Brier
spread scoreboard, and writes a deterministic Markdown report.

Examples:
  jinn prediction-scoreboard --output docs/superpowers/reports/prediction-solvernet-scoreboard.md
  jinn prediction-scoreboard --as-of 2026-05-03T00:00:00.000Z --human
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: {
            ...COMMON_FLAGS,
            output: { type: 'string', default: DEFAULT_PREDICTION_SCOREBOARD_REPORT_PATH },
            'as-of': { type: 'string' },
            'window-days': {
              type: 'string',
              default: String(DEFAULT_PREDICTION_BRIER_SCOREBOARD_WINDOW_DAYS),
            },
            limit: { type: 'string', default: '1000' },
          },
          allowPositionals: false,
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn prediction-scoreboard --output docs/superpowers/reports/prediction-solvernet-scoreboard.md',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const outputPath = parsed.values.output as string;
      const asOfGeneratedAt = parseOptionalAsOf(parsed.values['as-of'] as string | undefined);
      if (asOfGeneratedAt === false) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: '--as-of must be an ISO-8601 timestamp or epoch milliseconds',
            exampleCli: 'jinn prediction-scoreboard --as-of 2026-05-03T00:00:00.000Z',
            details: { field: '--as-of' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const windowDays = parsePositiveInt(parsed.values['window-days'] as string, DEFAULT_PREDICTION_BRIER_SCOREBOARD_WINDOW_DAYS);
      const limit = parsePositiveInt(parsed.values.limit as string, 1000);
      const fromVerbFlags = deps.getConfigPathFromArgs(ctx.argv);
      const fromProcess =
        typeof process !== 'undefined' ? deps.getConfigPathFromArgs(process.argv.slice(2)) : undefined;
      const config = deps.loadConfig(fromVerbFlags ?? fromProcess);
      const store = deps.storeFactory(config.dbPath);

      let result: PredictionScoreboardResult;
      try {
        const scoreboard = buildPredictionBrierScoreboard(store, {
          asOfGeneratedAt: asOfGeneratedAt ?? undefined,
          trailingWindowDays: windowDays,
          projectionQuery: { limit },
        });
        const markdown = renderPredictionBrierScoreboardMarkdown(scoreboard, {
          generatedAtIso: deps.nowIso(),
        });
        deps.writeTextFile(outputPath, markdown);
        result = {
          outputPath,
          scoredVerdictCount: scoreboard.overall.scoredVerdictCount,
          distinctTaskCount: scoreboard.overall.distinctTaskCount,
          activeOperatorCount: scoreboard.overall.activeOperatorCount,
          meanBrierSpread: scoreboard.overall.meanBrierSpread,
          status: scoreboard.overall.scoredVerdictCount === 0 ? 'insufficient_data' : 'ok',
        };
      } finally {
        store.close();
      }

      emitResult(result, (value) => humanResult(value as PredictionScoreboardResult), {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      });
    },
  };
}

function parseOptionalAsOf(value: string | undefined): number | null | false {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : false;
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const command: CommandModule = createPredictionScoreboardCommand();
export default command;
