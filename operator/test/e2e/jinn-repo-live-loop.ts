// operator/test/e2e/jinn-repo-live-loop.ts
/**
 * jinn-repo.v1 LIVE-ISSUE on-chain loop driver (issue #1891).
 *
 * Proves the full Creation → Execution → Evaluation → Knowledge loop for a
 * `source: 'live-issue'` jinn-repo task end-to-end on a local Anvil fork, for
 * ONE operator that both "solves" AND self-evaluates
 * (disallowSolverSelfEvaluation = false — mirrors `jinn-repo-loop.ts`).
 *
 * Unlike `jinn-repo-loop.ts` (which spawns the real `claude` CLI as the
 * solver), this driver has NO solver leg: a live-issue task has no gold to
 * grade against, so the point of this script is to exercise the MECHANICAL
 * evaluator (`JinnRepoEvaluatorHarness`'s live-issue branch →
 * `live-eval-runner.ts`), not a solve. A deterministic, zero-credential
 * synthetic restoration Harness (mirrors `PredictionV1BaselineImpl`'s
 * pattern) delivers a pre-built SYNTHETIC patch instantly; the real daemon
 * pipeline (claim → execute → deliver → evaluate → verdict) carries it from
 * there, unmodified.
 *
 * Flow (mirrors jinn-repo-loop.ts / daemon-harness-cycle.ts):
 *   Anvil fork → mock IPFS → bootstrapStakedOperator → fund creator
 *   → deployMinimalV3Stack → startDaemon(extraHarnesses: [synthetic solver])
 *   → postJinnRepoLiveTask → waitForDaemonClaim → waitForDelivery
 *   → readActivityCount (before) → waitForVerdict → readActivityCount (after)
 *   → assert PASS + activity counter incremented (attempt finalized).
 *
 * The synthetic patch is a comment-only, one-line change to an existing,
 * stable operator/ source file whose mirrored test already exists — real
 * `git apply`, real `yarn install`, real `tsc --noEmit`, real `vitest run`,
 * scoped to that one mirrored test file (not client's full ~7000-test
 * suite). `JINN_MONO_REPO_URL` defaults to a fast local `file://` checkout of
 * THIS worktree (no GitHub network needed for the clone; `yarn
 * install`/`tsc`/`vitest` still run for real).
 *
 * Env:
 *   JINN_MONO_REPO_URL   evaluator clone URL (file://... for speed; default:
 *                        this worktree's repo root)
 *   JINN_REPO_LIVE_LOOP_BASE_COMMIT  override the base commit (default: HEAD)
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';

import {
  setupAnvilFixture,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  startDaemon,
  startMockIpfsServer,
  waitForDaemonClaim,
  waitForDelivery,
  waitForVerdict,
  readActivityCount,
  ANVIL_PRIVATE_KEYS,
} from './_daemon-harness-helpers.js';
import { postJinnRepoLiveTask } from './_jinn-repo-loop-helpers.js';
import { JinnRepoLiveIssueTaskSchema } from '../../src/solver-types/jinn-repo.js';
import { JinnRepoSolutionPayloadSchema } from '@jinn-network/sdk/solvernets/jinn-repo';
import { loadSolverNets } from '../../src/solver-nets/registry.js';
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../../src/harnesses/types.js';
import type { Task } from '../../src/types/task.js';

const sh = promisify(execFile);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
// operator/test/e2e -> operator/test -> client -> repo root
const REPO_ROOT = join(__dirname, '../../..');

const SOLVE_LEG_TIMEOUT_MS = 60_000; // synthetic solver runs instantly — headroom for daemon polling only
const EVAL_LEG_TIMEOUT_MS = 10 * 60_000; // real clone + yarn install + tsc + vitest, cold cache possible

// A comment-only, one-line change to an existing stable file whose mirrored
// test (operator/test/solver-types/jinn-repo-admit.test.ts) already exists —
// exercises real applies/typecheck/tests gates, scoped (not the full suite).
const TARGET_FILE = 'operator/src/solver-types/jinn-repo-admit.ts';
const SYNTHETIC_PATCH = [
  'diff --git a/client/src/solver-types/jinn-repo-admit.ts b/client/src/solver-types/jinn-repo-admit.ts',
  'index 0000000..0000001 100644',
  '--- a/client/src/solver-types/jinn-repo-admit.ts',
  '+++ b/client/src/solver-types/jinn-repo-admit.ts',
  '@@ -4,6 +4,7 @@',
  ' type RunFn = (args: { task: JinnRepoPoolItem; patch: string; goldTests: Record<string, string>; monoRepoUrl: string }) => Promise<JinnRepoEvalResult>;',
  '',
  '+// jinn-repo-live-loop e2e marker — synthetic no-op comment (issue #1891).',
  ' export interface AdmissionVerdict { admitted: boolean; reason: string; }',
  '',
  ' export async function validateAdmissible(',
  '   item: JinnRepoPoolItem,',
].join('\n');

/**
 * Deterministic, zero-credential restoration Harness for jinn-repo.v1 — the
 * "solver leg" this driver deliberately skips. Mirrors
 * `PredictionV1BaselineImpl`'s pattern: no LLM, no subprocess, an instant
 * canned solutionPayload so the daemon's real claim → execute → deliver
 * pipeline has something genuine to carry.
 */
