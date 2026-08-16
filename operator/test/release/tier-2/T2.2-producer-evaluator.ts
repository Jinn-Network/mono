/**
 * T2.2 — producer/evaluator on an Anvil fork, driven the real on-chain way.
 *
 * Scenario contract (from docs/superpowers/plans/2026-05-19-tier-2-scenarios-plan.md
 * Task 6 and .claude/skills/testing-jinn-app/references/scenario-producer-evaluator.md):
 *   A producer operator posts a task; its daemon claims and solves it and
 *   delivers a solution on-chain. A separate evaluator operator's daemon claims
 *   the evaluation request, runs the real evaluator, and settles a verdict
 *   on-chain. Assert the verdict and that on-chain activity counters increment
 *   for both operators.
 *
 * Sibling scenario: T2.4 (T2.4-producer-evaluator-swe-rebench.ts) covers the
 * swe-rebench-v2.v1 loop with a hermetic stub solve + the real Docker evaluator
 * (skip-clean when Docker/admission/HF are absent). This T2.2 scenario is the
 * PREDICTION (prediction.v1) hermetic loop — the only end-to-end loop that is
 * fully hermetic through the verdict (deterministic PredictionV1Evaluator + mock
 * Gamma, no Docker/HF) — and is KEPT as the always-on lighter Tier-2 scenario
 * per issue #898.
 *
 * Why this is NOT an HTTP-endpoint scenario (resolves GH issue #350)
 * -----------------------------------------------------------------
 * The first cut of T2.2 assumed an HTTP task-control plane — `POST /v1/tasks`,
 * `GET /v1/tasks/:id`, `GET /v1/verdicts`, `GET /v1/activity`. None of those
 * exist, and none should: Jinn is an on-chain protocol. Tasks enter via a
 * `createTask` tx on the JinnRouter V3; the daemon's `CreatorLoop` posts
 * generator-produced tasks on-chain; solving, delivery, evaluation and verdicts
 * are all driven by daemon loops reacting to on-chain events; verdicts settle
 * on-chain. Activity counters are on-chain state (`TaskActivityCheckerV3`); the
 * daemon only *mirrors* a snapshot into `GET /v1/status`. The investigation on
 * issue #350 confirmed option (b): rewrite T2.2 to drive the loop the real way.
 *
 * How this drives the real loop
 * -----------------------------
 * This scenario composes the `yarn e2e:daemon-harness` helpers
 * (`operator/test/e2e/_daemon-harness-helpers.ts`) — the existing pattern that
 * already does producer → solve → deliver → activity-counter the real way —
 * and extends them with the genuinely-new evaluator/verdict leg:
 *
 *   1. Anvil fork of Base + a fresh JinnRouter V3 task stack
 *      (`deployMinimalV3Stack`). The production V1 JinnRouter does not expose
 *      the `createTask` interface, so a V3 stack is deployed on the fork.
 *   2. Two staked operators bootstrapped via the real `FleetBootstrapper`
 *      (op-a = producer/solver, op-b = evaluator). Each gets its own mock mech
 *      (`deployOperatorMech`) so the V3 router's `claimEvaluation` operator
 *      check passes for whichever Safe claims.
 *   3. A prediction.v1 task posted on-chain (`postPredictionV1Task`) with a
 *      verdict budget. prediction.v1 is chosen over the SWE-rebench stub
 *      harness because its baseline solver and `PredictionV1Evaluator` are both
 *      deterministic, need no Docker and no LLM API key, and are the path the
 *      daemon-harness helpers already support — keeping T2.2 deterministic and
 *      cheap, as the release gate requires.
 *   4. op-a's daemon discovers the task on-chain, claims it, solves it with the
 *      deterministic `prediction-v1-baseline` harness, and delivers on-chain
 *      (`waitForDelivery`).
 *   5. op-b's daemon discovers op-a's on-chain solution delivery, claims the
 *      evaluation request, runs the real `PredictionV1Evaluator`, and settles a
 *      verdict on-chain (`waitForVerdict` — the new leg).
 *   6. The verdict's market resolution is served by an in-process mock
 *      Polymarket Gamma server (`startMockPolymarketGammaServer`) so the
 *      verdict is deterministic and offline; the fixture market resolves YES,
 *      so the evaluator derives a Pass verdict (`verdictCode === 1`).
 *   7. Assert the on-chain verdict code and that `eligibleActivityWeight`
 *      incremented for both the solver and the evaluator.
 *
 * The substrate multi-op workspace + Base Sepolia fork from `setupTier2Scenario`
 * is NOT used here: those daemons are production binaries pinned to the
 * already-deployed Base Sepolia contracts and cannot be redirected at a
 * freshly-deployed V3 router. Driving the real loop end-to-end therefore uses
 * the in-process daemon-harness daemons, which can be pointed at the fresh V3
 * stack. The two-operator shape preserves the producer/evaluator contract.
 *
 * Resolves: https://github.com/Jinn-Network/mono/issues/350
 */

