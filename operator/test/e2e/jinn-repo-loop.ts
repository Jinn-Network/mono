// operator/test/e2e/jinn-repo-loop.ts
/**
 * jinn-repo.v1 on-chain loop driver.
 *
 * Proves the full Creation → Execution → Evaluation → Knowledge loop for the
 * `jinn-repo.v1` SolverType end-to-end on a local Anvil fork, for ONE operator
 * that both solves AND self-evaluates (disallowSolverSelfEvaluation = false).
 *
 * Flow (mirrors daemon-harness-cycle.ts):
 *   Anvil fork → mock IPFS → bootstrapStakedOperator → fund creator
 *   → deployMinimalV3Stack → startDaemon('claude-code', extra jinn-repo.v1 map)
 *   → for each of the first N pool items:
 *       postJinnRepoTask → waitForDaemonClaim → waitForDelivery → waitForVerdict
 *
 * Solver side: the claude-code learner checks out mono@base_commit, the agent
 * produces a fix, and the working-tree git diff (test hunks stripped) is
 * harvested into a jinn-repo-solution.v1 payload.
 *
 * Evaluator side: the JinnRepoEvaluatorHarness clones mono (JINN_MONO_REPO_URL
 * → fast local file:// checkout), applies the candidate patch, overwrites the
 * gold tests, installs deps, and runs the scoped gold test → PASS/FAIL verdict
 * on-chain.
 *
 * Env:
 *   JINN_REPO_LOOP_N         number of pool items to drive (default 1)
 *   JINN_CLAUDE_MODEL        solver model (e.g. claude-sonnet-4-6)
 *   JINN_MONO_REPO_URL       evaluator clone URL (file://... for speed)
 *   ANTHROPIC_API_KEY        required for the claude-code solver leg
 */
import {
  selectorToHarnessName,
  setupAnvilFixture,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  startDaemon,
  startMockIpfsServer,
  waitForDaemonClaim,
  waitForDelivery,
  waitForVerdict,
  ANVIL_PRIVATE_KEYS,
} from './_daemon-harness-helpers.js';
import { postJinnRepoTask } from './_jinn-repo-loop-helpers.js';
import {
  loadJinnRepoPool,
  type JinnRepoPoolItem,
} from '../../src/solver-types/_jinn-repo-pool.js';
import { JinnRepoSolutionPayloadSchema } from '@jinn-network/sdk/solvernets/jinn-repo';
import { loadSolverNets } from '../../src/solver-nets/registry.js';
import { jsonRpc as anvilJsonRpc } from '../_support/chain/anvil.js';
import { writeFileSync } from 'node:fs';

const LEG_TIMEOUT_MS = 40 * 60_000; // 40 min — headroom over the observed solve range
// (12–26 min). With non-applying patches now graded FAIL fast (no eval hang), the
// daemon never backs up, so a generous solve window does not cascade.

interface LoopRecord {
  instanceId: string;
  baseCommit: string;
  taskTx: string;
  claimTx: string;
  solutionTx: string;
  verdictTx: string;
  verdictCode: number | 'n/a';
  passed: boolean | 'n/a';
  patchNonEmpty: boolean | 'n/a';
  patch: string; // full delivered patch — for independent verdict sense-check
}

function firstLines(text: string, n: number): string {
  return text.split('\n').slice(0, n).join('\n');
}

