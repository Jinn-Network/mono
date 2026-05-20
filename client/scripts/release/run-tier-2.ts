import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runT21CrossOpDonation } from '../../test/release/tier-2/T2.1-cross-op-donation.js';
import { runT22ProducerEvaluator } from '../../test/release/tier-2/T2.2-producer-evaluator.js';
import { type ScenarioVerdict, ScenarioVerdictSchema, classifyFailure, type FailClass } from './scenario-types.js';

export interface RunTier2Options {
  /** Output directory for evidence. Default: tier-2-evidence/<timestamp>/. */
  outputDir?: string;
  /** Optional release-candidate version for the marker block. */
  candidateVersion?: string;
}

export interface RunTier2Result {
  verdicts: ScenarioVerdict[];
  allPassed: boolean;
  outputDir: string;
}

async function runT23MultiOpSpaFlow(outputDir: string): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidencePath = path.join(outputDir, 'T2.3.log');

  return new Promise<ScenarioVerdict>((resolve) => {
    const child = spawn(
      'yarn',
      [
        'playwright',
        'test',
        '--config=playwright.config.ts',
        'test/dashboard/multi-op/launcher-join-flow.e2e.test.ts',
        '--reporter=line',
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', async (code) => {
      const wallClockMs = Date.now() - started;
      await fs.writeFile(
        evidencePath,
        `=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}\n=== exit code ===\n${code}\n`,
      );
      let failClass: FailClass | null = null;
      let failNotes: string | null = null;
      if (code !== 0) {
        failClass = classifyFailure(new Error(stderr || stdout));
        failNotes = `Playwright exited ${code}`;
      }
      resolve({
        scenarioId: 'T2.3',
        verdict: code === 0 ? 'pass' : 'fail',
        wallClockMs,
        evidencePath,
        failClass,
        failNotes,
      });
    });
  });
}

export async function runTier2(opts: RunTier2Options = {}): Promise<RunTier2Result> {
  const outputDir = opts.outputDir ?? path.join(
    process.cwd(),
    'tier-2-evidence',
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  );
  await fs.mkdir(outputDir, { recursive: true });

  // T2.1-T2.2 callables run in parallel. Each descriptor carries its own id and
  // evidence path so the crash-fallback verdict needs no positional bookkeeping.
  const WALL_CLOCK_BUDGET_MS = 5 * 60 * 1000;
  const callables = [
    { id: 'T2.1', run: runT21CrossOpDonation },
    { id: 'T2.2', run: runT22ProducerEvaluator },
  ].map((s) => ({ id: s.id, evidencePath: path.join(outputDir, `${s.id}.log`), run: s.run }));

  const settled = await Promise.allSettled(
    callables.map((s) => s.run({ evidencePath: s.evidencePath, wallClockBudgetMs: WALL_CLOCK_BUDGET_MS })),
  );
  const callableVerdicts: ScenarioVerdict[] = settled.map((result, idx) => {
    if (result.status === 'fulfilled') return result.value;
    const { id, evidencePath } = callables[idx]!;
    return {
      scenarioId: id,
      verdict: 'fail' as const,
      wallClockMs: 0,
      evidencePath,
      failClass: 'agent-crash' as const,
      failNotes: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });

  // T2.3 needs a separate subprocess (Playwright).
  const t23 = await runT23MultiOpSpaFlow(outputDir);
  const verdicts = [...callableVerdicts, t23];

  // Validate every verdict against the schema (catches contract drift).
  for (const v of verdicts) ScenarioVerdictSchema.parse(v);

  const allPassed = verdicts.every((v) => v.verdict === 'pass');

  // Write summary.json
  const summary = {
    candidateVersion: opts.candidateVersion ?? 'unknown',
    timestamp: new Date().toISOString(),
    verdicts,
    allPassed,
  };
  await fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // Marker block
  const markerLines: string[] = [
    '<!-- jinn-release-evidence:v1',
    `release-candidate=${opts.candidateVersion ?? 'unknown'}`,
  ];
  for (const v of verdicts) {
    const key = `tier-2-${v.scenarioId.toLowerCase().replace(/\./g, '-')}`;
    if (v.verdict === 'pass') {
      markerLines.push(`${key}=passed`);
    } else if (v.verdict === 'skip') {
      markerLines.push(`${key}=skipped:${v.failNotes ?? 'no-reason'}`);
    } else {
      markerLines.push(`${key}=failed:${v.failClass}`);
    }
  }
  markerLines.push(`tier-2-overall=${allPassed ? 'passed' : 'failed'}`);
  markerLines.push('-->');
  await fs.writeFile(path.join(outputDir, 'marker.txt'), markerLines.join('\n') + '\n');

  return { verdicts, allPassed, outputDir };
}

async function cliMain(): Promise<void> {
  const candidateVersion = process.argv[2];
  const { verdicts, allPassed, outputDir } = await runTier2({ candidateVersion });
  console.log(JSON.stringify({ verdicts, allPassed, outputDir }, null, 2));

  // Real-bug failures exit 1; flake / skip / agent-crash exit 0
  // (operator decides ship based on classification).
  const hasRealBug = verdicts.some((v) => v.verdict === 'fail' && v.failClass === 'real-bug');
  process.exit(hasRealBug ? 1 : 0);
}

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  cliMain().catch((err) => {
    console.error('run-tier-2 crashed:', err);
    process.exit(2);
  });
}
