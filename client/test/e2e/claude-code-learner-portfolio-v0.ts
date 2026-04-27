/**
 * e2e-claude-code-learner-portfolio-v0.ts — End-to-end test for the claude-code-learner
 * wrapper on the portfolio.v0 pipeline.
 *
 * This script is intentionally a SKELETON per Plan 3 Task 5. It:
 *
 *  1. Skips cleanly if `anvil` or `claude` are not in PATH (desired CI behavior
 *     where neither tool is available).
 *  2. Verifies that {@link buildRestorerImpls} registers the
 *     {@link ClaudeCodeLearnerWrapper} at index 0 and that it claims support for
 *     `portfolio.v0` — this is the most important new behavior from Plan 3 T2
 *     and can be asserted without external dependencies.
 *  3. Spawns an Anvil fork of Base for parity with the existing
 *     `e2e-portfolio-v0` harness so a follow-up task can fill in the
 *     intent-post + daemon-run + envelope-assertion sections by mirroring
 *     `client/test/e2e/portfolio-v0.ts`.
 *
 * Follow-up: the intent-post + envelope-assertion details (executor.implName
 * === 'claude-code-learner', per-phase artifact assertions in workingDir) should
 * land once we have a known-working `claude` install in the Anvil environment.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRestorerImpls } from '../../src/restorer/impls/index.js';

async function main(): Promise<void> {
  // Pre-flight: skip if Anvil not available.
  const anvilCheck = spawnSync('anvil', ['--version']);
  if (anvilCheck.status !== 0) {
    console.log('SKIP: anvil not in PATH; install foundry to run this e2e');
    process.exit(0);
  }

  // Pre-flight: skip if `claude` not available.
  const claudeCheck = spawnSync('claude', ['--version']);
  if (claudeCheck.status !== 0) {
    console.log('SKIP: claude CLI not in PATH; install Claude Code to run this e2e');
    process.exit(0);
  }

  console.log('=== claude-code-learner portfolio.v0 e2e ===');

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
    // Verify wrapper is registered FIRST.
    console.log('Verifying buildRestorerImpls wrapper registration...');
    const impls = buildRestorerImpls({
      stub: true,
      rpcUrl: 'http://127.0.0.1:8545',
      claudePath: 'claude',
      claudeModel: 'claude-haiku-4-5-20251001',
    });
    if (impls.length === 0) {
      throw new Error('buildRestorerImpls returned empty array');
    }
    const first = impls[0];
    if (!first) {
      throw new Error('buildRestorerImpls returned empty array');
    }
    if (first.name !== 'claude-code-learner') {
      throw new Error(
        `wrapper not registered first: index 0 is "${first.name}" (expected "claude-code-learner")`,
      );
    }
    if (!first.supports({ kind: 'portfolio.v0' })) {
      throw new Error('wrapper.supports(portfolio.v0) returned false');
    }
    console.log('  ✓ wrapper at index 0; supports portfolio.v0');

    // Run one daemon cycle. (Reuse e2e-portfolio-v0's harness; here we
    // just inline the minimal version.)
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-e2e-dl-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-e2e-dl-state-'));
    try {
      // TODO(plan-3-followup): intent post + daemon run + envelope assertion.
      // Mirror the harness in client/test/e2e/portfolio-v0.ts:
      //   - bootstrap fleet on Anvil-forked Base (FleetBootstrapper)
      //   - operator posts a portfolio.v0 intent on-chain
      //   - daemon claims, runs the wrapper (claude-code-learner), packages + delivers
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
      // TODO(plan-3-followup): assert envelope's executor.implName === 'claude-code-learner'
      // by reading the manifest the engine packaged (mirror e2e-portfolio-v0's
      // assembleAndSignManifest + executor field assertion).
      console.log('=== e2e PASSED (skeleton; intent-post + envelope assertion deferred) ===');
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