import {
  setupAnvilFixture,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  deployOperatorMech,
  startDaemon,
  startMockIpfsServer,
  startMockPolymarketGammaServer,
  postPredictionV1Task,
  waitForDaemonClaim,
  waitForDelivery,
  waitForVerdict,
  readActivityCount,
  ANVIL_PRIVATE_KEYS,
  type DaemonHarnessFixture,
  type MockIpfsServer,
  type MockPolymarketGammaServer,
  type RunningDaemon,
} from '../../e2e/_daemon-harness-helpers.js';
import { jsonRpc as anvilJsonRpc } from '../../_support/chain/anvil.js';
import { EvidenceLog, failVerdict, passVerdict } from './scenario-evidence.js';
import type {
  ScenarioVerdict,
  ScenarioOptions,
} from '../../../scripts/release/scenario-types.js';

// Verdict codes (contracts/src/tasks/TaskCoordinator.sol VerdictCode enum).
const VERDICT_PASS = 1;

// The prediction.v1 fixture market identifiers `postPredictionV1Task` embeds in
// the task's `spec.source.identifiers`. The mock Gamma server must serve a
// resolved market under these exact ids so the evaluator's `market.identity`
// check passes.
const FIXTURE_MARKET_ID = 'jinn-daemon-harness-e2e-task4';
const FIXTURE_CONDITION_ID = '0xcondition-daemon-harness-e2e-task4';
const FIXTURE_MARKET_SLUG = 'jinn-daemon-harness-e2e-task4';

/**
 * Default in-scenario wall-clock budget (ms). The orchestrator may override it
 * via `opts.wallClockBudgetMs`; the Vitest wrapper passes 18 min. Enforced via
 * a `Promise.race` deadline inside `runT22ProducerEvaluator` so an overrun
 * yields a classified `flake-timing` verdict instead of letting the Vitest
 * process timeout kill the run with no verdict at all.
 */
const DEFAULT_WALL_CLOCK_BUDGET_MS = 18 * 60 * 1000;

// ── Callable entry point for the orchestrator ────────────────────────────────

