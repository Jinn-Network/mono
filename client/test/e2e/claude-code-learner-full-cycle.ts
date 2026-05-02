/**
 * Automated two-cycle full-cycle e2e for the claude-code-learner plugin.
 *
 * Verifies the load-bearing claim: between cycle 1 and cycle 2, `implStateDir`
 * HEAD sha advances AND cycle 2's coordinator boot reads the new sha.
 *
 * This script invokes the `claude` CLI directly with the plugin loaded
 * (--plugin-dir) — it does NOT go through the engine. The daemon-path
 * verification (engine → wrapper → shim → adapter → claude) is a separate
 * concern; this script focuses on the loop semantics.
 *
 * Gates on `claude` availability — skips cleanly with a clear message when
 * the CLI isn't in PATH (e.g. CI without Claude Code installed).
 *
 * Runtime budget: each cycle takes ~5-10 min as the agent walks through
 * Orient → Strategize → Plan → Execute → Debrief → Improve → Memory
 * consolidation, spawning specialized subagents per phase. Total: ~15-20 min.
 *
 * Usage:
 *   yarn e2e:full-cycle
 *
 * Plan 4 T3 / bd jinn-mono-iee.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const PLUGIN_PATH = join(PACKAGE_ROOT, 'plugins', 'claude-code-learner');

const PHASES = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

interface CycleParams {
  cycleLabel: string;
  intentId: string;
  intentDescription: string;
  fieldValue: string;
  workingDir: string;
  implStateDir: string;
}

interface CycleResult {
  exitCode: number;
  durationMs: number;
  phasesPresent: string[];
  bootJson: BootJson | null;
  outputJson: unknown | null;
  implStateDirHeadAfter: string;
}

interface BootJson {
  implStateDirShaAtStart: string;
  skillBundleCid?: string;
  intentId: string;
  windowEndTs: number;
}

async function main(): Promise<void> {
  // Pre-flight: skip cleanly if claude not available.
  const claudeCheck = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (claudeCheck.status !== 0) {
    console.log('SKIP: claude CLI not in PATH; install Claude Code to run this e2e');
    process.exit(0);
  }
  console.log(`claude CLI: ${claudeCheck.stdout.trim()}`);

  // Pre-flight: confirm plugin exists.
  if (!existsSync(PLUGIN_PATH)) {
    console.error(`FAIL: plugin not found at ${PLUGIN_PATH}`);
    process.exit(1);
  }
  console.log(`plugin: ${PLUGIN_PATH}`);

  console.log('=== claude-code-learner full-cycle e2e ===\n');

  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-state-'));
  const cycle1WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-c1-'));
  const cycle2WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-c2-'));

  let exitCode = 0;
  try {
    console.log(`implStateDir:   ${implStateDir}`);
    console.log(`cycle 1 work:   ${cycle1WorkingDir}`);
    console.log(`cycle 2 work:   ${cycle2WorkingDir}\n`);

    // ── CYCLE 1 ─────────────────────────────────────────────────────────────
    console.log('--- CYCLE 1 ---');
    const cycle1 = await runCycle({
      cycleLabel: 'cycle-1',
      intentId: 'fullcycle-c1',
      intentDescription:
        "Trivial smoke test. Write a JSON file with three fields named foo, bar, baz, each containing the string 'hello'. Output to workingDir/output.json.",
      fieldValue: 'hello',
      workingDir: cycle1WorkingDir,
      implStateDir,
    });

    assertCycle(cycle1, {
      label: 'cycle-1',
      requireBootJson: true,
      requireOutputJson: { foo: 'hello', bar: 'hello', baz: 'hello' },
    });

    const sha1 = cycle1.implStateDirHeadAfter;
    console.log(`  cycle 1 ended; implStateDir HEAD = ${sha1.slice(0, 8)}\n`);

    // ── CYCLE 2 ─────────────────────────────────────────────────────────────
    console.log('--- CYCLE 2 ---');
    const cycle2 = await runCycle({
      cycleLabel: 'cycle-2',
      intentId: 'fullcycle-c2',
      intentDescription:
        "Second cycle. Same kind as cycle 1 — write a JSON output file with three fields named foo, bar, baz, each containing the string 'world' (different value). The implStateDir already contains content from cycle 1; the agent should leverage it.",
      fieldValue: 'world',
      workingDir: cycle2WorkingDir,
      implStateDir,
    });

    assertCycle(cycle2, {
      label: 'cycle-2',
      requireBootJson: true,
      requireOutputJson: { foo: 'world', bar: 'world', baz: 'world' },
    });

    const sha2 = cycle2.implStateDirHeadAfter;
    console.log(`  cycle 2 ended; implStateDir HEAD = ${sha2.slice(0, 8)}\n`);

    // ── LOAD-BEARING ASSERTIONS ─────────────────────────────────────────────
    console.log('--- LOAD-BEARING ASSERTIONS ---');

    if (sha1 === sha2) {
      throw new Error(
        `implStateDir HEAD did not advance between cycles. sha1=${sha1} sha2=${sha2}. ` +
          `Improve did not commit anything in cycle 2 — the learner is not learning across runs.`,
      );
    }
    console.log(`  ✓ implStateDir HEAD advanced cycle1→cycle2: ${sha1.slice(0, 8)} → ${sha2.slice(0, 8)}`);

    if (cycle2.bootJson === null) {
      throw new Error(`cycle 2 boot.json missing; cannot verify implStateDirShaAtStart`);
    }
    if (cycle2.bootJson.implStateDirShaAtStart !== sha1) {
      throw new Error(
        `cycle 2 boot.json.implStateDirShaAtStart=${cycle2.bootJson.implStateDirShaAtStart} ` +
          `did not match cycle 1's final HEAD ${sha1}. ` +
          `Cycle 2's coordinator did not read the updated implStateDir.`,
      );
    }
    console.log(`  ✓ cycle 2 boot.json.implStateDirShaAtStart matches cycle 1's HEAD`);

    const commitsBetweenCycles = execFileSync(
      'git',
      ['-C', implStateDir, 'log', '--oneline', `${sha1}..${sha2}`],
      { encoding: 'utf8' },
    ).trim();
    if (commitsBetweenCycles === '') {
      throw new Error(
        `no commits between cycle 1 (${sha1.slice(0, 8)}) and cycle 2 (${sha2.slice(0, 8)}); ` +
          `but HEAD differs — investigate`,
      );
    }
    console.log(`  ✓ ${commitsBetweenCycles.split('\n').length} commit(s) between cycles:`);
    for (const line of commitsBetweenCycles.split('\n')) {
      console.log(`      ${line}`);
    }

    console.log('\n=== e2e PASSED ===');
  } catch (err) {
    console.error(`\ne2e FAILED: ${err instanceof Error ? err.message : err}`);
    exitCode = 1;
  } finally {
    // Preserve artifacts on failure for postmortem; clean up on success.
    if (exitCode === 0) {
      rmSync(implStateDir, { recursive: true, force: true });
      rmSync(cycle1WorkingDir, { recursive: true, force: true });
      rmSync(cycle2WorkingDir, { recursive: true, force: true });
    } else {
      console.log(`\nFailure artifacts preserved at:`);
      console.log(`  implStateDir: ${implStateDir}`);
      console.log(`  cycle 1 work: ${cycle1WorkingDir}`);
      console.log(`  cycle 2 work: ${cycle2WorkingDir}`);
    }
  }
  process.exit(exitCode);
}

async function runCycle(params: CycleParams): Promise<CycleResult> {
  const startedAt = Date.now();
  const startTs = startedAt;
  const endTs = startedAt + 600_000; // 10-minute window per cycle

  const intent = {
    id: params.signedTaskId,
    description: params.signedTaskDescription,
    solverType: 'smoke-test',
    window: { startTs, endTs },
    spec: { fieldNames: ['foo', 'bar', 'baz'], fieldValue: params.fieldValue },
  };

  const prompt = [
    'You are running a Jinn restoration Task. Use the Skill tool to invoke',
    "'claude-code-learner:coordinator' and run the FULL seven-phase pipeline",
    '(Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation).',
    '',
    'Session inputs:',
    `- intent = ${JSON.stringify(intent)}`,
    `- workingDir = ${params.workingDir}`,
    `- implStateDir = ${params.implStateDir}`,
    `- msUntilEndTs = ${endTs - startTs}`,
    '',
    'Run all phases. For Improve: even if Debrief found no major issues, write at',
    'least one trivial improvement (e.g. a note in implStateDir/notes/) so the',
    'cross-cycle test can verify Improve actually mutates implStateDir.',
    '',
    'Exit cleanly when all phases are done.',
  ].join('\n');

  const env = { ...process.env, IMPL_STATE_DIR: params.implStateDir };
  const args = ['--plugin-dir', PLUGIN_PATH, '-p', prompt];

  console.log(`  spawning claude (cycle window 10min)...`);
  const exitCode = await new Promise<number>((resolveSpawn, rejectSpawn) => {
    const child: ChildProcess = spawn('claude', args, {
      env,
      cwd: params.workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (d: Buffer) => {
      // Stream brief progress lines as they arrive.
      const txt = d.toString().trim();
      if (txt) {
        // Truncate to keep output readable.
        for (const line of txt.split('\n').slice(0, 3)) {
          console.log(`    [${params.cycleLabel}] ${line.slice(0, 180)}`);
        }
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      const txt = d.toString().trim();
      if (txt) console.error(`    [${params.cycleLabel}:err] ${txt.slice(0, 200)}`);
    });

    child.on('exit', (code) => resolveSpawn(code ?? -1));
    child.on('error', rejectSpawn);
  });

  const durationMs = Date.now() - startedAt;
  console.log(`  claude exited ${exitCode} after ${Math.round(durationMs / 1000)}s`);

  // Capture phase presence + boot.json + output.json + final implStateDir HEAD.
  const phasesPresent = PHASES.filter((p) => existsSync(join(params.workingDir, `.${p}`)));
  const bootJsonPath = join(params.workingDir, '.coordinator', 'boot.json');
  const bootJson: BootJson | null = existsSync(bootJsonPath)
    ? (JSON.parse(readFileSync(bootJsonPath, 'utf8')) as BootJson)
    : null;
  const outputJsonPath = join(params.workingDir, 'output.json');
  const outputJson: unknown | null = existsSync(outputJsonPath)
    ? JSON.parse(readFileSync(outputJsonPath, 'utf8'))
    : null;
  const implStateDirHeadAfter = execFileSync('git', ['-C', params.implStateDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  return { exitCode, durationMs, phasesPresent, bootJson, outputJson, implStateDirHeadAfter };
}

interface AssertOptions {
  label: string;
  requireBootJson: boolean;
  requireOutputJson: Record<string, string>;
}

function assertCycle(result: CycleResult, opts: AssertOptions): void {
  if (result.exitCode !== 0) {
    throw new Error(`${opts.label}: claude exited with code ${result.exitCode}`);
  }
  for (const phase of PHASES) {
    if (!result.phasesPresent.includes(phase)) {
      throw new Error(`${opts.label}: phase artifact missing for '${phase}'`);
    }
  }
  console.log(`  ✓ ${opts.label} produced all 7 phase artifacts`);

  if (opts.requireBootJson) {
    if (result.bootJson === null) {
      throw new Error(`${opts.label}: workingDir/.coordinator/boot.json missing`);
    }
    if (typeof result.bootJson.implStateDirShaAtStart !== 'string') {
      throw new Error(`${opts.label}: boot.json.implStateDirShaAtStart not a string`);
    }
    console.log(
      `  ✓ ${opts.label} boot.json captures implStateDirShaAtStart=${result.bootJson.implStateDirShaAtStart.slice(0, 8)}`,
    );
  }

  if (opts.requireOutputJson) {
    if (result.outputJson === null) {
      throw new Error(`${opts.label}: workingDir/output.json missing`);
    }
    const got = result.outputJson as Record<string, string>;
    for (const [k, v] of Object.entries(opts.requireOutputJson)) {
      if (got[k] !== v) {
        throw new Error(`${opts.label}: output.json.${k}=${JSON.stringify(got[k])} expected ${JSON.stringify(v)}`);
      }
    }
    console.log(`  ✓ ${opts.label} output.json matches expected ${JSON.stringify(opts.requireOutputJson)}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
