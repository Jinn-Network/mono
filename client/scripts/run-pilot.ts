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
 *                                 [--upstream-repo-dir PATH] [--out DIR]
 *                                 [--arms-file arms.json]
 *                                 [--arm-b-jinn-agent-home DIR]
 *                                 [--max-new-solves N] [--retry-errors] [--force]
 *                                 [--solve-concurrency N]
 */
import { spawn } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSolveArgs, parseSessionTokens, extractSessionId, type Arm } from '../src/pilot/solve.js';
import type { SolveTokens } from '../src/pilot/solve.js';
import { solveCostUsd, DEEPSEEK_V4_FLASH_RATES, GPT_5_4_MINI_RATES, type RateTable } from '../src/pilot/cost.js';
import { tallyPilot, type SolveOutcome, type PilotReport } from '../src/pilot/tally.js';
import { fetchPilotRawRow, parsePilotInstanceRow, type PilotInstance } from '../src/pilot/instance.js';
import { assertArmIsolation } from '../src/pilot/arm-homes.js';
import { mapWithConcurrency, SerialTaskQueue } from '../src/pilot/pipeline.js';
import { createPilotWorkDir, prepareBaseCheckout, recoverPatch } from '../src/pilot/repo.js';
import {
  assertCompatiblePilotManifest,
  attemptKey,
  buildAttemptSpecs,
  instanceRefKey,
  buildPilotManifest,
  clearPilotOutput,
  loadAttemptRecords,
  loadFrozenInstances,
  loadPilotManifest,
  orderedRecordsForSpecs,
  recordsToOutcomes,
  selectRunnableAttempts,
  writeAttemptRecord,
  writeFrozenInstances,
  writePatch,
  writePilotManifest,
  writePilotReport,
  type FrozenPilotInstance,
  type PilotArmConfig,
  type PilotAttemptRecord,
  type PilotAttemptSpec,
  type PilotSemanticConfig,
} from '../src/pilot/resume.js';
import { HttpHfFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner, EvalCouldNotGradeError } from '../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import type { HfRow } from '../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { loadHeldOutSlate } from '../src/solver-types/_swe-rebench-v2-held-out-slate.js';

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
  instancesExplicit: boolean;
  repeats: number;
  skills: string[];
  arms: PilotArmConfig[];
  maxTurns: number;
  maxInstances: number;
  upstreamRepoDir: string;
  jinnAgentBin: string;
  /** Inference endpoint pinned per-invocation (does not touch config.yaml).
   *  Unset → jinn-agent uses its config default. For the Codex-subscription
   *  run: provider='openai-codex', model='gpt-5.4-mini'. */
  provider?: string;
  model?: string;
  taskSource?: string;
  slateHash?: string;
  armBJinnAgentHome?: string;
  outDir?: string;
  force: boolean;
  retryErrors: boolean;
  maxNewSolves: number;
  /** Hard cap per grade (ms). Default 10 min: amd64 SWE-rebench images can wedge
   *  indefinitely under Apple-Silicon emulation, and the eval runner's own default
   *  is 2h — far too long for a pilot. A timed-out grade becomes ungradeable and
   *  the run CONTINUES (it never hangs the whole pilot). Real runs on a Linux
   *  amd64 host can raise this. */
  gradeTimeoutMs: number;
  /** How many instances solve in parallel (runtime knob, not part of the
   *  frozen semantic config). Grading is always strictly serial regardless —
   *  see the pipeline note in runDurableReal. Default 1. */
  solveConcurrency: number;
  /** Append the neutral "check your available skills" line to every arm's
   *  prompt. Skills are lazy (manifest entry + skill_view) — without this the
   *  eval measures the model's skill-browsing propensity, not the knowledge.
   *  Identical text in all arms; semantic (recorded in the manifest). */
  skillsNudge: boolean;
  dryRun: boolean;
}

const DEFAULT_SLATE_VERSION = 'v3';

