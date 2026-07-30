/**
 * Skills-bench orchestrator CLI: drives real claude-code solves for a slate
 * of SWE-rebench-v2 instances across a set of "arms" (baseline = no skill,
 * treatment = one pinned skill mounted), grades each patch with the upstream
 * eval.py, and durably logs one BenchOutcome per (instance × arm × repeat)
 * to `<out>/attempts.jsonl`. Resumable: a rerun skips any attempt key
 * already present in the log; `assertManifestCompatible` fails loud if the
 * slate/model/arm bytes changed underneath an existing `--out` dir.
 *
 * IMPORTANT: this spawns real `claude` subprocesses (real inference spend)
 * and runs real Docker-based grading UNLESS `--dry-run` is passed.
 * `--dry-run` synthesizes deterministic fake outcomes and never touches
 * git/Docker/network/claude — use it to verify the wiring for free.
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/run-bench.ts --dry-run \
 *     --slate ../bench/slate/slate.json --arms ../bench/arms/wave1.json --out /tmp/bench-dry
 *   yarn tsx scripts/skills-bench/run-bench.ts \
 *     --slate ../bench/slate/slate.json [--half feedback|holdout|both] \
 *     --arms ../bench/arms/wave1.json --model claude-sonnet-5 \
 *     --out ../bench/runs/wave1 [--repeats 1] [--max-turns 40] \
 *     [--max-instances N] [--grade-timeout-ms 600000] [--upstream-repo-dir PATH] \
 *     [--solve-concurrency N]
 *
 * arms file shape (baseline has skillDir null):
 *   [{ "name": "baseline", "skillDir": null },
 *    { "name": "tdd", "skillDir": "../bench/skills-under-test/tdd" }]
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildClaudeArgs, mountSkill, prepareBenchConfigDir, parseClaudeJson,
} from '../../src/skills-bench/claude-solve.js';
import type { SkillsBenchSlate, SlateCandidate } from '../../src/skills-bench/slate.js';
import {
  appendAttempt, assertManifestCompatible, attemptKey, loadAttempts,
  type BenchManifest, type BenchOutcome,
} from '../../src/skills-bench/attempts.js';
import {
  createPilotWorkDir, prepareBaseCheckout, recoverPatch, GitStepError,
} from '../../src/pilot/repo.js';
import { mapWithConcurrency, SerialTaskQueue } from '../../src/pilot/pipeline.js';
import { fetchPilotRawRow, parsePilotInstanceRow, type PilotInstance } from '../../src/pilot/instance.js';
import { HttpHfFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner, EvalCouldNotGradeError } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import type { HfRow } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Arm {
  name: string;
  skillDir: string | null;
}

interface BenchConfig {
  dryRun: boolean;
  slatePath: string;
  half: 'feedback' | 'holdout' | 'both';
  armsPath: string;
  model: string;
  outDir: string;
  repeats: number;
  maxTurns: number;
  maxInstances: number;
  gradeTimeoutMs: number;
  upstreamRepoDir: string;
  solveConcurrency: number;
}

const DEFAULT_MODEL = 'claude-sonnet-5';

function parseArgs(argv: string[]): BenchConfig {
  const cfg: BenchConfig = {
    dryRun: false,
    slatePath: '',
    half: 'feedback',
    armsPath: '',
    model: DEFAULT_MODEL,
    outDir: '',
    repeats: 1,
    maxTurns: 40,
    maxInstances: Infinity,
    gradeTimeoutMs: 600_000,
    upstreamRepoDir: join(homedir(), '.jinn-client', 'SWE-rebench-V2-upstream'),
    solveConcurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': cfg.dryRun = true; break;
      case '--slate': cfg.slatePath = resolve(String(argv[++i])); break;
      case '--half': {
        const v = String(argv[++i]);
        if (v !== 'feedback' && v !== 'holdout' && v !== 'both') throw new Error(`invalid --half ${v}`);
        cfg.half = v;
        break;
      }
      case '--arms': cfg.armsPath = resolve(String(argv[++i])); break;
      case '--model': cfg.model = String(argv[++i]); break;
      case '--out': cfg.outDir = resolve(String(argv[++i])); break;
      case '--repeats': cfg.repeats = Number(argv[++i]); break;
      case '--max-turns': cfg.maxTurns = Number(argv[++i]); break;
      case '--max-instances': cfg.maxInstances = Number(argv[++i]); break;
      case '--grade-timeout-ms': cfg.gradeTimeoutMs = Number(argv[++i]); break;
      case '--upstream-repo-dir': cfg.upstreamRepoDir = resolve(String(argv[++i])); break;
      case '--solve-concurrency': cfg.solveConcurrency = Math.max(1, Number(argv[++i]) || 1); break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!cfg.slatePath) throw new Error('--slate is required');
  if (!cfg.armsPath) throw new Error('--arms is required');
  if (!cfg.outDir) throw new Error('--out is required');
  return cfg;
}

function loadSlate(path: string): SkillsBenchSlate {
  return JSON.parse(readFileSync(path, 'utf8')) as SkillsBenchSlate;
}

function loadArms(path: string): Arm[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`--arms must be a non-empty JSON array: ${path}`);
  return parsed.map((item, idx) => {
    if (item === null || typeof item !== 'object') throw new Error(`arm ${idx} must be an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name) throw new Error(`arm ${idx} missing name`);
    const skillDir = typeof record.skillDir === 'string' && record.skillDir ? resolve(record.skillDir) : null;
    return { name: record.name, skillDir };
  });
}

function pinSha256(skillDir: string): string {
  const pinPath = join(skillDir, 'pin.json');
  const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as { sha256?: string };
  if (typeof pin.sha256 !== 'string' || !pin.sha256) throw new Error(`pin.json at ${pinPath} missing sha256`);
  return pin.sha256;
}

function candidatesForHalf(slate: SkillsBenchSlate, half: BenchConfig['half']): SlateCandidate[] {
  if (half === 'feedback') return slate.feedback;
  if (half === 'holdout') return slate.holdout;
  return [...slate.feedback, ...slate.holdout];
}

// ---------------------------------------------------------------------------
// Attempt specs
// ---------------------------------------------------------------------------

interface AttemptSpec {
  candidate: SlateCandidate;
  arm: Arm;
  repeat: number;
  /** Position among (candidate, repeat) units, in slate order — used to
   *  make dry-run synthesis a pure function of the attempt's identity,
   *  independent of which keys are already resumed. */
  unitIndex: number;
}

