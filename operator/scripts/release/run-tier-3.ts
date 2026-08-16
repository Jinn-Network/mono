// operator/scripts/release/run-tier-3.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runT31ProducerEvaluatorReal } from '../../test/release/tier-3/T3.1-producer-evaluator-real.js';
import { type ScenarioVerdict, ScenarioVerdictSchema, exitCodeForVerdicts } from './scenario-types.js';

interface RunOptions {
  outputDir?: string;
  candidateVersion?: string;
  mode?: 'human-invoked' | 'autonomous';
  hermesModel?: string;
}

export async function runTier3(opts: RunOptions = {}): Promise<{ verdicts: ScenarioVerdict[]; allPassed: boolean }> {
  const candidateVersion = opts.candidateVersion ?? 'unknown';
  const mode = opts.mode ?? 'human-invoked';
  const outputDir = opts.outputDir ?? path.join(
    process.cwd(),
    'tier-3-evidence',
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  );
  await fs.mkdir(outputDir, { recursive: true });

  const verdict = await runT31ProducerEvaluatorReal({
    evidencePath: path.join(outputDir, 'T3.1.log'),
    mode,
    hermesModel: opts.hermesModel,
    wallClockBudgetMs: 25 * 60 * 1000,   // real solve (~6 min) + Docker verdict eval — see T3.1 WALL_CLOCK_BUDGET_MS
  });

  ScenarioVerdictSchema.parse(verdict);
  const verdicts = [verdict];
  const allPassed = verdict.verdict === 'pass';

  const summary = {
    candidateVersion,
    timestamp: new Date().toISOString(),
    mode,
    verdicts,
    allPassed,
  };
  await fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const markerLines = [
    '<!-- jinn-release-evidence:v1',
    `release-candidate=${candidateVersion}`,
    `tier-3-t3-1=${verdict.verdict === 'pass' ? 'passed' : `failed:${verdict.failClass}`}`,
    `tier-3-overall=${allPassed ? 'passed' : 'failed'}`,
    '-->',
  ];
  await fs.writeFile(path.join(outputDir, 'marker.txt'), markerLines.join('\n') + '\n');

  return { verdicts, allPassed };
}

async function cliMain(): Promise<void> {
  const candidateVersion = process.argv[2];
  const mode = (process.argv[3] as 'human-invoked' | 'autonomous' | undefined) ?? 'human-invoked';
  const { verdicts, allPassed } = await runTier3({ candidateVersion, mode });
  console.log(JSON.stringify({ verdicts, allPassed }, null, 2));
  process.exit(exitCodeForVerdicts(verdicts));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error('run-tier-3 crashed:', err);
    process.exit(2);
  });
}
