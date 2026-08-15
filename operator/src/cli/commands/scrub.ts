/**
 * `jinn scrub` — eval harness + review CLI (#1968 / #1973).
 *
 * Subcommands:
 * - `bench` — public synthetic + corruption fixtures (+ optional local corpus)
 * - `review` — list / resolve operator-local flag queue
 */

import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { parseArgs } from 'node:util';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  allCiFixtures,
  loadLocalCorpus,
  DEFAULT_LOCAL_CORPUS_PATH,
  runBench,
  listFlagged,
  resolveFlag,
  type BenchReport,
  type ReviewDecision,
} from '@jinn-network/core/scrub';

const SCRUB_OPTIONS = {
  ...COMMON_FLAGS,
  corpus: { type: 'string' as const },
  'ci-only': { type: 'boolean' as const, default: false },
  resolve: { type: 'string' as const },
  decision: { type: 'string' as const },
};

type ScrubParsed = ReturnType<
  typeof parseArgs<{ options: typeof SCRUB_OPTIONS; allowPositionals: true }>
>;

const REVIEW_DECISIONS: readonly ReviewDecision[] = [
  'approve-instance',
  'redact-instance',
  'add-to-allowlist',
  'add-to-identity-pack',
];

function isReviewDecision(value: string): value is ReviewDecision {
  return (REVIEW_DECISIONS as readonly string[]).includes(value);
}

export function createScrubCommand(): CommandModule {
  return {
    name: 'scrub',
    summary: 'Scrub eval + review tooling',
    helpText: `Usage:
  jinn scrub bench [--corpus <path>] [--ci-only] [--json]
  jinn scrub review [--json]
  jinn scrub review --resolve <id> --decision <decision>

Subcommands:
  bench    Run the scrub eval harness (metrics-only JSON)
  review   List pending flag-for-review items, or resolve one

Options (bench):
  --corpus <path>   Operator-local JSONL fixtures (default: ~/.jinn-client/local-corpus/scrub-eval.jsonl)
  --ci-only         Skip the operator-local corpus even if present
  --json            Emit the metrics report as JSON (default for bench)

Options (review):
  --resolve <id>    Resolve a pending flag by id
  --decision <d>    One of: ${REVIEW_DECISIONS.join(' | ')}
  --json            Emit queue items / resolution as JSON

Examples:
  jinn scrub bench
  jinn scrub bench --ci-only
  jinn scrub review
  jinn scrub review --resolve <id> --decision redact-instance
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: SCRUB_OPTIONS,
          allowPositionals: true,
        }) as ScrubParsed;
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      if (parsed.values.help) {
        ctx.writer.write(createScrubCommand().helpText);
        return;
      }

      const sub = parsed.positionals[0] ?? 'bench';
      if (sub === 'bench') {
        await runBenchSubcommand(ctx, parsed);
        return;
      }
      if (sub === 'review') {
        await runReviewSubcommand(ctx, parsed);
        return;
      }

      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown scrub subcommand: ${sub} (expected bench|review)`,
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    },
  };
}

async function runBenchSubcommand(ctx: CommandContext, parsed: ScrubParsed): Promise<void> {
  const ciOnly = parsed.values['ci-only'] as boolean;
  const corpusArg = parsed.values.corpus as string | undefined;

  const fixtures = [...allCiFixtures()];
  let localCount = 0;
  if (!ciOnly) {
    const corpusPath =
      typeof corpusArg === 'string' && corpusArg.length > 0
        ? corpusArg
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
}

async function runReviewSubcommand(ctx: CommandContext, parsed: ScrubParsed): Promise<void> {
  const resolveId =
    typeof parsed.values.resolve === 'string' ? parsed.values.resolve : undefined;
  const decisionRaw =
    typeof parsed.values.decision === 'string' ? parsed.values.decision : undefined;
  const json = parsed.values.json as boolean;

  if (resolveId || decisionRaw) {
    if (!resolveId || !decisionRaw) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: 'review --resolve requires --decision (and vice versa)',
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    if (!isReviewDecision(decisionRaw)) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown decision: ${decisionRaw} (expected ${REVIEW_DECISIONS.join('|')})`,
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    try {
      const updated = resolveFlag(resolveId, decisionRaw);
      ctx.writer.write(`${JSON.stringify(updated, null, 2)}\n`);
    } catch (err) {
      emitEnvelope(
        {
          code: 'fatal',
          message: err instanceof Error ? err.message : String(err),
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    }
    return;
  }

  const pending = listFlagged({ status: 'pending' });
  if (json) {
    ctx.writer.write(`${JSON.stringify(pending, null, 2)}\n`);
    return;
  }
  if (pending.length === 0) {
    ctx.writer.write('No pending scrub review items.\n');
    return;
  }
  for (const item of pending) {
    const span = `${item.finding.class}@${item.finding.span.key}:${item.finding.span.start}-${item.finding.span.end}`;
    ctx.writer.write(
      `${item.id}  ${span}  ${item.finding.confidence}  ${item.context.snippet.replace(/\s+/g, ' ').trim()}\n`,
    );
  }
}

const scrubCommand = createScrubCommand();
export default scrubCommand;