function buildAttemptSpecs(candidates: SlateCandidate[], arms: Arm[], repeats: number): AttemptSpec[] {
  const specs: AttemptSpec[] = [];
  let unitIndex = 0;
  for (const candidate of candidates) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const arm of arms) {
        specs.push({ candidate, arm, repeat, unitIndex });
      }
      unitIndex++;
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Prompt (run-pilot's buildPrompt, minus the skillsNudge line — claude-code
// loads skill descriptions natively, so a nudge would measure prompt
// compliance rather than the skill itself)
// ---------------------------------------------------------------------------

function buildPrompt(problemStatement: string, iface: string | undefined): string {
  const spec = iface && iface.trim()
    ? `\n\n## Required interface (the contract your fix must satisfy)\n${iface.trim()}`
    : '';
  return `You are fixing a bug in this repository. Work efficiently and DO NOT get stuck exploring:\n` +
    `1. Briefly locate the relevant code — a few targeted searches/reads, not an exhaustive tour of the repo.\n` +
    `2. Then MAKE THE EDIT: modify the source file(s) to fix the issue. You MUST produce an actual code change (a git diff), not just analysis. Do not end your turn without having edited a file.\n` +
    `Make the minimal change needed. Do not add explanatory files or scripts outside the repo's existing structure.\n` +
    `\n${problemStatement}${spec}`;
}

// ---------------------------------------------------------------------------
// Shell helper (mirrors run-pilot's `run`)
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

function compactProcessOutput(value: string, limit = 4000): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n...[truncated ${trimmed.length - limit} chars]`;
}

// ---------------------------------------------------------------------------
// Grading (mirrors run-pilot.ts:361 gradeOne exactly)
// ---------------------------------------------------------------------------

async function gradeAttempt(cfg: BenchConfig, row: HfRow, patch: string): Promise<boolean | null> {
  if (!patch.trim()) {
    console.warn(`[bench]   empty patch for ${row.instance_id} — agent produced no diff; scoring as not-resolved`);
    return false; // empty patch never resolves
  }
  const runner = new PythonEvalRunner({ upstreamRepoDir: cfg.upstreamRepoDir, evalTimeoutMs: cfg.gradeTimeoutMs });
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
      console.warn(`[bench]   ungradeable (${err.reason}) for ${row.instance_id}`);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dry-run synthesis
// ---------------------------------------------------------------------------

function synthesizeOutcome(spec: AttemptSpec, armIndex: number): BenchOutcome {
  const passed = spec.unitIndex % 2 === 0;
  return {
    instanceId: spec.candidate.instance_id,
    arm: spec.arm.name,
    repeat: spec.repeat,
    passed,
    unscorable: false,
    costUsd: armIndex === 0 ? 0.03 : 0.025,
  };
}

// ---------------------------------------------------------------------------
// Real solve + grade
// ---------------------------------------------------------------------------

async function solveAndGrade(
  cfg: BenchConfig,
  benchCfgDir: string,
  attemptsFile: string,
  transcriptsDir: string,
  instance: PilotInstance,
  hfRow: HfRow,
  baseDir: string,
  spec: AttemptSpec,
  gradeQueue: SerialTaskQueue,
): Promise<void> {
  const armDir = await createPilotWorkDir(cfg.outDir, `solve-${spec.arm.name}-${spec.repeat}-`);
  try {
    console.log(`[bench] solving ${instance.instance_id} arm=${spec.arm.name} repeat=${spec.repeat}`);
    await rm(armDir, { recursive: true, force: true });
    await cp(baseDir, armDir, { recursive: true });
    if (spec.arm.skillDir) await mountSkill(armDir, spec.arm.skillDir, spec.arm.name);

    const prompt = buildPrompt(instance.problem_statement, instance.interface);
    const args = buildClaudeArgs({ prompt, model: cfg.model, maxTurns: cfg.maxTurns });
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: benchCfgDir };
    const { stdout, stderr, exitCode } = await run('claude', args, { cwd: armDir, env });
    if (exitCode !== 0) {
      const context = compactProcessOutput([stderr, stdout].filter((part) => part.trim()).join('\n'));
      throw new Error(`claude exited ${exitCode}${context ? `: ${context}` : ''}`);
    }

    const claudeResult = parseClaudeJson(stdout);
    const patch = await recoverPatch(run, armDir);

    await mkdir(transcriptsDir, { recursive: true });
    const key = attemptKey({ instanceId: spec.candidate.instance_id, arm: spec.arm.name, repeat: spec.repeat });
    await writeFile(join(transcriptsDir, `${key}.json`), `${JSON.stringify({ ...claudeResult, patch }, null, 2)}\n`);

    gradeQueue.push(async () => {
      const passed = await gradeAttempt(cfg, hfRow, patch);
      const outcome: BenchOutcome = {
        instanceId: spec.candidate.instance_id,
        arm: spec.arm.name,
        repeat: spec.repeat,
        passed,
        unscorable: passed === null,
        costUsd: claudeResult.costUsd,
      };
      await appendAttempt(attemptsFile, outcome);
      const verdict = passed === null ? 'ungradeable' : passed ? 'passed' : 'failed';
      console.log(`[bench] graded ${instance.instance_id} arm=${spec.arm.name} → ${verdict}`);
    });
  } finally {
    await rm(armDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runReal(
  cfg: BenchConfig,
  specs: AttemptSpec[],
  attemptsFile: string,
  transcriptsDir: string,
): Promise<void> {
  const benchCfgDir = join(cfg.outDir, 'claude-config');
  await prepareBenchConfigDir(benchCfgDir, {
    sourceConfigDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  });

  const hfFetcher = new HttpHfFetcher();
  const gradeQueue = new SerialTaskQueue();

  const byInstance = new Map<string, AttemptSpec[]>();
  for (const spec of specs) {
    const list = byInstance.get(spec.candidate.instance_id);
    if (list) list.push(spec);
    else byInstance.set(spec.candidate.instance_id, [spec]);
  }

  await mapWithConcurrency([...byInstance.entries()], cfg.solveConcurrency, async ([instanceId, instanceSpecs]) => {
    const candidate = instanceSpecs[0]!.candidate;
    let instance: PilotInstance;
    let hfRow: HfRow;
    try {
      const [rawRow, row] = await Promise.all([
        fetchPilotRawRow(candidate),
        hfFetcher.fetchTaskRow(candidate),
      ]);
      instance = parsePilotInstanceRow(rawRow, candidate);
      hfRow = row;
    } catch (err) {
      console.warn(`[bench] instance ${instanceId} fetch failed (${(err as Error).message}) — skipping, continuing`);
      return;
    }

    const baseDir = await createPilotWorkDir(cfg.outDir, `base-${instanceId.replace(/[^a-zA-Z0-9_-]/g, '_')}-`);
    try {
      console.log(`[bench] cloning ${instance.repo} @ ${instance.base_commit}...`);
      await prepareBaseCheckout(run, instance.repo, instance.base_commit, baseDir);
    } catch (err) {
      if (err instanceof GitStepError) {
        console.warn(`[bench] instance ${instanceId} base checkout failed (${err.message}) — skipping, continuing`);
      } else {
        console.warn(`[bench] instance ${instanceId} failed (${(err as Error).message}) — skipping, continuing`);
      }
      await rm(baseDir, { recursive: true, force: true });
      return;
    }

    try {
      for (const spec of instanceSpecs) {
        try {
          await solveAndGrade(cfg, benchCfgDir, attemptsFile, transcriptsDir, instance, hfRow, baseDir, spec, gradeQueue);
        } catch (solveErr) {
          console.warn(`[bench]   solve error for ${instanceId}/${spec.arm.name}/${spec.repeat}: ${(solveErr as Error).message} — skipping, continuing`);
        }
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  await gradeQueue.drain();
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const slate = loadSlate(cfg.slatePath);
  const arms = loadArms(cfg.armsPath);

  const manifest: BenchManifest = {
    version: 'skills-bench-manifest.v1',
    slateSha256: slate.sha256,
    model: cfg.model,
    arms: arms.map((arm) => ({ name: arm.name, skillSha256: arm.skillDir ? pinSha256(arm.skillDir) : null })),
  };
  await assertManifestCompatible(join(cfg.outDir, 'bench-manifest.json'), manifest);

  const candidates = candidatesForHalf(slate, cfg.half)
    .slice(0, Number.isFinite(cfg.maxInstances) ? cfg.maxInstances : undefined);
  const specs = buildAttemptSpecs(candidates, arms, cfg.repeats);

  const attemptsFile = join(cfg.outDir, 'attempts.jsonl');
  const transcriptsDir = join(cfg.outDir, 'transcripts');
  const existingKeys = new Set((await loadAttempts(attemptsFile)).map(attemptKey));
  const runnable = specs.filter((spec) => !existingKeys.has(attemptKey({
    instanceId: spec.candidate.instance_id, arm: spec.arm.name, repeat: spec.repeat,
  })));

  if (runnable.length === 0) {
    console.log('[bench] no runnable attempts — every attempt key already present in attempts.jsonl (resumed).');
    return;
  }
  console.log(`[bench] ${runnable.length}/${specs.length} attempt(s) to run (${specs.length - runnable.length} already resumed)`);

  if (cfg.dryRun) {
    console.log('');
    console.log('==================== DRY RUN — no spend ====================');
    console.log('Skipping clone/spawn/grade/network. Synthesizing deterministic fake outcomes.');
    for (const spec of runnable) {
      const armIndex = arms.findIndex((a) => a.name === spec.arm.name);
      const outcome = synthesizeOutcome(spec, armIndex);
      await appendAttempt(attemptsFile, outcome);
      console.log(`[bench] dry-run result ${outcome.instanceId} arm=${outcome.arm} repeat=${outcome.repeat}: passed=${outcome.passed} cost=$${outcome.costUsd.toFixed(4)}`);
    }
    return;
  }

  await runReal(cfg, runnable, attemptsFile, transcriptsDir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
