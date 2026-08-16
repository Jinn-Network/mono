import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runT22ProducerEvaluator } from '../../test/release/tier-2/T2.2-producer-evaluator.js';
import { runT24ProducerEvaluatorSweRebench } from '../../test/release/tier-2/T2.4-producer-evaluator-swe-rebench.js';
import { type ScenarioVerdict, ScenarioVerdictSchema, exitCodeForVerdicts } from './scenario-types.js';

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

// NOTE: T2.3 (the launcher-join multi-op SPA flow) was removed from this gate.
// It was a browser E2E driven against a LIVE Anvil fork + live daemons — a
// non-deterministic shape that is neither hermetic nor real-testnet, and it
// flaked on multiple independent legs (launch stall, cumulative-budget, the
// op-a Onboarding re-gate). Its per-leg behaviour is already covered
// deterministically (launcher-create step component tests, the launch
// state-machine unit test, the discovery + JoinFlow + StatusHeader tests). The
// app-experience coverage is being rebuilt in the right shape — deterministic
// mocked-daemon Playwright flow tests (hermetic gate) + a non-gating real paired
// app smoke — tracked in the follow-up issue. Tier 2 here gates on the
// protocol-level callables: T2.2 (prediction.v1 producer/evaluator — fully
// hermetic through the verdict) and T2.4 (swe-rebench-v2 producer/evaluator —
// hermetic stub solve + the real Docker evaluator, skip-clean when
// Docker/upstream-repo absent; #898). The former T2.1 cross-op donation
// scenario was retired with the x402 payment layer (tokenless-OLAS pivot).

export async function runTier2(opts: RunTier2Options = {}): Promise<RunTier2Result> {
  const outputDir = opts.outputDir ?? path.join(
    process.cwd(),
    'tier-2-evidence',
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  );
  await fs.mkdir(outputDir, { recursive: true });

  // T2.2 + T2.4 callables run in parallel. Each descriptor carries its own id
  // and evidence path so the crash-fallback verdict needs no positional
  // bookkeeping.
  const T22_WALL_CLOCK_BUDGET_MS = 18 * 60 * 1000;
  const T24_WALL_CLOCK_BUDGET_MS = 18 * 60 * 1000;
  const callables = [
    { id: 'T2.2', run: runT22ProducerEvaluator, wallClockBudgetMs: T22_WALL_CLOCK_BUDGET_MS },
    { id: 'T2.4', run: runT24ProducerEvaluatorSweRebench, wallClockBudgetMs: T24_WALL_CLOCK_BUDGET_MS },
  ].map((s) => ({
    id: s.id,
    evidencePath: path.join(outputDir, `${s.id}.log`),
    run: s.run,
    wallClockBudgetMs: s.wallClockBudgetMs,
  }));

  const settled = await Promise.allSettled(
    callables.map((s) => s.run({ evidencePath: s.evidencePath, wallClockBudgetMs: s.wallClockBudgetMs })),
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

  const verdicts = callableVerdicts;

  // Validate every verdict against the schema (catches contract drift).
  for (const v of verdicts) ScenarioVerdictSchema.parse(v);

  // `fail` is the only blocking verdict — `skip` is non-blocking, mirroring
  // exitCodeForVerdicts (which returns 0 unless some verdict is 'fail'). T2.4 is
  // the first Tier-2 scenario that can legitimately skip (Docker/upstream-repo/
  // admission/HF absent), so a clean Dockerless run must not write
  // tier-2-overall=failed (#898).
  const allPassed = verdicts.every((v) => v.verdict !== 'fail');

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

  // Exit-code contract (consumed by environment-suite.yml's exit→verdict map):
  //   1 = product-red  — a classified `real-bug`; hard product failure, blocks.
  //   4 = infra-blocked — any other fail (flake-timing / flake-infra /
  //       agent-crash). A timeout/connectivity/crash symptom is NOT proof of a
  //       transient: it must SURFACE and block (named as infra), never clear the
  //       gate green. This closes the flake-mask — previously these exited 0 and
  //       a deterministic-trigger failure (e.g. a stuck launch) silently passed
  //       the gate. A genuine one-off transient is re-cleared by re-dispatching
  //       the (manual) authoritative run; the gate never lies in the meantime.
  //   0 = every scenario passed or skipped.
  process.exit(exitCodeForVerdicts(verdicts));
}

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  cliMain().catch((err) => {
    console.error('run-tier-2 crashed:', err);
    process.exit(2);
  });
}
