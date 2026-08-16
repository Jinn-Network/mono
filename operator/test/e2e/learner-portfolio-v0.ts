/**
 * e2e-learner-portfolio-v0.ts — End-to-end test for the claude-code-learner
 * wrapper on the portfolio.v0 pipeline.
 *
 * This script is intentionally a SKELETON per Plan 3 Task 5. It:
 *
 *  1. Skips cleanly if `anvil` or the configured learner CLI is not in PATH
 *     (desired CI behavior where neither tool is available).
 *  2. Verifies that {@link buildHarnesses} registers the configured learner
 *     harness and that a {@link HarnessRegistry} using that default dispatches
 *     `portfolio.v0` restoration tasks to it.
 *  3. Spawns an Anvil fork of Base for parity with the existing
 *     `e2e-portfolio-v0` harness so a follow-up task can fill in the
 *     task-post + daemon-run + envelope-assertion sections by mirroring
 *     `operator/test/e2e/portfolio-v0.ts`.
 *
 * Follow-up: the task-post + envelope-assertion details (executor.implName
 * === configured learner harness, per-phase artifact assertions in workingDir)
 * should land once we have a known-working CLI install in the Anvil environment.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../src/harnesses/names.js';
import { checkLearnerCli, readLearnerHarnessE2EConfig } from './learner-harness-config.js';

async function main(): Promise<void> {
  const learnerConfig = readLearnerHarnessE2EConfig();

  // Pre-flight: skip if Anvil not available.
  const anvilCheck = spawnSync('anvil', ['--version']);
  if (anvilCheck.status !== 0) {
    console.log('SKIP: anvil not in PATH; install foundry to run this e2e');
    process.exit(0);
  }

  // Pre-flight: skip if configured learner CLI is unavailable.
  const cliCheck = checkLearnerCli(learnerConfig);
  if (!cliCheck.ok) {
    console.log(`SKIP: ${cliCheck.reason}`);
    process.exit(0);
  }

  console.log('=== learner portfolio.v0 e2e ===');
  console.log(`harness: ${learnerConfig.harnessName}`);
  console.log(`cli:     ${learnerConfig.cliPath} (${cliCheck.version})`);
  console.log(`model:   ${learnerConfig.model}`);

  // Spawn Anvil fork of Base.
  console.log('Starting Anvil fork...');
  const anvil: ChildProcess = spawn(
    'anvil',
    ['--fork-url', process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org', '--port', '8545'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Wait for Anvil to be ready (poll on http://127.0.0.1:8545).
  await waitForRpc('http://127.0.0.1:8545', 30_000);

  let exitCode = 0;
  try {
    // Verify configured learner is registered and dispatchable as the default.
    console.log('Verifying buildHarnesses learner registration...');
    const impls = buildHarnesses({
      stub: true,
      rpcUrl: 'http://127.0.0.1:8545',
      claudePath: learnerConfig.harnessName === CLAUDE_CODE_HARNESS ? learnerConfig.cliPath : 'claude',
      claudeModel: learnerConfig.model,
      codexPath: learnerConfig.harnessName === CODEX_HARNESS ? learnerConfig.cliPath : 'codex',
      codexModel: learnerConfig.model,
    });
    if (impls.length === 0) {
      throw new Error('buildHarnesses returned empty array');
    }
    const selected = impls.find((impl) => impl.name === learnerConfig.harnessName);
    if (!selected) {
      throw new Error(`${learnerConfig.harnessName} not registered by buildHarnesses`);
    }
    if (!selected.supports({ solverType: 'portfolio.v0', role: 'restoration' })) {
      throw new Error(`${learnerConfig.harnessName}.supports(portfolio.v0/restoration) returned false`);
    }

    const registry = new HarnessRegistry({ default: learnerConfig.harnessName });
    for (const impl of impls) registry.register(impl);
    const dispatched = registry.findFor({ solverType: 'portfolio.v0', role: 'restoration' });
    if (dispatched?.name !== learnerConfig.harnessName) {
      throw new Error(
        `registry dispatched portfolio.v0/restoration to ${dispatched?.name ?? '<none>'}; ` +
          `expected ${learnerConfig.harnessName}`,
      );
    }
    console.log(`  ✓ ${learnerConfig.harnessName} registered; registry dispatches portfolio.v0/restoration to it`);

    // Run one daemon cycle. (Reuse e2e-portfolio-v0's harness; here we
    // just inline the minimal version.)
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-e2e-dl-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-e2e-dl-state-'));
    try {
      // TODO(plan-3-followup): task post + daemon run + envelope assertion.
      // Mirror the harness in operator/test/e2e/portfolio-v0.ts:
      //   - bootstrap fleet on Anvil-forked Base (FleetBootstrapper)
      //   - operator posts a portfolio.v0 Task on-chain
      //   - daemon claims, runs the configured learner harness, packages + delivers
      //   - assert per-phase artifacts in workingDir:
      const phases = [
        'orient',
        'strategize',
        'plan',
        'execute',
        'debrief',
        'improve',
        'memory-consolidation',
      ];
      for (const phase of phases) {
        const phaseDir = join(workingDir, `.${phase}`);
        if (!existsSync(phaseDir)) {
          // SKELETON: phase artifacts are produced by the daemon-run section
          // which is not yet implemented in this script. Log what we'd check
          // and continue rather than failing — the wrapper-first registration
          // contract above is the load-bearing assertion for this task.
          console.log(`  (skeleton) would assert phase artifact present: ${phaseDir}`);
          continue;
        }
        console.log(`  ✓ ${phase} artifact present`);
      }
      // TODO(plan-3-followup): assert envelope's executor.implName === configured learner harness
      // by reading the manifest the engine packaged (mirror e2e-portfolio-v0's
      // assembleAndSignManifest + executor field assertion).
      console.log('=== e2e PASSED (skeleton; task-post + envelope assertion deferred) ===');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('e2e FAILED:', err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    if (!anvil.killed) anvil.kill('SIGTERM');
  }
  process.exit(exitCode);
}

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`RPC not ready at ${url} after ${timeoutMs}ms`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
