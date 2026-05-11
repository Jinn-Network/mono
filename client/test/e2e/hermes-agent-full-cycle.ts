/**
 * Hermes Agent harness full-cycle e2e.
 *
 * Verifies the load-bearing claim: the HermesHarness correctly wires the
 * adapter → stub binary → solution harvest pipeline for a SWE-rebench v2
 * task. The stub binary (`scripts/stub-hermes.js`) writes a valid
 * `swe-rebench-v2-solution.v1` payload and exits 0, so this test exercises
 * the full harness path without a real Hermes install.
 *
 * Configure with:
 *   JINN_HERMES_PATH=/path/to/stub-hermes.js   (defaults to scripts/stub-hermes.js
 *                                                next to this repo root)
 *
 * Gates on the stub binary being executable — skips cleanly if it isn't.
 *
 * Runtime budget: < 5 seconds (stub binary exits immediately).
 *
 * Usage:
 *   yarn e2e:hermes
 *
 * Plan: docs/superpowers/plans/2026-05-11-hermes-harness-integration.md Task 4.2
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { HERMES_AGENT_HARNESS } from '../../src/harnesses/names.js';
import type { HarnessContext } from '../../src/harnesses/types.js';
import type { Task } from '../../src/types/task.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_STUB_PATH = resolve(__dirname, '../../scripts/stub-hermes.js');
const hermesPath = process.env['JINN_HERMES_PATH'] ?? DEFAULT_STUB_PATH;

// ── Pre-flight ───────────────────────────────────────────────────────────────

function checkHermesBinary(): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(hermesPath)) {
    return { ok: false, reason: `stub hermes binary not found at ${hermesPath}` };
  }
  const check = spawnSync(hermesPath, ['--version'], { encoding: 'utf8' });
  // Stub may exit non-zero for --version (it only handles -w <dir>); that's fine.
  // The binary existing and being executable is sufficient.
  if (check.error?.code === 'EACCES' || check.error?.code === 'ENOENT') {
    return {
      ok: false,
      reason: `${hermesPath} is not executable; run: chmod +x ${hermesPath}`,
    };
  }
  return { ok: true };
}

// ── Task builder ─────────────────────────────────────────────────────────────

function buildSweTask(startTs: number, endTs: number): Task {
  return {
    id: 'hermes-e2e-swe-task-1',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    description: 'Fix the netcdf bug (hermes-agent e2e smoke test)',
    window: { startTs, endTs },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      base_commit: 'a'.repeat(40),
      language: 'c',
      problem_statement: 'Fix the netcdf issue 1925.',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      deadline_unix: Math.floor(endTs / 1000),
      round_month: '2026-05',
    },
  } as unknown as Task;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Pre-flight: skip cleanly if stub binary is not present/executable.
  const binaryCheck = checkHermesBinary();
  if (!binaryCheck.ok) {
    console.log(`SKIP: ${binaryCheck.reason}`);
    process.exit(0);
  }
  console.log(`hermes binary: ${hermesPath}`);

  console.log('=== hermes-agent full-cycle e2e ===\n');

  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-hermes-e2e-state-'));
  const workingDir = mkdtempSync(join(tmpdir(), 'jinn-hermes-e2e-work-'));

  let exitCode = 0;
  try {
    console.log(`implStateDir: ${implStateDir}`);
    console.log(`workingDir:   ${workingDir}\n`);

    // Build harness via canonical factory (same path as daemon).
    const harness = buildHarnesses({
      stub: true,
      rpcUrl: 'http://stub',
      claudePath: 'claude',
      claudeModel: 'claude-haiku-4-5-20251001',
      hermesPath,
    }).find((impl) => impl.name === HERMES_AGENT_HARNESS);

    if (!harness) {
      throw new Error(`HERMES_AGENT_HARNESS not registered in buildHarnesses`);
    }

    const startTs = Date.now();
    const endTs = startTs + 300_000; // 5-minute window
    const task = buildSweTask(startTs, endTs);
    const abort = new AbortController();
    const endTimer = setTimeout(() => abort.abort(), endTs - Date.now());

    console.log('--- running hermes harness (stub binary) ---');
    const ctx: HarnessContext = {
      task,
      requestId: 'hermes-e2e-request-1',
      solverNet: {
        name: 'hermes-agent-e2e',
        solverType: task.solverType,
        model: 'anthropic/claude-opus-4.6',
        harness: HERMES_AGENT_HARNESS,
      },
      implStateDir,
      workingDir,
      log: (event) => {
        console.log(`  [hermes-e2e:${event.level}] ${event.msg}`);
      },
      abort: abort.signal,
      msUntilEndTs: () => Math.max(0, endTs - Date.now()),
      trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
      mode: 'train',
    };

    let solution;
    try {
      solution = await harness.run(ctx);
    } finally {
      clearTimeout(endTimer);
    }

    // ── Assertions ────────────────────────────────────────────────────────────
    console.log('\n--- assertions ---');

    if (!solution) {
      throw new Error('harness.run() returned undefined solution');
    }

    if (solution.venueRef?.name !== HERMES_AGENT_HARNESS) {
      throw new Error(
        `solution.venueRef.name=${JSON.stringify(solution.venueRef?.name)} expected ${HERMES_AGENT_HARNESS}`,
      );
    }
    console.log(`  ✓ solution.venueRef.name = ${solution.venueRef.name}`);

    if (!solution.solutionPayload) {
      throw new Error('solution.solutionPayload is missing');
    }
    const payload = solution.solutionPayload as { schemaVersion?: string; patch?: string };
    if (payload.schemaVersion !== 'swe-rebench-v2-solution.v1') {
      throw new Error(
        `solution.solutionPayload.schemaVersion=${JSON.stringify(payload.schemaVersion)} ` +
          `expected 'swe-rebench-v2-solution.v1'`,
      );
    }
    console.log(`  ✓ solution.solutionPayload.schemaVersion = ${payload.schemaVersion}`);

    if (typeof payload.patch !== 'string' || payload.patch.length === 0) {
      throw new Error(`solution.solutionPayload.patch is empty or missing`);
    }
    console.log(`  ✓ solution.solutionPayload.patch present (${payload.patch.length} chars)`);

    console.log('\n=== e2e PASSED ===');
  } catch (err) {
    console.error(`\ne2e FAILED: ${err instanceof Error ? err.message : err}`);
    exitCode = 1;
  } finally {
    if (exitCode === 0) {
      rmSync(implStateDir, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    } else {
      console.log(`\nFailure artifacts preserved at:`);
      console.log(`  implStateDir: ${implStateDir}`);
      console.log(`  workingDir:   ${workingDir}`);
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
