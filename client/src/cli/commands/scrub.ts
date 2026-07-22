/**
 * `jinn scrub bench` — scrub eval harness (#1968).
 *
 * Runs the public synthetic + corruption fixtures (always) and optionally an
 * operator-local labeled corpus. Emits metrics-only JSON (TP/FP/FN, recall,
 * precision, Fβ=2) — never fixture text or spans.
 */

import type { CommandContext, CommandModule } from '../command.js';
import { parseCommandArgs, COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  allCiFixtures,
  loadLocalCorpus,
  DEFAULT_LOCAL_CORPUS_PATH,
  runBench,
  type BenchReport,
} from '@jinn-network/core/scrub';

export function createScrubCommand(): CommandModule {
  return {
    name: 'scrub',
    summary: 'Scrub eval + review tooling',
    helpText: `Usage:
  jinn scrub bench [--corpus <path>] [--ci-only] [--json]

Subcommands:
  bench   Run the scrub eval harness (metrics-only JSON)

Options:
  --corpus <path>   Operator-local JSONL fixtures (default: ~/.jinn-client/local-corpus/scrub-eval.jsonl)
  --ci-only         Skip the operator-local corpus even if present
  --json            Emit the metrics report as JSON (default for bench)

Examples:
  jinn scrub bench
  jinn scrub bench --ci-only
  jinn scrub bench --corpus ~/.jinn-client/local-corpus/scrub-eval.jsonl
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseCommandArgs(ctx.argv, {
          ...COMMON_FLAGS,
          corpus: { type: 'string' },
          'ci-only': { type: 'boolean', default: false },
        });
      } catch (err) {
        emitEnvelope(ctx, {
          ok: false,
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
        });
        ctx.exit(2);
        return;
      }

      if (parsed.values.help) {
        ctx.writer.write(createScrubCommand().helpText);
        return;
      }

      const sub = parsed.positionals[0] ?? 'bench';
      if (sub !== 'bench') {
        emitEnvelope(ctx, {
          ok: false,
          code: 'invalid_invocation',
          message: `Unknown scrub subcommand: ${sub} (expected bench)`,
        });
        ctx.exit(2);
        return;
      }

      const fixtures = [...allCiFixtures()];
      let localCount = 0;
      if (!parsed.values['ci-only']) {
        const corpusPath =
          typeof parsed.values.corpus === 'string' && parsed.values.corpus.length > 0
            ? parsed.values.corpus
            : DEFAULT_LOCAL_CORPUS_PATH;
        const local = loadLocalCorpus(corpusPath);
        localCount = local.length;
        fixtures.push(...local);
      }

      const report: BenchReport & { localFixtures: number; ciFixtures: number } = {
        ...(await runBench(fixtures)),
        ciFixtures: allCiFixtures().length,
        localFixtures: localCount,
      };

      // Always metrics-only JSON for bench (safe to publish / attach to releases).
      ctx.writer.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.corruption.failures > 0) {
        ctx.exit(1);
      }
    },
  };
}

const scrubCommand = createScrubCommand();
export default scrubCommand;