class SyntheticJinnRepoSolver implements Harness {
  readonly name = 'jinn-repo-live-loop-synthetic-solver';
  readonly version = '1.0.0';

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'jinn-repo.v1' && ctx.role === 'restoration';
  }

  async isReady(): Promise<ReadyStatus> {
    return { ready: true };
  }

  async canAttempt(_task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    return { ok: true };
  }

  async run(_ctx: HarnessContext): Promise<Solution> {
    return {
      venueRef: { name: 'jinn-repo' },
      gating: {},
      solutionPayload: {
        schemaVersion: 'jinn-repo-solution.v1',
        patch: SYNTHETIC_PATCH,
      },
    };
  }
}

async function main(): Promise<void> {
  const monoRepoUrl = process.env['JINN_MONO_REPO_URL'] ?? `file://${REPO_ROOT}`;
  const { stdout: headSha } = await sh('git', [
    '-C',
    REPO_ROOT,
    'rev-parse',
    process.env['JINN_REPO_LIVE_LOOP_BASE_COMMIT'] ?? 'HEAD',
  ]);
  const baseCommit = headSha.trim();

  console.log('\n=== jinn-repo.v1 LIVE-ISSUE on-chain loop (issue #1891) ===');
  console.log(`evaluator clone URL: ${monoRepoUrl}`);
  console.log(`base_commit: ${baseCommit}`);
  console.log(`target file (synthetic patch): ${TARGET_FILE}`);

  const liveTask = JinnRepoLiveIssueTaskSchema.parse({
    schemaVersion: 'jinn-repo.v1',
    source: 'live-issue',
    instance_id: 'Jinn-Network__mono-1891-live-loop',
    repo: 'Jinn-Network/mono',
    base_commit: baseCommit,
    language: 'typescript',
    problem_statement:
      'jinn-repo-live-loop e2e marker (issue #1891) — synthetic no-op instance, ' +
      'not a real GitHub issue. Exercises the mechanical evaluator only.',
    issue_number: 1891,
  });

  // The daemon's default-constructed JinnRepoEvaluatorHarness resolves
  // monoRepoUrl from this env var at grade-call time (mirrors the merged-pr
  // JinnRepoEvaluator's resolution order) — must be set before the
  // evaluation leg runs.
  process.env['JINN_MONO_REPO_URL'] = monoRepoUrl;

  const fixture = await setupAnvilFixture();
  const mockIpfs = await startMockIpfsServer();
  let ok = false;

  try {
    console.log(`anvil rpc: ${fixture.anvil.rpcUrl}`);
    console.log(`mock IPFS: ${mockIpfs.baseUrl}`);

    const operator = await bootstrapStakedOperator(fixture);
    console.log(`agent EOA: ${operator.agentAddress}`);
    console.log(`Safe:      ${operator.safeAddress}`);

    const CREATOR_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
    const DEPLOYER_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
    const { privateKeyToAccount } = await import('viem/accounts');
    const creatorAddress = privateKeyToAccount(CREATOR_PRIV_KEY).address;
    const { jsonRpc: anvilJsonRpc } = await import('../_support/chain/anvil.js');
    await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
      creatorAddress,
      '0x56bc75e2d63100000', // 100 ETH
    ]);
    console.log(`creator EOA: ${creatorAddress}`);

    const v3Env = await deployMinimalV3Stack(fixture, operator, DEPLOYER_PRIV_KEY);
    console.log(`V3 router: ${v3Env.routerAddress}`);
    console.log(`mock mech: ${v3Env.mockMechAddress}`);

    const solverNetRegistry = await loadSolverNets({
      executionWiring: [{
        workKind: 'jinn-repo.v1',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: [],
        credentialRef: 'claude-code-default',
        isolationPolicy: 'process',
        legacyManifestDigest: 'jinn-repo.v1',
      }],
    });

    const syntheticSolver = new SyntheticJinnRepoSolver();
    const running = await startDaemon(
      fixture,
      operator,
      'prediction-v1-baseline', // no LLM harness selected — the synthetic solver handles jinn-repo.v1 restoration
      mockIpfs.baseUrl,
      v3Env,
      mockIpfs.baseUrl,
      undefined,
      { 'jinn-repo.v1': syntheticSolver.name },
      solverNetRegistry,
      [syntheticSolver],
    );
    console.log(`daemon started — jinn-repo.v1 restoration → ${syntheticSolver.name} (synthetic, no solve leg)`);

    try {
      const activityBefore = await readActivityCount(fixture, operator, v3Env);
      console.log(`activity weight before: ${activityBefore}`);

      const posted = await postJinnRepoLiveTask(
        fixture,
        operator,
        CREATOR_PRIV_KEY,
        mockIpfs,
        v3Env,
        liveTask,
      );
      console.log(`posted live task: id=${posted.taskId} cidDigest=${posted.taskCidDigest}`);

      const claim = await waitForDaemonClaim(fixture, posted, operator, v3Env, SOLVE_LEG_TIMEOUT_MS);
      console.log(`claimed: requestId=${claim.requestId} tx=${claim.txHash}`);

      const delivered = await waitForDelivery(fixture, claim, v3Env, mockIpfs, SOLVE_LEG_TIMEOUT_MS);
      console.log(`delivered: tx=${delivered.deliveryTxHash} solver=${delivered.solverHarnessName}`);

      const solutionPayload = JinnRepoSolutionPayloadSchema.parse(delivered.envelope.payload);
      const patchDelivered = solutionPayload.patch === SYNTHETIC_PATCH;
      console.log(`delivered patch matches synthetic fixture: ${patchDelivered}`);
      if (!patchDelivered) {
        throw new Error('FAIL: delivered patch did not match the synthetic fixture patch');
      }

      console.log('waiting for the mechanical evaluator (real clone + yarn install + tsc + vitest)...');
      const verdict = await waitForVerdict(fixture, posted, operator, v3Env, EVAL_LEG_TIMEOUT_MS);
      // verdictCode: 1=Pass, 2=Fail, 3=Invalid, 4=Unresolved.
      console.log(`verdict: tx=${verdict.verdictTxHash} code=${verdict.verdictCode}`);

      const activityAfter = await readActivityCount(fixture, operator, v3Env);
      console.log(`activity weight after: ${activityAfter}`);
      const activityIncremented = activityAfter > activityBefore;
      console.log(`activity counter incremented (attempt finalized): ${activityIncremented}`);

      const passed = verdict.verdictCode === 1;
      ok = passed && activityIncremented;

      if (!passed) {
        console.error(`\n=== FAIL: mechanical evaluator did not PASS the synthetic patch (code=${verdict.verdictCode}) ===`);
      }
      if (!activityIncremented) {
        console.error('\n=== FAIL: activity counter did not increment — attempt did not finalize ===');
      }
    } finally {
      await running.stop();
    }
  } finally {
    await mockIpfs.close();
    await fixture.teardown();
  }

  const evidenceOut = process.env['JINN_RUN_EVIDENCE_OUT'] ?? '/tmp/jinnrepo_live_loop_evidence.json';
  writeFileSync(evidenceOut, `${JSON.stringify({ ok, monoRepoUrl, baseCommit }, null, 2)}\n`);
  console.log(`\nwrote run evidence -> ${evidenceOut}`);

  if (!ok) {
    console.error('\n=== FAIL: live-issue loop did not complete successfully ===');
    process.exit(1);
  }
  console.log('\n=== OK: full on-chain live-issue loop completed (verdict PASS, activity incremented) ===');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
