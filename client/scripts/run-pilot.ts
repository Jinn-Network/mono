/**
 * Pilot CLI orchestrator: drives real solves through jinn-agent (Hermes) for
 * a small set of SWE-rebench-V2 instances, in both arms (A = empty loadout,
 * B = one skill preloaded), grades each patch with the upstream eval.py, and
 * prints a capability-eval-style report (resolve rate, quality non-inferiority,
 * cost verdict).
 *
 * See docs/spikes/2026-07-07-jinn-agent-headless-spike.md for the exact
 * commands this wires together, and .superpowers/sdd/task-4-brief.md for the
 * spec.
 *
 * IMPORTANT: this spends real money (jinn-agent inference) and pulls/runs
 * real Docker images UNLESS `--dry-run` is passed. `--dry-run` synthesizes
 * fake outcomes and skips all clone/spawn/grade/network — use it to verify
 * the wiring for free.
 *
 * Usage:
 *   yarn tsx scripts/run-pilot.ts --dry-run
 *   yarn tsx scripts/run-pilot.ts [--repeats N] [--skill NAME] [--max-turns N]
 *                                 [--max-instances N] [--jinn-agent-bin PATH]
 *                                 [--upstream-repo-dir PATH]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { buildSolveArgs, parseSessionTokens, extractSessionId, type Arm } from '../src/pilot/solve.js';
import { solveCostUsd, DEEPSEEK_V4_FLASH_RATES } from '../src/pilot/cost.js';
import { tallyPilot, type SolveOutcome, type PilotReport } from '../src/pilot/tally.js';
import { parsePilotInstanceRow, type PilotInstance } from '../src/pilot/instance.js';
import { HttpHfFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner, EvalCouldNotGradeError } from '../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import type { HfRow } from '../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PilotInstanceRef {
  instance_id: string;
  hf_dataset: string;
  hf_split: string;
}

export interface PilotConfig {
  instances: PilotInstanceRef[];
  repeats: number;
  skill: string;
  maxTurns: number;
  maxInstances: number;
  upstreamRepoDir: string;
  jinnAgentBin: string;
  dryRun: boolean;
}

const DEFAULT_INSTANCE: PilotInstanceRef = {
  instance_id: 'pilosus__pip-license-checker-119',
  hf_dataset: 'ibragim-bad/SWE-rebench-V2-sample',
  hf_split: 'train',
};

function parseArgs(argv: string[]): PilotConfig {
  const cfg: PilotConfig = {
    instances: [DEFAULT_INSTANCE],
    repeats: 1,
    skill: 'systematic-debugging',
    maxTurns: 20,
    maxInstances: Infinity,
    upstreamRepoDir: join(homedir(), '.jinn-client', 'SWE-rebench-V2-upstream'),
    jinnAgentBin: join(homedir(), '.local', 'bin', 'jinn-agent'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': cfg.dryRun = true; break;
      case '--repeats': cfg.repeats = Number(argv[++i]); break;
      case '--skill': cfg.skill = String(argv[++i]); break;
      case '--max-turns': cfg.maxTurns = Number(argv[++i]); break;
      case '--max-instances': cfg.maxInstances = Number(argv[++i]); break;
      case '--upstream-repo-dir': cfg.upstreamRepoDir = String(argv[++i]); break;
      case '--jinn-agent-bin': cfg.jinnAgentBin = String(argv[++i]); break;
      case '--instances': {
        // JSON array of {instance_id, hf_dataset, hf_split}
        cfg.instances = JSON.parse(String(argv[++i])) as PilotInstanceRef[];
        break;
      }
      default: break;
    }
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

// ---------------------------------------------------------------------------
// Raw HF row fetch (base_commit + problem_statement; same path as hf-fetcher.ts)
// ---------------------------------------------------------------------------

const HF_ROWS_URL = 'https://datasets-server.huggingface.co/rows';

async function fetchRawRow(ref: PilotInstanceRef): Promise<Record<string, unknown>> {
  const pageSize = 100;
  let offset = 0;
  const maxRows = 1000;
  while (offset < maxRows) {
    const url = new URL(HF_ROWS_URL);
    url.searchParams.set('dataset', ref.hf_dataset);
    url.searchParams.set('config', 'default');
    url.searchParams.set('split', ref.hf_split);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(pageSize));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HF datasets-server returned ${res.status} for ${ref.hf_dataset}/${ref.hf_split}`);
    const body = (await res.json()) as { rows?: Array<{ row?: Record<string, unknown> }> };
    const rows = (body.rows ?? []).map((r) => r.row ?? {});
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row['instance_id'] === ref.instance_id) return row;
    }
    if (rows.length < pageSize) break;
    offset += rows.length;
  }
  throw new Error(`instance_id ${ref.instance_id} not found in ${ref.hf_dataset}/${ref.hf_split}`);
}

// ---------------------------------------------------------------------------
// One solve: spawn jinn-agent, recover patch + tokens
// ---------------------------------------------------------------------------

function buildPrompt(problemStatement: string): string {
  return `You are fixing a bug in this repository. Make the minimal source change needed. ` +
    `Do not add explanatory files or scripts outside the repo's existing structure.\n\n${problemStatement}`;
}

async function solveOne(cfg: PilotConfig, instance: PilotInstance, arm: Arm, repeat: number, baseDir: string): Promise<SolveOutcome & { patch: string }> {
  const armDir = await mkdtemp(join(tmpdir(), `pilot-${arm.name}-${repeat}-`));
  await rm(armDir, { recursive: true, force: true });
  await cp(baseDir, armDir, { recursive: true });

  const prompt = buildPrompt(instance.problem_statement);
  const args = buildSolveArgs(arm, prompt, { maxTurns: cfg.maxTurns });
  console.log(`[pilot] solving ${instance.instance_id} arm=${arm.name} repeat=${repeat}...`);
  const { stderr, exitCode } = await run(cfg.jinnAgentBin, args, { cwd: armDir });

  const diff = await run('git', ['diff'], { cwd: armDir });
  const patch = diff.stdout;

  let costUsd = 0;
  let passed: boolean | null = null;
  try {
    const sessionId = extractSessionId(stderr);
    if (!sessionId) throw new Error(`no session_id in stderr (exitCode=${exitCode})`);
    const exportRes = await run(cfg.jinnAgentBin, ['sessions', 'export', '--session-id', sessionId, '-']);
    const firstLine = exportRes.stdout.split('\n').find((l) => l.trim().length > 0) ?? '';
    const tokens = parseSessionTokens(firstLine);
    costUsd = solveCostUsd(tokens, DEEPSEEK_V4_FLASH_RATES);
    console.log(`[pilot]   tokens: in=${tokens.inputTokens} out=${tokens.outputTokens} cost=$${costUsd.toFixed(4)}`);
  } catch (err) {
    console.warn(`[pilot]   could not capture tokens for ${instance.instance_id}/${arm.name}/${repeat}: ${(err as Error).message}`);
  }

  await rm(armDir, { recursive: true, force: true });

  return { instance_id: instance.instance_id, arm: arm.name, repeat, passed, costUsd, patch };
}

async function gradeOne(cfg: PilotConfig, row: HfRow, patch: string): Promise<boolean | null> {
  if (!patch.trim()) {
    console.warn(`[pilot]   empty patch for ${row.instance_id} — agent produced no diff; scoring as not-resolved`);
    return false; // empty patch never resolves
  }
  const runner = new PythonEvalRunner({ upstreamRepoDir: cfg.upstreamRepoDir });
  try {
    const result = await runner.runEval({
      instance_id: row.instance_id,
      repo: row.repo,
      image: row.image_name,
      patch,
      test_patch: row.test_patch,
      install: row.install_config.install,
      test_cmd: row.install_config.test_cmd,
      log_parser: row.install_config.log_parser,
      fail_to_pass: row.FAIL_TO_PASS,
      pass_to_pass: row.PASS_TO_PASS,
    });
    return result.passed_match;
  } catch (err) {
    if (err instanceof EvalCouldNotGradeError) {
      console.warn(`[pilot]   ungradeable (${err.reason}) for ${row.instance_id}`);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dry-run synthesis
// ---------------------------------------------------------------------------

function synthesizeDryRunOutcomes(cfg: PilotConfig): SolveOutcome[] {
  const outcomes: SolveOutcome[] = [];
  const instances = cfg.instances.slice(0, Number.isFinite(cfg.maxInstances) ? cfg.maxInstances : cfg.instances.length);
  let i = 0;
  for (const inst of instances) {
    for (let repeat = 0; repeat < cfg.repeats; repeat++) {
      // alternate pass/fail deterministically; arm B slightly cheaper than A
      const passed = i % 2 === 0;
      outcomes.push({ instance_id: inst.instance_id, arm: 'A', repeat, passed, costUsd: 0.03 });
      outcomes.push({ instance_id: inst.instance_id, arm: 'B', repeat, passed, costUsd: 0.025 });
      i++;
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Report printing
// ---------------------------------------------------------------------------

function printReport(report: PilotReport, outcomes: SolveOutcome[], banner?: string): void {
  if (banner) {
    console.log('');
    console.log(`==================== ${banner} ====================`);
  }
  const totalCost = outcomes.reduce((s, o) => s + o.costUsd, 0);
  console.log('');
  console.log('Pilot report');
  console.log('------------');
  console.log(`instances (n, incl. excluded): ${report.n}`);
  console.log(`excluded (ungradeable on one arm): ${report.excluded}`);
  console.log(`both-solve tasks: ${report.bothSolveTasks}`);
  console.log(`arm A resolve rate: ${(report.armA.resolveRate * 100).toFixed(1)}%`);
  console.log(`arm B resolve rate: ${(report.armB.resolveRate * 100).toFixed(1)}%`);
  console.log(`quality: Δ=${report.quality.deltaPP.toFixed(1)}pp, lowerBound=${report.quality.lowerBound.toFixed(4)}, non-inferior=${report.quality.nonInferior}`);
  console.log(`cost verdict: ${report.cost.verdict} (median Δ$=${Number.isFinite(report.cost.medianDeltaUsd) ? report.cost.medianDeltaUsd.toFixed(4) : 'n/a'})`);
  console.log(`total solves: ${outcomes.length}`);
  console.log(`total tokens spent: n/a (see per-solve logs above)`);
  console.log(`total $ spent: $${totalCost.toFixed(4)}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  if (cfg.dryRun) {
    console.log('');
    console.log('==================== DRY RUN — no spend ====================');
    console.log('Skipping clone/spawn/grade/network. Synthesizing deterministic fake outcomes.');
    const outcomes = synthesizeDryRunOutcomes(cfg);
    const rng = (() => { let s = 42; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
    const report = tallyPilot(outcomes, { rng });
    printReport(report, outcomes, 'DRY RUN — no spend');
    return;
  }

  const outcomes: SolveOutcome[] = [];
  const hfFetcher = new HttpHfFetcher();
  const rng = Math.random;

  const instances = cfg.instances.slice(0, Number.isFinite(cfg.maxInstances) ? cfg.maxInstances : cfg.instances.length);

  for (const ref of instances) {
    try {
      console.log(`[pilot] fetching instance ${ref.instance_id}...`);
      const [rawRow, hfRow] = await Promise.all([
        fetchRawRow(ref),
        hfFetcher.fetchTaskRow(ref),
      ]);
      const instance = parsePilotInstanceRow(rawRow, ref);

      const baseDir = await mkdtemp(join(tmpdir(), `pilot-base-${instance.instance_id.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
      try {
        console.log(`[pilot] cloning ${instance.repo} @ ${instance.base_commit}...`);
        await run('git', ['clone', `https://github.com/${instance.repo}.git`, baseDir]);
        await run('git', ['checkout', instance.base_commit], { cwd: baseDir });

        const arms: Arm[] = [
          { name: 'A', skills: [] },
          { name: 'B', skills: [cfg.skill] },
        ];

        for (const arm of arms) {
          for (let repeat = 0; repeat < cfg.repeats; repeat++) {
            // Per-solve containment: a failed solve or grade is recorded as an
            // ungradeable datapoint (passed:null, NEVER a fail) and the run
            // CONTINUES. A single transient error (bad clone, ENOENT, the
            // eval runner's own InsufficientDiskError) must not abort the run
            // or discard prior real spend (brief: "record it and continue").
            try {
              const { patch, ...outcome } = await solveOne(cfg, instance, arm, repeat, baseDir);
              let passed: boolean | null;
              try {
                passed = await gradeOne(cfg, hfRow, patch);
              } catch (gradeErr) {
                console.warn(`[pilot]   grade error for ${instance.instance_id}/${arm.name}/${repeat}: ${(gradeErr as Error).message} — recording ungradeable`);
                passed = null;
              }
              const finalOutcome: SolveOutcome = { ...outcome, passed };
              outcomes.push(finalOutcome);
              console.log(`[pilot] result ${instance.instance_id} arm=${arm.name} repeat=${repeat}: passed=${passed} cost=$${finalOutcome.costUsd.toFixed(4)}`);
            } catch (solveErr) {
              console.warn(`[pilot]   solve error for ${instance.instance_id}/${arm.name}/${repeat}: ${(solveErr as Error).message} — recording ungradeable, continuing`);
              outcomes.push({ instance_id: instance.instance_id, arm: arm.name, repeat, passed: null, costUsd: 0 });
            }
          }
        }
      } finally {
        await rm(baseDir, { recursive: true, force: true });
      }
    } catch (instErr) {
      console.warn(`[pilot] instance ${ref.instance_id} failed (${(instErr as Error).message}) — skipping, continuing`);
    }
  }

  // Always report whatever was collected — a partial run still yields a
  // (clearly partial) report rather than discarding real spend.
  if (outcomes.length === 0) {
    console.log('[pilot] no outcomes collected — nothing to report.');
    return;
  }
  const report = tallyPilot(outcomes, { rng });
  printReport(report, outcomes);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
