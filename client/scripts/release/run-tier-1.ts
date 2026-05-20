import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runT11BootstrapFreshAnvil } from '../../test/release/tier-1/T1.1-bootstrap-fresh-anvil.js';
import { runT12HarnessReadinessContract } from '../../test/release/tier-1/T1.2-harness-readiness-contract.js';
import { runT13IndexerRoundTrip } from '../../test/release/tier-1/T1.3-indexer-round-trip.js';
import { type ScenarioVerdict, ScenarioVerdictSchema, classifyFailure, type FailClass } from './scenario-types.js';

export interface RunTier1Options {
  /** Output directory for evidence. Default: tier-1-evidence/<timestamp>/. */
  outputDir?: string;
  /** Optional release-candidate version for the marker block. */
  candidateVersion?: string;
}

export interface RunTier1Result {
  verdicts: ScenarioVerdict[];
  allPassed: boolean;
  outputDir: string;
}

async function runT14SpaRouteSmoke(outputDir: string): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidencePath = path.join(outputDir, 'T1.4.log');

  return new Promise<ScenarioVerdict>((resolve) => {
    const child = spawn(
      'yarn',
      [
        'playwright',
        'test',
        '--config=playwright.config.ts',
        'test/dashboard/release-prep/spa-route-smoke.e2e.test.ts',
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
        scenarioId: 'T1.4',
        verdict: code === 0 ? 'pass' : 'fail',
        wallClockMs,
        evidencePath,
        failClass,
        failNotes,
      });
    });
  });
}

export async function runTier1(opts: RunTier1Options = {}): Promise<RunTier1Result> {
  const outputDir = opts.outputDir ?? path.join(
    process.cwd(),
    'tier-1-evidence',
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  );
  await fs.mkdir(outputDir, { recursive: true });

  // T1.1-T1.3 callables run in parallel. Each is wrapped so an unexpected
  // throw (rather than a returned fail verdict) becomes an agent-crash verdict
  // — keeps the scenarioId paired with its runner, no index correlation.
  const callables: { id: string; run: () => Promise<ScenarioVerdict> }[] = [
    {
      id: 'T1.1',
      run: () => runT11BootstrapFreshAnvil({
        evidencePath: path.join(outputDir, 'T1.1.log'),
        wallClockBudgetMs: 180000,
      }),
    },
    {
      id: 'T1.2',
      run: () => runT12HarnessReadinessContract({
        evidencePath: path.join(outputDir, 'T1.2.log'),
      }),
    },
    {
      id: 'T1.3',
      run: () => runT13IndexerRoundTrip({
        evidencePath: path.join(outputDir, 'T1.3.log'),
      }),
    },
  ];
  const callableVerdicts = await Promise.all(
    callables.map(async ({ id, run }): Promise<ScenarioVerdict> => {
      try {
        return await run();
      } catch (err) {
        return {
          scenarioId: id,
          verdict: 'fail',
          wallClockMs: 0,
          evidencePath: path.join(outputDir, `${id}.log`),
          failClass: 'agent-crash',
          failNotes: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // T1.4 needs a separate subprocess (Playwright).
  const t14 = await runT14SpaRouteSmoke(outputDir);
  const verdicts = [...callableVerdicts, t14];

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

  // Marker block — one `tier-1-<id>=<status>` line per scenario.
  const markerValue = (v: ScenarioVerdict): string => {
    switch (v.verdict) {
      case 'pass':
        return 'passed';
      case 'skip':
        return `skipped:${v.failNotes ?? 'no-reason'}`;
      case 'fail':
        return `failed:${v.failClass}`;
    }
  };
  const markerLines: string[] = [
    '<!-- jinn-release-evidence:v1',
    `release-candidate=${opts.candidateVersion ?? 'unknown'}`,
    ...verdicts.map((v) => {
      const key = `tier-1-${v.scenarioId.toLowerCase().replace(/\./g, '-')}`;
      return `${key}=${markerValue(v)}`;
    }),
    `tier-1-overall=${allPassed ? 'passed' : 'failed'}`,
    '-->',
  ];
  await fs.writeFile(path.join(outputDir, 'marker.txt'), markerLines.join('\n') + '\n');

  return { verdicts, allPassed, outputDir };
}

async function cliMain(): Promise<void> {
  const candidateVersion = process.argv[2];
  const { verdicts, allPassed, outputDir } = await runTier1({ candidateVersion });
  console.log(JSON.stringify({ verdicts, allPassed, outputDir }, null, 2));

  // Real-bug failures exit 1; flake / skip / agent-crash exit 0
  // (operator decides ship based on classification).
  const hasRealBug = verdicts.some((v) => v.verdict === 'fail' && v.failClass === 'real-bug');
  process.exit(hasRealBug ? 1 : 0);
}

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  cliMain().catch((err) => {
    console.error('run-tier-1 crashed:', err);
    process.exit(2);
  });
}
