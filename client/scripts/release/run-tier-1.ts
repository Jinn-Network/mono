import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runT11BootstrapFreshAnvil } from '../../test/release/tier-1/T1.1-bootstrap-fresh-anvil.js';
import { runT12HarnessReadinessContract } from '../../test/release/tier-1/T1.2-harness-readiness-contract.js';
import { runT13ContractConformance } from '../../test/release/tier-1/T1.3-contract-conformance.js';
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
    // Exactly one of 'error' / 'close' settles the Promise. Without the guard,
    // a spawn that fails (e.g. `yarn` not on PATH) emits 'error' but never
    // 'close' — the Promise would hang until CI's 90-min job timeout.
    let settled = false;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', async (err) => {
      if (settled) return;
      settled = true;
      const wallClockMs = Date.now() - started;
      await fs.writeFile(
        evidencePath,
        `=== spawn error ===\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      resolve({
        scenarioId: 'T1.4',
        verdict: 'fail',
        wallClockMs,
        evidencePath,
        failClass: 'flake-infra',
        failNotes: `Playwright spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
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

  // All Tier 1 scenarios run in parallel (spec §3 — tier wall-clock is
  // the max of its scenarios, not the sum). T1.1-T1.3 are in-process callables;
  // T1.4 spawns a Playwright subprocess. Each is wrapped so an unexpected throw
  // (rather than a returned fail verdict) becomes an agent-crash verdict —
  // keeps the scenarioId paired with its runner, no index correlation.
  const callables: { id: string; run: () => Promise<ScenarioVerdict> }[] = [
    {
      id: 'T1.1',
      run: () => runT11BootstrapFreshAnvil({
        evidencePath: path.join(outputDir, 'T1.1.log'),
        wallClockBudgetMs: 90000,
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
      run: () => runT13ContractConformance({
        evidencePath: path.join(outputDir, 'T1.3.log'),
      }),
    },
    {
      // T1.4 needs a separate subprocess (Playwright); runT14SpaRouteSmoke
      // already resolves with a verdict for both spawn-error and close cases.
      id: 'T1.4',
      run: () => runT14SpaRouteSmoke(outputDir),
    },
  ];
  const verdicts = await Promise.all(
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

  // Validate every verdict against the schema (catches contract drift).
  for (const v of verdicts) ScenarioVerdictSchema.parse(v);

  // A `skip` is non-failing — a skipped scenario must not pull a clean run to
  // failed (it surfaces as `passed-with-skips` in the overall status below).
  const hasFailure = verdicts.some((v) => v.verdict === 'fail');
  const hasSkip = verdicts.some((v) => v.verdict === 'skip');
  const allPassed = !hasFailure;

  // Write summary.json
  const summary = {
    candidateVersion: opts.candidateVersion ?? 'unknown',
    timestamp: new Date().toISOString(),
    verdicts,
    allPassed,
  };
  await fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // Maps scenario IDs to the canonical marker keys defined in the release
  // readiness spec §"Marker schema extension" (2026-05-19). The key names are
  // load-bearing — release-readiness parses them — so they are pinned here
  // rather than derived from the scenario ID.
  const MARKER_KEY_BY_SCENARIO: Record<string, string> = {
    'T1.1': 'tier-1-bootstrap',
    'T1.2': 'tier-1-harness-readiness',
    'T1.3': 'tier-1-contract-conformance',
    'T1.4': 'tier-1-spa-route-smoke',
  };

  // Marker block — one `tier-1-<key>=<status>` line per scenario.
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
  // passed-with-skips distinguishes a clean run that had a skipped scenario
  // from a pure all-pass run; both are non-failing for the gate.
  const overall = hasFailure ? 'failed' : hasSkip ? 'passed-with-skips' : 'passed';
  const markerLines: string[] = [
    '<!-- jinn-release-evidence:v1',
    `release-candidate=${opts.candidateVersion ?? 'unknown'}`,
    ...verdicts.map((v) => {
      const key = MARKER_KEY_BY_SCENARIO[v.scenarioId]
        ?? `tier-1-${v.scenarioId.toLowerCase().replace(/\./g, '-')}`;
      return `${key}=${markerValue(v)}`;
    }),
    `tier-1-overall=${overall}`,
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