async function main(): Promise<void> {
  // The solver leg uses the `claude` CLI (claude-code learner). The CLI
  // authenticates on its own (ANTHROPIC_API_KEY or an OAuth/subscription
  // login), so we do not hard-gate on the env var here — `claude` resolves its
  // own credentials. If the CLI is unauthenticated the solve leg will fail
  // loudly and the summary table will show it.
  const N = Math.max(1, Number(process.env['JINN_REPO_LOOP_N'] ?? '1'));
  console.log(`\n=== jinn-repo.v1 on-chain loop — N=${N} ===`);

  const pool = loadJinnRepoPool();
  if (pool.length === 0) {
    throw new Error('jinn-repo pool is empty — build the default-path pool first');
  }
  const items: JinnRepoPoolItem[] = pool.slice(0, N);
  console.log(`pool items: ${items.map((i) => i.instance_id).join(', ')}`);
  console.log(`evaluator clone URL: ${process.env['JINN_MONO_REPO_URL'] ?? 'github (default)'}`);
  console.log(`solver model: ${process.env['JINN_CLAUDE_MODEL'] ?? '(default)'}`);

  const fixture = await setupAnvilFixture();
  const mockIpfs = await startMockIpfsServer();
  const records: LoopRecord[] = [];
  let anyFailed = false;

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
    await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
      creatorAddress,
      '0x56bc75e2d63100000', // 100 ETH
    ]);
    console.log(`creator EOA: ${creatorAddress}`);

    const v3Env = await deployMinimalV3Stack(fixture, operator, DEPLOYER_PRIV_KEY);
    console.log(`V3 router: ${v3Env.routerAddress}`);
    console.log(`mock mech: ${v3Env.mockMechAddress}`);

    // Build a SolverNetRegistry with a jinn-repo.v1 net (solver + evaluator
    // roles) so the engine (a) admits jinn-repo.v1 claims and (b) resolves the
    // bundled jinn-repo-runtime plugin into the solver's plugin roots — that
    // SKILL tells the agent to checkout mono@base_commit into $workingDir/repo.
    const solverNetRegistry = await loadSolverNets({
      executionWiring: [{
        workKind: 'jinn-repo.v1',
        harness: 'claude-code',
        model: process.env['JINN_CLAUDE_MODEL'] ?? 'claude-haiku-4-5-20251001',
        plugins: [],
        credentialRef: 'claude-code-default',
        isolationPolicy: 'process',
        legacyManifestDigest: 'jinn-repo.v1',
      }],
    });

    // Force jinn-repo.v1 restoration onto the claude-code learner. The
    // evaluation leg first-matches JinnRepoEvaluatorHarness (claude-code does
    // not support evaluation), so a single entry is safe for both legs.
    const claudeName = selectorToHarnessName('claude-code');
    const running = await startDaemon(
      fixture,
      operator,
      'claude-code',
      mockIpfs.baseUrl, // ipfsGatewayUrl — task fetch
      v3Env,
      mockIpfs.baseUrl, // ipfsRegistryUrl — envelope upload
      undefined, // opts
      { 'jinn-repo.v1': claudeName }, // extraSolverTypeHarnesses
      solverNetRegistry,
    );
    console.log(`daemon started — jinn-repo.v1 → ${claudeName}`);

    try {
      for (const item of items) {
        console.log(`\n--- instance ${item.instance_id} ---`);
        const rec: LoopRecord = {
          instanceId: item.instance_id,
          baseCommit: item.base_commit,
          taskTx: '-',
          claimTx: '-',
          solutionTx: '-',
          verdictTx: '-',
          verdictCode: 'n/a',
          passed: 'n/a',
          patchNonEmpty: 'n/a',
          patch: '',
        };

        try {
          // CREATION
          const solveStart = Date.now();
          const posted = await postJinnRepoTask(
            fixture,
            operator,
            CREATOR_PRIV_KEY,
            mockIpfs,
            v3Env,
            item,
          );
          rec.taskTx = posted.taskCidDigest;
          console.log(`posted task: id=${posted.taskId} cidDigest=${posted.taskCidDigest}`);

          // CLAIM
          const claim = await waitForDaemonClaim(
            fixture, posted, operator, v3Env, LEG_TIMEOUT_MS,
          );
          rec.claimTx = claim.txHash;
          console.log(`claimed: requestId=${claim.requestId} tx=${claim.txHash}`);

          // EXECUTION → solution delivery
          const delivered = await waitForDelivery(
            fixture, claim, v3Env, mockIpfs, LEG_TIMEOUT_MS,
          );
          const solveMs = Date.now() - solveStart;
          rec.solutionTx = delivered.deliveryTxHash;
          console.log(
            `delivered: tx=${delivered.deliveryTxHash} solver=${delivered.solverHarnessName} (solve leg ${(solveMs / 1000).toFixed(1)}s)`,
          );

          // Inspect the delivered solution patch.
          let patch = '';
          try {
            const parsed = JinnRepoSolutionPayloadSchema.parse(delivered.envelope.payload);
            patch = parsed.patch ?? '';
          } catch (e) {
            console.log(`  [warn] could not parse jinn-repo-solution payload: ${String(e).slice(0, 200)}`);
          }
          rec.patch = patch;
          rec.patchNonEmpty = patch.trim().length > 0;
          console.log(`  patch non-empty: ${rec.patchNonEmpty}`);
          if (patch.trim().length > 0) {
            console.log('  patch (first ~15 lines):');
            console.log(firstLines(patch, 15).split('\n').map((l) => `    ${l}`).join('\n'));
          }

          // EVALUATION → verdict
          const evalStart = Date.now();
          const verdict = await waitForVerdict(
            fixture, posted, operator, v3Env, LEG_TIMEOUT_MS,
          );
          const evalMs = Date.now() - evalStart;
          rec.verdictTx = verdict.verdictTxHash;
          // verdictCode: 1=Pass, 2=Fail, 3=Invalid, 4=Unresolved.
          rec.verdictCode = verdict.verdictCode;
          rec.passed = verdict.verdictCode === 1;
          console.log(
            `verdict: tx=${verdict.verdictTxHash} code=${verdict.verdictCode} passed=${rec.passed} (eval leg ${(evalMs / 1000).toFixed(1)}s)`,
          );
        } catch (e) {
          anyFailed = true;
          console.error(`  LEG FAILED for ${item.instance_id}: ${String(e)}`);
        }

        records.push(rec);
      }
    } finally {
      await running.stop();
    }
  } finally {
    await mockIpfs.close();
    await fixture.teardown();
  }

  // ── Summary table ───────────────────────────────────────────────────────
  console.log('\n=== jinn-repo loop summary ===');
  console.log(
    'instance_id | task tx | claim tx | solution tx | verdict tx | passed | patch-nonempty',
  );
  for (const r of records) {
    console.log(
      [
        r.instanceId,
        r.taskTx,
        r.claimTx,
        r.solutionTx,
        r.verdictTx,
        String(r.passed),
        String(r.patchNonEmpty),
      ].join(' | '),
    );
  }

  // Evidence bundle: full delivered patches + verdicts per instance, for the
  // independent verdict sense-check (reproduce each grade off-loop).
  const evidenceOut = process.env['JINN_RUN_EVIDENCE_OUT'] ?? '/tmp/jinnrepo_run_evidence.json';
  writeFileSync(evidenceOut, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`\nwrote run evidence → ${evidenceOut}`);

  // Success criterion: every driven item delivered a non-empty patch on-chain
  // AND settled a verdict (PASS or FAIL — an honest FAIL still proves the loop).
  const allLoopsComplete = records.every(
    (r) =>
      r.solutionTx !== '-' &&
      r.verdictTx !== '-' &&
      r.patchNonEmpty === true,
  );

  if (anyFailed || !allLoopsComplete) {
    console.error('\n=== FAIL: not every leg completed ===');
    process.exit(1);
  }
  console.log('\n=== OK: full on-chain loop completed for all items ===');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
