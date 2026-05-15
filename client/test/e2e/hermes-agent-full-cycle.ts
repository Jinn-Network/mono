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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// SolverPlugin roots for SWE-rebench v2 — `network-tools` (jinn-runtime MCP
// tools) and `swe-rebench-v2-runtime` (orient/plan skills). Mounted into the
// per-Task Hermes config (`mcp_servers:` + `skills.external_dirs:`) the same
// way the daemon does. With the stub binary they're inert; with a real binary
// the MCP server tries to reach the daemon at DAEMON_API_URL — if no daemon is
// running there it logs a warning and Hermes continues without those tools.
const NETWORK_TOOLS_ROOT = resolve(__dirname, '../../plugins/network-tools');
const SWE_RUNTIME_ROOT = resolve(__dirname, '../../plugins/swe-rebench-v2-runtime');
// For a real-binary run, set the model/provider the operator configured (the
// stub ignores them). E.g. `JINN_HERMES_MODEL=gemini-3-flash-preview
// JINN_HERMES_PROVIDER=google-gemini-cli`. Left unset → no `--model`/`--provider`
// flags → Hermes resolves from its config (fine for the stub).
const hermesModel = process.env['JINN_HERMES_MODEL'] || undefined;
const hermesProvider = process.env['JINN_HERMES_PROVIDER'] || undefined;

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

// A tractable stand-in task. The stub binary ignores it entirely (it just
// writes a fixed solution payload). A real Hermes binary CAN do it: clone the
// tiny `octocat/Hello-World` repo at a stable commit, append one line to the
// README, produce the unified diff. (A real SWE-rebench v2 instance would need
// HF network access + the upstream repo at a real `base_commit`; that path is
// covered separately by the SWE-rebench v2 SolverNet e2es / real-infra script.)
function buildSweTask(startTs: number, endTs: number): Task {
  return {
    id: 'hermes-e2e-swe-task-1',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    description: 'Append a marker line to README (hermes-agent full-cycle e2e)',
    window: { startTs, endTs },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'octocat__Hello-World-1',
      repo: 'octocat/Hello-World',
      base_commit: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
      language: 'text',
      problem_statement:
        'Append a new line containing exactly `hermes-real-run-ok` to the README file. ' +
        'Produce the change as a unified diff.',
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
      ...(hermesModel ? { hermesModel } : {}),
      ...(hermesProvider ? { hermesProvider } : {}),
    }).find((impl) => impl.name === HERMES_AGENT_HARNESS);

    if (!harness) {
      throw new Error(`HERMES_AGENT_HARNESS not registered in buildHarnesses`);
    }

    const startTs = Date.now();
    const endTs = startTs + 300_000; // 5-minute window
    const task = buildSweTask(startTs, endTs);
    const abort = new AbortController();
    const endTimer = setTimeout(() => abort.abort(), endTs - Date.now());

    const isStub = hermesPath === DEFAULT_STUB_PATH;
    console.log(`--- running hermes harness (${isStub ? 'stub binary' : 'real binary: ' + hermesPath}) ---`);
    const ctx: HarnessContext = {
      task,
      requestId: 'hermes-e2e-request-1',
      solverNet: {
        name: 'hermes-agent-e2e',
        solverType: task.solverType,
        // No per-SolverNet model override here — the adapter falls back to the
        // daemon-level `hermesModel` (JINN_HERMES_MODEL for a real run; unset
        // for the stub). A hardcoded model would override that with a provider
        // the operator may not have credentials for.
      },
      implStateDir,
      workingDir,
      solverPluginRoots: [NETWORK_TOOLS_ROOT, SWE_RUNTIME_ROOT],
      log: (event) => {
        console.log(`  [hermes-e2e:${event.level}] ${event.msg}`);
      },
      abort: abort.signal,
      msUntilEndTs: () => Math.max(0, endTs - Date.now()),
      trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
      mode: 'train',
    };

    let solution;
    let runErr: unknown = null;
    try {
      solution = await harness.run(ctx);
    } catch (e) {
      runErr = e;
    } finally {
      clearTimeout(endTimer);
    }

    // ── Artifacts (always dump, for real-binary runs especially) ──────────────
    const dumpFile = (label: string, path: string, tailLines = 0): void => {
      if (!existsSync(path)) {
        console.log(`  (${label}: not present at ${path})`);
        return;
      }
      const content = readFileSync(path, 'utf8');
      const lines = content.split('\n');
      const shown = tailLines > 0 && lines.length > tailLines ? lines.slice(-tailLines) : lines;
      console.log(`\n--- ${label} (${path}) ---`);
      console.log(shown.join('\n'));
    };
    console.log('\n=== artifacts ===');
    dumpFile('per-Task config.yaml', join(implStateDir, 'config.yaml'));
    console.log(`  auth/ seeded: ${existsSync(join(implStateDir, 'auth', 'google_oauth.json')) ? 'yes' : 'no'}`);
    dumpFile('hermes stdout (tail)', join(workingDir, '.hermes-agent', 'stdout.log'), 40);
    dumpFile('hermes stderr (tail)', join(workingDir, '.hermes-agent', 'stderr.log'), 40);
    dumpFile('harvested solution-payload.json', join(workingDir, '.execute', 'solution-payload.json'));

    if (runErr) {
      throw runErr instanceof Error ? runErr : new Error(String(runErr));
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
    const keep = process.env['JINN_HERMES_E2E_KEEP'] === '1';
    if (exitCode === 0 && !keep) {
      rmSync(implStateDir, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    } else {
      const label = exitCode === 0 ? 'Success artifacts preserved' : 'Failure artifacts preserved';
      console.log(`\n${label} at:`);
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