export async function runT22ProducerEvaluator(
  opts: ScenarioOptions,
): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidence = new EvidenceLog(opts.evidencePath);
  const log = (msg: string): void => evidence.log(msg);

  // Enforce the wall-clock budget in-scenario: race the scenario body against a
  // deadline timer. If the body overruns, the timer wins and we return a
  // classified `flake-timing` fail — a real verdict — rather than depending on
  // the Vitest process timeout, which kills the process with no verdict.
  const budgetMs = opts.wallClockBudgetMs ?? DEFAULT_WALL_CLOCK_BUDGET_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ScenarioVerdict>((resolve) => {
    deadlineTimer = setTimeout(() => {
      log(
        `ERROR: scenario exceeded wall-clock budget of ${budgetMs}ms — aborting`,
      );
      // Flush is best-effort and non-blocking here; the body's finally block
      // still runs in the background to release Anvil / mock servers.
      void evidence.flush();
      resolve(
        failVerdict({
          scenarioId: 'T2.2',
          startedAt: started,
          evidencePath: opts.evidencePath,
          error: new Error(
            `T2.2 timed out after ${budgetMs}ms (wall-clock budget exceeded)`,
          ),
        }),
      );
    }, budgetMs);
  });

  try {
    return await Promise.race([
      runScenarioBody(opts, started, evidence, log),
      deadline,
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

async function runScenarioBody(
  opts: ScenarioOptions,
  started: number,
  evidence: EvidenceLog,
  log: (msg: string) => void,
): Promise<ScenarioVerdict> {

  let fixture: DaemonHarnessFixture | null = null;
  let mockIpfs: MockIpfsServer | null = null;
  let mockGamma: MockPolymarketGammaServer | null = null;
  let producerDaemon: RunningDaemon | null = null;
  let evaluatorDaemon: RunningDaemon | null = null;

  try {
    // ── Step 1: Anvil fork of Base + in-process infra ───────────────────────
    log('Step 1: spawn Anvil fork of Base + mock IPFS + mock Polymarket Gamma');
    fixture = await setupAnvilFixture();
    log(`  anvil rpc: ${fixture.anvil.rpcUrl}`);

    mockIpfs = await startMockIpfsServer();
    log(`  mock IPFS:  ${mockIpfs.baseUrl}`);

    mockGamma = await startMockPolymarketGammaServer({
      marketId: FIXTURE_MARKET_ID,
      conditionId: FIXTURE_CONDITION_ID,
      slug: FIXTURE_MARKET_SLUG,
      outcome: 'YES',
    });
    log(`  mock Gamma: ${mockGamma.baseUrl} (fixture market resolves YES)`);

    // ── Step 2: Bootstrap two staked operators (producer + evaluator) ───────
    log('Step 2: bootstrap producer (op-a) + evaluator (op-b) via FleetBootstrapper');
    const producer = await bootstrapStakedOperator(fixture);
    log(`  op-a (producer/solver) Safe: ${producer.safeAddress}`);
    const evaluator = await bootstrapStakedOperator(fixture);
    log(`  op-b (evaluator)       Safe: ${evaluator.safeAddress}`);

    // ── Step 3: Deploy the V3 task stack + a mech per operator ──────────────
    log('Step 3: deploy JinnRouter V3 stack + a mock mech for each operator');
    const DEPLOYER_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
    const CREATOR_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;

    // Fund the deployer/creator EOA *before* deploying. On an Anvil fork of
    // Base mainnet the default dev accounts are NOT auto-funded — they carry
    // their (zero) mainnet balance — so the deployer must be topped up first.
    const { privateKeyToAccount } = await import('viem/accounts');
    const deployerAddress = privateKeyToAccount(DEPLOYER_PRIV_KEY).address;
    await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
      deployerAddress,
      '0x56bc75e2d63100000', // 100 ETH
    ]);

    // The base V3 stack's mech is bound to the producer's Safe; the producer
    // claims the solution through it.
    const producerV3 = await deployMinimalV3Stack(
      fixture,
      producer,
      DEPLOYER_PRIV_KEY,
    );
    log(`  V3 router:     ${producerV3.routerAddress}`);
    log(`  op-a mech:     ${producerV3.mockMechAddress}`);

    // The evaluator needs its own mech (operator = evaluator's Safe) so the V3
    // router's claimEvaluation operator check passes. Same router/marketplace/
    // activity-checker, distinct mech.
    const evaluatorV3 = await deployOperatorMech(
      fixture,
      evaluator,
      producerV3,
      DEPLOYER_PRIV_KEY,
    );
    log(`  op-b mech:     ${evaluatorV3.mockMechAddress}`);

    // The creator EOA is the same key as the deployer, already funded above —
    // CREATOR_PRIV_KEY pays for the createTask tx in Step 6.
    void CREATOR_PRIV_KEY;

    // Top up both operators' agent EOAs. The FleetBootstrapper funds an agent
    // EOA with only ~`minEoaGasEth` (≈0.005 ETH) — enough for the bootstrap's
    // mech-deploy tx but not the daemon's full runtime tx stream (claim →
    // deliver → claimSolutionDelivery, plus claimEvaluation → deliver →
    // claimVerdictDelivery for the evaluator). Fund each to 100 ETH so the
    // daemons never stall mid-loop on an out-of-gas balance.
    for (const op of [producer, evaluator]) {
      await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
        op.agentAddress,
        '0x56bc75e2d63100000', // 100 ETH
      ]);
    }

    // ── Step 4: Start both daemons ──────────────────────────────────────────
    log('Step 4: start producer + evaluator daemons (prediction-v1-baseline harness)');
    // op-a gets the mock Gamma URL too (symmetric with op-b). The on-chain
    // policy sets `disallowSolverSelfEvaluation: false`, so op-a's daemon is
    // permitted to claim the evaluation request for the task it solved. Its
    // prediction-v1-evaluator then calls `getResolution`, which — absent a
    // gammaBaseUrl override — hits the live `gamma-api.polymarket.com` and
    // returns 422 for the synthetic fixture market, hard-failing op-a's
    // evaluation. If op-a wins the evaluation claim, no verdict settles and
    // `waitForVerdict` times out. Pointing op-a's evaluator at the offline
    // mock makes the verdict leg deterministic regardless of which operator
    // claims the evaluation — matching the scenario's offline/hermetic intent.
    producerDaemon = await startDaemon(
      fixture,
      producer,
      'prediction-v1-baseline',
      mockIpfs.baseUrl,
      producerV3,
      mockIpfs.baseUrl,
      { instanceLabel: 'op-a', polymarketGammaBaseUrl: mockGamma.baseUrl },
    );
    log('  op-a daemon up (solver)');

    // The evaluator daemon's PredictionV1Evaluator resolves markets against the
    // mock Gamma server so the verdict is deterministic and offline.
    evaluatorDaemon = await startDaemon(
      fixture,
      evaluator,
      'prediction-v1-baseline',
      mockIpfs.baseUrl,
      evaluatorV3,
      mockIpfs.baseUrl,
      { instanceLabel: 'op-b', polymarketGammaBaseUrl: mockGamma.baseUrl },
    );
    log('  op-b daemon up (evaluator)');

    // ── Step 5: Baseline activity counters ──────────────────────────────────
    const producerActivityBefore = await readActivityCount(
      fixture,
      producer,
      producerV3,
    );
    const evaluatorActivityBefore = await readActivityCount(
      fixture,
      evaluator,
      evaluatorV3,
    );
    log(
      `Step 5: baseline activity — op-a=${producerActivityBefore} op-b=${evaluatorActivityBefore}`,
    );

    // ── Step 6: Post the prediction.v1 task on-chain ────────────────────────
    log('Step 6: post prediction.v1 task on-chain via createTask');
    // disallowSolverSelfEvaluation: true bars op-a (the solver) from claiming
    // the evaluation request for its own solution. With requiredVerdicts: 1,
    // whichever operator claims the evaluation first settles the single verdict;
    // if op-a wins that race, op-b can never settle (TCMaxVerdictsReached) and
    // `waitForVerdict`, which filters for op-b's Safe specifically, times out.
    // Barring self-evaluation leaves op-b as the only eligible evaluator, so the
    // verdict leg is deterministic instead of racy.
    const posted = await postPredictionV1Task(
      fixture,
      producer,
      CREATOR_PRIV_KEY,
      mockIpfs,
      producerV3,
      { disallowSolverSelfEvaluation: true },
    );
    log(`  task posted: id=${posted.taskId} cidDigest=${posted.taskCidDigest}`);

    // ── Step 7: Producer daemon claims + solves + delivers ──────────────────
    // Wait timeouts are generous: a release-prep run forks Base over a possibly
    // shared RPC, which can throttle the daemon's on-chain polling.
    log('Step 7: wait for op-a to claim the task on-chain');
    const claim = await waitForDaemonClaim(
      fixture,
      posted,
      producer,
      producerV3,
      180_000,
    );
    log(`  op-a claimed: requestId=${claim.requestId} tx=${claim.txHash}`);

    log('Step 7b: wait for op-a to deliver the solution on-chain');
    const delivered = await waitForDelivery(
      fixture,
      claim,
      producerV3,
      mockIpfs,
      240_000,
    );
    log(
      `  op-a delivered: tx=${delivered.deliveryTxHash} solver=${delivered.solverHarnessName}`,
    );

    // ── Step 8: Evaluator daemon claims + evaluates + settles verdict ───────
    log('Step 8: wait for op-b to claim the evaluation request, evaluate, and settle a verdict on-chain');
    const verdict = await waitForVerdict(
      fixture,
      posted,
      evaluator,
      evaluatorV3,
      300_000,
    );
    log(
      `  op-b settled verdict: code=${verdict.verdictCode} tx=${verdict.verdictTxHash} ` +
        `evaluator=${verdict.evaluator}`,
    );

    // ── Step 9: Assertions ──────────────────────────────────────────────────
    log('Step 9: assert verdict + activity counters');
    if (verdict.verdictCode !== VERDICT_PASS) {
      throw new Error(
        `expected verdictCode=${VERDICT_PASS} (Pass) from the deterministic ` +
          `fixture market (resolves YES), got ${verdict.verdictCode}`,
      );
    }
    log(`  ✓ on-chain verdictCode === ${VERDICT_PASS} (Pass)`);

    // The producer's solution-delivery tx and the evaluator's verdict-delivery
    // tx both increment `eligibleActivityWeight` on the V3 activity checker.
    // Poll briefly: the recordX tx may land just after the event we observed.
    let producerActivityAfter = producerActivityBefore;
    let evaluatorActivityAfter = evaluatorActivityBefore;
    const deadline = Date.now() + 60_000;
    while (
      Date.now() < deadline &&
      (producerActivityAfter <= producerActivityBefore ||
        evaluatorActivityAfter <= evaluatorActivityBefore)
    ) {
      producerActivityAfter = await readActivityCount(
        fixture,
        producer,
        producerV3,
      );
      evaluatorActivityAfter = await readActivityCount(
        fixture,
        evaluator,
        evaluatorV3,
      );
      if (
        producerActivityAfter > producerActivityBefore &&
        evaluatorActivityAfter > evaluatorActivityBefore
      ) {
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
    log(
      `  activity after — op-a=${producerActivityAfter} op-b=${evaluatorActivityAfter}`,
    );
    if (producerActivityAfter <= producerActivityBefore) {
      throw new Error(
        `producer activity counter did not increment ` +
          `(before=${producerActivityBefore} after=${producerActivityAfter})`,
      );
    }
    if (evaluatorActivityAfter <= evaluatorActivityBefore) {
      throw new Error(
        `evaluator activity counter did not increment ` +
          `(before=${evaluatorActivityBefore} after=${evaluatorActivityAfter})`,
      );
    }
    log(
      `  ✓ activity incremented — op-a ${producerActivityBefore}→${producerActivityAfter}, ` +
        `op-b ${evaluatorActivityBefore}→${evaluatorActivityAfter}`,
    );

    log('');
    log('Verdict: pass — full producer → solve → deliver → evaluate → verdict loop closed on-chain');
    await evidence.flush();
    return passVerdict({
      scenarioId: 'T2.2',
      startedAt: started,
      evidencePath: opts.evidencePath,
    });
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    await evidence.flush();
    return failVerdict({
      scenarioId: 'T2.2',
      startedAt: started,
      evidencePath: opts.evidencePath,
      error: err,
    });
  } finally {
    // Daemons must stop before Anvil tears down (loops throw on RPC disconnect).
    if (producerDaemon) {
      try {
        await producerDaemon.stop();
      } catch {
        /* best-effort */
      }
    }
    if (evaluatorDaemon) {
      try {
        await evaluatorDaemon.stop();
      } catch {
        /* best-effort */
      }
    }
    if (mockGamma) {
      try {
        await mockGamma.close();
      } catch {
        /* best-effort */
      }
    }
    if (mockIpfs) {
      try {
        await mockIpfs.close();
      } catch {
        /* best-effort */
      }
    }
    if (fixture) {
      try {
        await fixture.teardown();
      } catch {
        /* best-effort */
      }
    }
  }
}