function loadDefaultPilotSlate(): { refs: PilotInstanceRef[]; hash: string } {
  const slate = loadHeldOutSlate('swe-rebench-v2.v1', DEFAULT_SLATE_VERSION);
  const reportPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'solver-types',
    'slates',
    `held-out-slate.swe-rebench-v2.${DEFAULT_SLATE_VERSION}.screening-report.json`,
  );
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    selected?: Array<{ instance_id?: unknown; hf_dataset?: unknown; hf_split?: unknown }>;
  };
  if (!Array.isArray(report.selected)) throw new Error(`pilot slate screening report is missing selected entries: ${reportPath}`);
  const refs = report.selected.map((entry, index) => {
    if (typeof entry.instance_id !== 'string' || typeof entry.hf_dataset !== 'string' || typeof entry.hf_split !== 'string') {
      throw new Error(`pilot slate screening entry ${index} is malformed`);
    }
    return { instance_id: entry.instance_id, hf_dataset: entry.hf_dataset, hf_split: entry.hf_split };
  });
  const ids = new Set(refs.map((ref) => ref.instance_id));
  if (refs.length !== 24 || ids.size !== 24 || ids.size !== slate.instanceIds.size || [...ids].some((id) => !slate.instanceIds.has(id))) {
    throw new Error('pilot v3 slate and screening report disagree');
  }
  return { refs, hash: slate.hash };
}

function parseArgs(argv: string[]): PilotConfig {
  const cfg: PilotConfig = {
    instances: [],
    instancesExplicit: false,
    repeats: 1,
    skills: ['systematic-debugging'],
    arms: [],
    maxTurns: 20,
    maxInstances: Infinity,
    upstreamRepoDir: join(homedir(), '.jinn-client', 'SWE-rebench-V2-upstream'),
    jinnAgentBin: join(homedir(), '.local', 'bin', 'jinn-agent'),
    gradeTimeoutMs: 600_000,
    force: false,
    retryErrors: false,
    maxNewSolves: Infinity,
    solveConcurrency: 1,
    skillsNudge: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': cfg.dryRun = true; break;
      case '--repeats': cfg.repeats = Number(argv[++i]); break;
      case '--skill': cfg.skills = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--max-turns': cfg.maxTurns = Number(argv[++i]); break;
      case '--max-instances': cfg.maxInstances = Number(argv[++i]); break;
      case '--upstream-repo-dir': cfg.upstreamRepoDir = String(argv[++i]); break;
      case '--jinn-agent-bin': cfg.jinnAgentBin = String(argv[++i]); break;
      case '--provider': cfg.provider = String(argv[++i]); break;
      case '--model': cfg.model = String(argv[++i]); break;
      case '--arm-b-jinn-agent-home': cfg.armBJinnAgentHome = String(argv[++i]); break;
      case '--arms-file': {
        const parsed = JSON.parse(readFileSync(String(argv[++i]), 'utf8')) as unknown;
        cfg.arms = parseArms(parsed);
        break;
      }
      case '--out': cfg.outDir = String(argv[++i]); break;
      case '--force': cfg.force = true; break;
      case '--retry-errors': cfg.retryErrors = true; break;
      case '--max-new-solves': cfg.maxNewSolves = Number(argv[++i]); break;
      case '--grade-timeout-ms': cfg.gradeTimeoutMs = Number(argv[++i]); break;
      case '--solve-concurrency': cfg.solveConcurrency = Math.max(1, Number(argv[++i]) || 1); break;
      case '--skills-nudge': cfg.skillsNudge = true; break;
      case '--instances': {
        // JSON array of {instance_id, hf_dataset, hf_split}
        cfg.instances = JSON.parse(String(argv[++i])) as PilotInstanceRef[];
        cfg.instancesExplicit = true;
        break;
      }
      case '--instances-file': {
        // Same JSON array, read from a file (avoids fragile shell-quoting for
        // large slates). Fail-loud if unreadable or not an array.
        const parsed = JSON.parse(readFileSync(String(argv[++i]), 'utf8')) as unknown;
        if (!Array.isArray(parsed)) throw new Error('--instances-file must contain a JSON array');
        cfg.instances = parsed as PilotInstanceRef[];
        cfg.instancesExplicit = true;
        break;
      }
      default: break;
    }
  }
  if (cfg.arms.length === 0) {
    cfg.arms = [
      { name: 'A', skills: [] },
      { name: 'B', skills: cfg.skills, ...(cfg.armBJinnAgentHome ? { jinnAgentHome: cfg.armBJinnAgentHome } : {}) },
    ];
  }
  if (!cfg.instancesExplicit) {
    const slate = loadDefaultPilotSlate();
    cfg.instances = slate.refs;
    cfg.taskSource = `held-out-slate:${DEFAULT_SLATE_VERSION}`;
    cfg.slateHash = slate.hash;
  }
  return cfg;
}

function parseArms(value: unknown): PilotArmConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('--arms-file must contain a non-empty JSON array');
  }
  const seen = new Set<string>();
  return value.map((item, idx) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`arm ${idx} must be an object`);
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`arm ${idx} has invalid name ${JSON.stringify(record.name)}`);
    }
    if (seen.has(name)) throw new Error(`duplicate arm name ${name}`);
    seen.add(name);
    const rawSkills = record.skills ?? [];
    if (!Array.isArray(rawSkills) || rawSkills.some((s) => typeof s !== 'string')) {
      throw new Error(`arm ${name} skills must be an array of strings`);
    }
    const skills = rawSkills.map((s) => String(s).trim()).filter(Boolean);
    const jinnAgentHome = typeof record.jinnAgentHome === 'string' && record.jinnAgentHome.trim()
      ? record.jinnAgentHome.trim()
      : undefined;
    return { name, skills, ...(jinnAgentHome ? { jinnAgentHome } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

function envForArm(_cfg: PilotConfig, arm: Arm): NodeJS.ProcessEnv | undefined {
  if (!arm.jinnAgentHome) return undefined;
  const env = { ...process.env };
  env.JINN_AGENT_HOME = arm.jinnAgentHome;
  delete env.HERMES_HOME;
  return env;
}

function compactProcessOutput(value: string, limit = 4000): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n...[truncated ${trimmed.length - limit} chars]`;
}

// ---------------------------------------------------------------------------
// One solve: spawn jinn-agent, recover patch + tokens
// ---------------------------------------------------------------------------

function buildPrompt(instance: PilotInstance, skillsNudge: boolean): string {
  // The `interface` field is the acceptance SPEC (the API contract the solution
  // must satisfy) — NOT the hidden test. Fed to both arms when present, it removes
  // "correct behavior, wrong surface detail" failures (e.g. header casing).
  const spec = instance.interface && instance.interface.trim()
    ? `\n\n## Required interface (the contract your fix must satisfy)\n${instance.interface.trim()}`
    : '';
  // Identical in every arm — arms differ only in which skills are installed
  // (per-arm jinnAgentHome), so the nudge tests the knowledge, not the
  // model's propensity to browse its skill catalog.
  const nudge = skillsNudge
    ? `Before starting, check your available skills (skill_view) and apply any that are relevant to this bug.\n`
    : '';
  return `You are fixing a bug in this repository. Work efficiently and DO NOT get stuck exploring:\n` +
    `1. Briefly locate the relevant code — a few targeted searches/reads, not an exhaustive tour of the repo.\n` +
    `2. Then MAKE THE EDIT: modify the source file(s) to fix the issue. You MUST produce an actual code change (a git diff), not just analysis. Do not end your turn without having edited a file.\n` +
    `Make the minimal change needed. Do not add explanatory files or scripts outside the repo's existing structure.\n` +
    nudge +
    `\n${instance.problem_statement}${spec}`;
}

async function solveOne(cfg: PilotConfig, instance: PilotInstance, arm: Arm, repeat: number, baseDir: string): Promise<SolveOutcome & {
  patch: string;
  tokens?: SolveTokens;
  sessionId?: string;
  tokenError?: string;
}> {
  const armDir = await createPilotWorkDir(cfg.outDir, `solve-${arm.name}-${repeat}-`);
  // try/finally so a spawn / git / token-export throw still removes the per-arm
  // temp dir (it used to leak on any pre-cleanup throw, unlike baseDir).
  try {
    await rm(armDir, { recursive: true, force: true });
    await cp(baseDir, armDir, { recursive: true });

    const prompt = buildPrompt(instance, cfg.skillsNudge);
    const args = buildSolveArgs(arm, prompt, { maxTurns: cfg.maxTurns, provider: cfg.provider, model: cfg.model });
    console.log(`[pilot] solving ${instance.instance_id} arm=${arm.name} repeat=${repeat}...`);
    const armEnv = envForArm(cfg, arm);
    const { stdout, stderr, exitCode } = await run(cfg.jinnAgentBin, args, { cwd: armDir, env: armEnv });
    if (exitCode !== 0) {
      const context = compactProcessOutput([stderr, stdout].filter((part) => part.trim()).join('\n'));
      throw new Error(`jinn-agent exited ${exitCode}${context ? `: ${context}` : ''}`);
    }

    // Stage untracked files too — a new-file fix is invisible to a bare `git diff`.
    const patch = await recoverPatch(run, armDir);

    let costUsd = 0;
    let tokens: SolveTokens | undefined;
    let sessionId: string | undefined;
    let tokenError: string | undefined;
    const passed: boolean | null = null;
    try {
      sessionId = extractSessionId(stderr) ?? undefined;
      if (!sessionId) throw new Error(`no session_id in stderr (exitCode=${exitCode})`);
      const exportRes = await run(cfg.jinnAgentBin, ['sessions', 'export', '--session-id', sessionId, '-'], { env: armEnv });
      const firstLine = exportRes.stdout.split('\n').find((l) => l.trim().length > 0) ?? '';
      tokens = parseSessionTokens(firstLine);
      const rates: RateTable = cfg.provider === 'openai-codex' ? GPT_5_4_MINI_RATES : DEEPSEEK_V4_FLASH_RATES;
      costUsd = solveCostUsd(tokens, rates);
      console.log(`[pilot]   tokens: in=${tokens.inputTokens} out=${tokens.outputTokens} reason=${tokens.reasoningTokens} cost=$${costUsd.toFixed(4)}`);
    } catch (err) {
      tokenError = (err as Error).message;
      console.warn(`[pilot]   could not capture tokens for ${instance.instance_id}/${arm.name}/${repeat}: ${tokenError}`);
    }

    return { instance_id: instance.instance_id, arm: arm.name, repeat, passed, costUsd, patch, ...(tokens ? { tokens } : {}), ...(sessionId ? { sessionId } : {}), ...(tokenError ? { tokenError } : {}) };
  } finally {
    await rm(armDir, { recursive: true, force: true });
  }
}

async function gradeOne(cfg: PilotConfig, row: HfRow, patch: string): Promise<boolean | null> {
  if (!patch.trim()) {
    console.warn(`[pilot]   empty patch for ${row.instance_id} — agent produced no diff; scoring as not-resolved`);
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
      // alternate pass/fail deterministically; treatment arms slightly cheaper than baseline
      const passed = i % 2 === 0;
      for (const [armIdx, arm] of cfg.arms.entries()) {
        outcomes.push({
          instance_id: inst.instance_id,
          arm: arm.name,
          repeat,
          passed,
          costUsd: armIdx === 0 ? 0.03 : 0.025,
        });
      }
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
  console.log(`instances: ${report.n}`);
  console.log(`baseline arm: ${report.baselineArm}`);
  for (const [arm, armReport] of Object.entries(report.arms)) {
    console.log(`arm ${arm} resolve rate: ${(armReport.resolveRate * 100).toFixed(1)}% (${armReport.passed}/${armReport.graded})`);
  }
  for (const comparison of Object.values(report.comparisons)) {
    console.log(
      `compare ${comparison.treatmentArm} vs ${comparison.baselineArm}: ` +
      `excluded=${comparison.excluded}, both-solve=${comparison.bothSolveTasks}, ` +
      `quality Δ=${comparison.quality.deltaPP.toFixed(1)}pp, ` +
      `lowerBound=${comparison.quality.lowerBound.toFixed(4)}, ` +
      `non-inferior=${comparison.quality.nonInferior}, ` +
      `cost=${comparison.cost.verdict} ` +
      `(median Δ$=${Number.isFinite(comparison.cost.medianDeltaUsd) ? comparison.cost.medianDeltaUsd.toFixed(4) : 'n/a'}, ` +
      `both-solve n=${comparison.cost.n}${comparison.cost.underpowered ? ' — UNDERPOWERED (n<5, Wilcoxon cannot reject)' : ''})`,
    );
  }
  console.log(`total solves: ${outcomes.length}`);
  console.log(`total tokens spent: n/a (see per-solve logs above)`);
  console.log(`total $ spent: $${totalCost.toFixed(4)}`);
  console.log('');
}

function selectedInstanceRefs(cfg: PilotConfig): PilotInstanceRef[] {
  return cfg.instances.slice(0, Number.isFinite(cfg.maxInstances) ? cfg.maxInstances : cfg.instances.length);
}

function semanticConfig(cfg: PilotConfig, instances: PilotInstanceRef[]): PilotSemanticConfig {
  return {
    instances,
    repeats: cfg.repeats,
    arms: cfg.arms.map((arm) => ({ name: arm.name, skills: arm.skills })),
    maxTurns: cfg.maxTurns,
    gradeTimeoutMs: cfg.gradeTimeoutMs,
    mode: cfg.dryRun ? 'dry-run' : 'real',
    skillsNudge: cfg.skillsNudge,
    ...(cfg.provider ? { provider: cfg.provider } : {}),
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.taskSource ? { taskSource: cfg.taskSource } : {}),
    ...(cfg.slateHash ? { slateHash: cfg.slateHash } : {}),
  };
}

function fakeFrozenInstances(refs: PilotInstanceRef[]): FrozenPilotInstance[] {
  return refs.map((ref) => ({
    ref,
    instance: {
      instance_id: ref.instance_id,
      repo: 'dry-run/repo',
      base_commit: 'dry-run',
      problem_statement: `dry-run problem for ${ref.instance_id}`,
      hf_dataset: ref.hf_dataset,
      hf_split: ref.hf_split,
    },
    hfRow: {
      instance_id: ref.instance_id,
      repo: 'dry-run/repo',
      image_name: 'dry-run-image',
      FAIL_TO_PASS: [],
      PASS_TO_PASS: [],
      test_patch: '',
      install_config: { test_cmd: 'true', log_parser: 'dry-run' },
    },
  }));
}

async function resolveFrozenInstances(refs: PilotInstanceRef[], hfFetcher: HttpHfFetcher): Promise<FrozenPilotInstance[]> {
  const out: FrozenPilotInstance[] = [];
  for (const ref of refs) {
    console.log(`[pilot] fetching instance ${ref.instance_id}...`);
    const [rawRow, hfRow] = await Promise.all([
      fetchPilotRawRow(ref),
      hfFetcher.fetchTaskRow(ref),
    ]);
    out.push({ ref, instance: parsePilotInstanceRow(rawRow, ref), hfRow });
  }
  return out;
}

async function prepareDurableRun(cfg: PilotConfig, hfFetcher: HttpHfFetcher): Promise<{
  outDir: string;
  config: PilotSemanticConfig;
  specs: PilotAttemptSpec[];
  frozenInstances: FrozenPilotInstance[];
}> {
  if (!cfg.outDir) throw new Error('prepareDurableRun requires --out');
  const outDir = cfg.outDir;

  if (cfg.force) clearPilotOutput(outDir);

  const existing = loadPilotManifest(outDir);
  if (existing) {
    const instances = cfg.instancesExplicit
      ? selectedInstanceRefs(cfg)
      : existing.semanticConfig.instances;
    const resumeCfg = cfg.instancesExplicit
      ? cfg
      : {
          ...cfg,
          taskSource: existing.semanticConfig.taskSource,
          slateHash: existing.semanticConfig.slateHash,
        };
    const config = semanticConfig(resumeCfg, instances);
    assertCompatiblePilotManifest(existing, config);
    const frozenInstances = loadFrozenInstances(outDir);
    if (!frozenInstances) {
      throw new Error(`existing pilot output ${outDir} is missing instances.json; pass --force to rebuild`);
    }
    // Append-only slate extension: freeze rows for any instance refs added
    // since the manifest was written, then re-stamp the manifest so the
    // extended instance set becomes the frozen config.
    const frozenRefKeys = new Set(existing.semanticConfig.instances.map(instanceRefKey));
    const newRefs = instances.filter((ref) => !frozenRefKeys.has(instanceRefKey(ref)));
    if (newRefs.length > 0) {
      console.log(`[pilot] extending durable store with ${newRefs.length} new instance(s)...`);
      const newFrozen = cfg.dryRun ? fakeFrozenInstances(newRefs) : await resolveFrozenInstances(newRefs, hfFetcher);
      const merged = [...frozenInstances, ...newFrozen];
      writeFrozenInstances(outDir, merged);
      writePilotManifest(outDir, buildPilotManifest(config));
      return { outDir, config, specs: buildAttemptSpecs(config), frozenInstances: merged };
    }
    return { outDir, config, specs: buildAttemptSpecs(config), frozenInstances };
  }

  const instances = selectedInstanceRefs(cfg);
  const config = semanticConfig(cfg, instances);
  const manifest = buildPilotManifest(config);
  const frozenInstances = cfg.dryRun
    ? fakeFrozenInstances(instances)
    : await resolveFrozenInstances(instances, hfFetcher);
  writePilotManifest(outDir, manifest);
  writeFrozenInstances(outDir, frozenInstances);
  return { outDir, config, specs: buildAttemptSpecs(config), frozenInstances };
}

function seededRng(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function writeCurrentReport(outDir: string, specs: PilotAttemptSpec[], banner?: string, rng: () => number = Math.random): SolveOutcome[] {
  const records = loadAttemptRecords(outDir);
  const ordered = orderedRecordsForSpecs(specs, records);
  const outcomes = recordsToOutcomes(ordered);
  if (outcomes.length === 0) {
    console.log('[pilot] no outcomes collected — nothing to report.');
    return outcomes;
  }
  const report = tallyPilot(outcomes, { rng, baselineArm: specs[0]?.arm });
  writePilotReport(outDir, report, outcomes);
  printReport(report, outcomes, banner);
  return outcomes;
}

function dryRunAttemptRecord(spec: PilotAttemptSpec): PilotAttemptRecord {
  return {
    schema: 'jinn.pilot.attempt.v1',
    instance_id: spec.instance_id,
    arm: spec.arm,
    repeat: spec.repeat,
    status: 'graded',
    passed: spec.repeat % 2 === 0,
    costUsd: spec.arm === 'A' || spec.arm === 'stock' ? 0.03 : 0.025,
  };
}

async function runDurableDryRun(cfg: PilotConfig, hfFetcher: HttpHfFetcher): Promise<void> {
  console.log('');
  console.log('==================== DRY RUN — no spend ====================');
  console.log('Skipping clone/spawn/grade/network. Synthesizing deterministic fake outcomes.');
  const runState = await prepareDurableRun(cfg, hfFetcher);
  const records = loadAttemptRecords(runState.outDir);
  const runnable = selectRunnableAttempts(runState.specs, records, {
    retryErrors: cfg.retryErrors,
    maxNewSolves: cfg.maxNewSolves,
  });

  if (runnable.length === 0) {
    console.log('[pilot] no runnable attempts; reporting existing records.');
  }
  for (const spec of runnable) {
    const record = dryRunAttemptRecord(spec);
    writeAttemptRecord(runState.outDir, record);
    console.log(`[pilot] dry-run result ${spec.instance_id} arm=${spec.arm} repeat=${spec.repeat}: passed=${record.passed} cost=$${record.costUsd.toFixed(4)}`);
  }
  writeCurrentReport(runState.outDir, runState.specs, 'DRY RUN — no spend', seededRng());
}

function recordFromError(spec: PilotAttemptSpec, status: 'solve-error' | 'grade-error', err: unknown, costUsd = 0): PilotAttemptRecord {
  return {
    schema: 'jinn.pilot.attempt.v1',
    instance_id: spec.instance_id,
    arm: spec.arm,
    repeat: spec.repeat,
    status,
    passed: null,
    costUsd,
    error: err instanceof Error ? err.message : String(err),
  };
}

async function runDurableReal(cfg: PilotConfig, hfFetcher: HttpHfFetcher): Promise<void> {
  const runState = await prepareDurableRun(cfg, hfFetcher);
  const armByName = new Map(cfg.arms.map((arm) => [arm.name, arm]));
  const records = loadAttemptRecords(runState.outDir);
  const runnable = selectRunnableAttempts(runState.specs, records, {
    retryErrors: cfg.retryErrors,
    maxNewSolves: cfg.maxNewSolves,
  });

  if (runnable.length === 0) {
    console.log('[pilot] no runnable attempts; reporting existing records.');
    writeCurrentReport(runState.outDir, runState.specs);
    return;
  }

  const runnableByInstance = new Map<string, PilotAttemptSpec[]>();
  for (const spec of runnable) {
    (runnableByInstance.get(spec.instance_id) ?? runnableByInstance.set(spec.instance_id, []).get(spec.instance_id)!).push(spec);
  }
  const frozenById = new Map(runState.frozenInstances.map((item) => [item.ref.instance_id, item]));

  // Pipeline shape: solve lanes fan out across instances (network/API-bound,
  // cfg.solveConcurrency wide); every grade goes through one strictly-serial
  // queue (each eval pulls a multi-GB Docker image under amd64 emulation, and
  // the disk-floor check + prune are not concurrency-safe). Grades of earlier
  // attempts overlap the next solves, so even --solve-concurrency 1 pipelines.
  const gradeQueue = new SerialTaskQueue();

  await mapWithConcurrency([...runnableByInstance.entries()], cfg.solveConcurrency, async ([instanceId, specs]) => {
    const frozen = frozenById.get(instanceId);
    if (!frozen) {
      for (const spec of specs) writeAttemptRecord(runState.outDir, recordFromError(spec, 'solve-error', new Error(`missing frozen instance ${instanceId}`)));
      return;
    }
    const { instance, hfRow } = frozen;

    const enqueueGrade = (
      spec: PilotAttemptSpec,
      patch: string,
      carried: Omit<PilotAttemptRecord, 'status' | 'passed' | 'error'>,
      regraded: boolean,
    ): void => {
      gradeQueue.push(async () => {
        try {
          const passed = await gradeOne(cfg, hfRow, patch);
          writeAttemptRecord(runState.outDir, { ...carried, status: passed === null ? 'ungradeable' : 'graded', passed });
          console.log(`[pilot] result ${instance.instance_id} arm=${spec.arm} repeat=${spec.repeat}: passed=${passed} cost=$${carried.costUsd.toFixed(4)}${regraded ? ' (regraded)' : ''}`);
        } catch (gradeErr) {
          console.warn(`[pilot]   grade error for ${instance.instance_id}/${spec.arm}/${spec.repeat}: ${(gradeErr as Error).message} — recording grade-error`);
          writeAttemptRecord(runState.outDir, {
            ...carried,
            status: 'grade-error',
            passed: null,
            error: gradeErr instanceof Error ? gradeErr.message : String(gradeErr),
          });
        }
      });
    };

    // A grade-error or infra-ungradeable attempt with a saved patch already
    // paid for its solve — re-grade from the patch instead of re-spending
    // inference (and skip the clone entirely when nothing is left to solve).
    const toSolve: PilotAttemptSpec[] = [];
    for (const spec of specs) {
      const existing = records.get(attemptKey(spec));
      const patchAbsPath = existing?.patchRelPath ? join(runState.outDir, existing.patchRelPath) : null;
      const regradeable = existing?.status === 'grade-error' || existing?.status === 'ungradeable';
      if (!regradeable || !patchAbsPath || !existsSync(patchAbsPath)) {
        toSolve.push(spec);
        continue;
      }
      console.log(`[pilot] regrading ${instance.instance_id} arm=${spec.arm} repeat=${spec.repeat} from saved patch (no re-solve)...`);
      const { error: _prevError, ...carried } = existing;
      enqueueGrade(spec, readFileSync(patchAbsPath, 'utf8'), carried, true);
    }
    if (toSolve.length === 0) return;

    const baseDir = await createPilotWorkDir(cfg.outDir, `base-${instance.instance_id.replace(/[^a-zA-Z0-9_-]/g, '_')}-`);
    try {
      console.log(`[pilot] cloning ${instance.repo} @ ${instance.base_commit}...`);
      await prepareBaseCheckout(run, instance.repo, instance.base_commit, baseDir);
      for (const spec of toSolve) {
        const arm = armByName.get(spec.arm);
        if (!arm) {
          writeAttemptRecord(runState.outDir, recordFromError(spec, 'solve-error', new Error(`missing configured arm ${spec.arm}`)));
          continue;
        }
        try {
          const solved = await solveOne(cfg, instance, arm, spec.repeat, baseDir);
          const patchRelPath = writePatch(runState.outDir, spec, solved.patch);
          const carried: Omit<PilotAttemptRecord, 'status' | 'passed' | 'error'> = {
            schema: 'jinn.pilot.attempt.v1',
            instance_id: spec.instance_id,
            arm: spec.arm,
            repeat: spec.repeat,
            costUsd: solved.costUsd,
            patchRelPath,
            ...(solved.tokens ? { tokens: solved.tokens } : {}),
            ...(solved.sessionId ? { sessionId: solved.sessionId } : {}),
            ...(solved.tokenError ? { tokenError: solved.tokenError } : {}),
          };
          // Crash-recovery placeholder: if the process dies before the queued
          // grade runs, this attempt resumes as a $0 regrade-from-patch
          // instead of a re-bought solve. The grade job overwrites it.
          writeAttemptRecord(runState.outDir, {
            ...carried,
            status: 'grade-error',
            passed: null,
            error: 'grade pending (pipeline interrupted before grading; re-run with --retry-errors to regrade from the saved patch)',
          });
          enqueueGrade(spec, solved.patch, carried, false);
        } catch (solveErr) {
          console.warn(`[pilot]   solve error for ${instance.instance_id}/${spec.arm}/${spec.repeat}: ${(solveErr as Error).message} — recording solve-error, continuing`);
          writeAttemptRecord(runState.outDir, recordFromError(spec, 'solve-error', solveErr));
        }
      }
    } catch (instErr) {
      console.warn(`[pilot] instance ${instance.instance_id} failed (${(instErr as Error).message}) — recording solve-errors, continuing`);
      for (const spec of toSolve) writeAttemptRecord(runState.outDir, recordFromError(spec, 'solve-error', instErr));
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  await gradeQueue.drain();
  writeCurrentReport(runState.outDir, runState.specs);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const hfFetcher = new HttpHfFetcher();

  // Isolation gate BEFORE any freeze/spend: differing arm loadouts without
  // verified per-arm homes made the 2026-07-10 run arm-invariant. Dry runs
  // spawn no solver, so fake/absent homes are fine there.
  if (!cfg.dryRun) assertArmIsolation(cfg.arms);

  if (cfg.dryRun) {
    if (cfg.outDir) {
      await runDurableDryRun(cfg, hfFetcher);
      return;
    }
    console.log('');
    console.log('==================== DRY RUN — no spend ====================');
    console.log('Skipping clone/spawn/grade/network. Synthesizing deterministic fake outcomes.');
    const outcomes = synthesizeDryRunOutcomes(cfg);
    const rng = (() => { let s = 42; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
    const report = tallyPilot(outcomes, { rng, baselineArm: cfg.arms[0]?.name });
    printReport(report, outcomes, 'DRY RUN — no spend');
    return;
  }

  if (cfg.outDir) {
    await runDurableReal(cfg, hfFetcher);
    return;
  }

  const outcomes: SolveOutcome[] = [];
  const rng = Math.random;

  const instances = selectedInstanceRefs(cfg);

  for (const ref of instances) {
    try {
      console.log(`[pilot] fetching instance ${ref.instance_id}...`);
      const [rawRow, hfRow] = await Promise.all([
        fetchPilotRawRow(ref),
        hfFetcher.fetchTaskRow(ref),
      ]);
      const instance = parsePilotInstanceRow(rawRow, ref);

      const baseDir = await createPilotWorkDir(cfg.outDir, `base-${instance.instance_id.replace(/[^a-zA-Z0-9_-]/g, '_')}-`);
      try {
        console.log(`[pilot] cloning ${instance.repo} @ ${instance.base_commit}...`);
        // FAIL-LOUD on a bad clone/checkout: a 404'd/renamed repo or unfetchable
        // commit makes the INSTANCE ungradeable — it throws to the per-instance
        // catch below (which skips the instance and continues) instead of leaving
        // an empty repo that both arms "solve" into empty patches scored false.
        await prepareBaseCheckout(run, instance.repo, instance.base_commit, baseDir);

        for (const arm of cfg.arms) {
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
  const report = tallyPilot(outcomes, { rng, baselineArm: cfg.arms[0]?.name });
  printReport(report, outcomes);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
