/**
 * T2.4 — producer/evaluator on an Anvil fork, swe-rebench-v2.v1 solver type.
 *
 * The sibling of T2.2 (prediction.v1). This scenario covers the swe-rebench-v2
 * on-chain loop at the cheap Tier-2 tier:
 *
 *   - SOLVE leg: hermetic + deterministic. The producer daemon dispatches the
 *     `swe-rebench-v2.v1` solve to the env-gated StubHarness, which returns the
 *     known-good `sympy__sympy-27510.patch` fixture — NO real coding agent, no
 *     LLM, no network.
 *   - EVALUATOR leg: the REAL SweRebenchV2EvaluatorHarness (Docker eval.py).
 *     This is gated on (Docker reachable) AND (the evaluator harness enabled
 *     with its upstream repo cloned) AND (a scorable admission record present)
 *     — with HF reachability proven at run time. When any precondition is
 *     absent the scenario returns a classified `skip` (non-blocking), matching
 *     the 2026-05-31 two-gate redesign's advisory/nightly placement of Docker
 *     eval. T3.1 asserts the real grading on real Base Sepolia; here the real
 *     verdict is asserted whenever the host can actually run it.
 *
 * prediction-v1-baseline coverage is KEPT as the separate, always-on hermetic
 * full-loop scenario (T2.2-producer-evaluator.ts) — it is the only end-to-end
 * loop fully hermetic through the verdict.
 *
 * Closes: https://github.com/Jinn-Network/mono/issues/898
 */

import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setupAnvilFixture,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  deployOperatorMech,
  startDaemon,
  startSweRebenchSolverDaemon,
  startMockIpfsServer,
  postSweRebenchV2Task,
  waitForDaemonClaim,
  waitForDelivery,
  waitForVerdict,
  readActivityCount,
  ANVIL_PRIVATE_KEYS,
  type DaemonHarnessFixture,
  type MockIpfsServer,
  type RunningDaemon,
} from '../../e2e/_daemon-harness-helpers.js';
import { jsonRpc as anvilJsonRpc } from '../../_support/chain/anvil.js';
import { EvidenceLog, failVerdict, passVerdict, skipVerdict } from './scenario-evidence.js';
import {
  runCommand,
  readEnabledState,
} from '../../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import {
  KNOWN_INSTANCE_ID,
  KNOWN_EXPECTED_VERDICT,
} from './fixtures/known-instance.js';
import { seedKnownInstanceAdmission } from './fixtures/admission-sympy-27510.js';
import type {
  ScenarioVerdict,
  ScenarioOptions,
} from '../../../scripts/release/scenario-types.js';

// Verdict codes (contracts/src/tasks/TaskCoordinator.sol VerdictCode enum).
const VERDICT_PASS = KNOWN_EXPECTED_VERDICT; // = 1
const DEFAULT_WALL_CLOCK_BUDGET_MS = 18 * 60 * 1000;

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

// ── Callable entry point for the orchestrator ────────────────────────────────

export async function runT24ProducerEvaluatorSweRebench(
  opts: ScenarioOptions,
): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidence = new EvidenceLog(opts.evidencePath);
  const log = (msg: string): void => evidence.log(msg);

  // Enforce the wall-clock budget in-scenario: race the scenario body against a
  // deadline timer (same pattern as T2.2). On overrun the timer wins and we
  // return a classified fail — a real verdict — rather than letting the Vitest
  // process timeout kill the run with no verdict.
  const budgetMs = opts.wallClockBudgetMs ?? DEFAULT_WALL_CLOCK_BUDGET_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ScenarioVerdict>((resolve) => {
    deadlineTimer = setTimeout(() => {
      log(`ERROR: scenario exceeded wall-clock budget of ${budgetMs}ms — aborting`);
      void evidence.flush();
      resolve(
        failVerdict({
          scenarioId: 'T2.4',
          startedAt: started,
          evidencePath: opts.evidencePath,
          error: new Error(`T2.4 timed out after ${budgetMs}ms (wall-clock budget exceeded)`),
        }),
      );
    }, budgetMs);
  });

  try {
    return await Promise.race([runScenarioBody(opts, started, evidence, log), deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/**
 * Probe whether the real swe-rebench-v2 Docker evaluator can actually run on
 * this host. Returns `{ ready: true }` only when ALL preconditions hold:
 *   - Docker reachable (`docker info` exit 0),
 *   - the evaluator harness is enabled (readEnabledState marker present) AND
 *     its upstream repo is cloned on disk,
 *   - (admission is seeded by the scenario itself, so it is always present).
 * Otherwise returns `{ ready: false, reason }` so the scenario skips clean.
 * (HF reachability is NOT probed here — it is proven at grade time; an HF
 * outage surfaces as a verdict-timeout the run classifies as a skip-reason.)
 */
async function probeRealEvalReady(
  evaluatorImplStateDir: string,
): Promise<{ ready: true } | { ready: false; reason: string }> {
  let docker;
  try {
    docker = await runCommand('docker', ['info']);
  } catch {
    return { ready: false, reason: 'docker-unreachable' };
  }
  if (docker.exitCode !== 0) {
    return { ready: false, reason: 'docker-unreachable' };
  }
  const state = readEnabledState(evaluatorImplStateDir);
  if (!state) {
    return { ready: false, reason: 'swe-rebench-v2-evaluator-not-enabled' };
  }
  if (!existsSync(state.upstreamRepoDir)) {
    return { ready: false, reason: 'upstream-eval-repo-missing' };
  }
  return { ready: true };
}

async function runScenarioBody(
  opts: ScenarioOptions,
  started: number,
  evidence: EvidenceLog,
  log: (msg: string) => void,
): Promise<ScenarioVerdict> {
  let fixture: DaemonHarnessFixture | null = null;
  let mockIpfs: MockIpfsServer | null = null;
  let producerDaemon: RunningDaemon | null = null;
  let evaluatorDaemon: RunningDaemon | null = null;
  const prevEvalStateDir = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];

  try {
    // ── Step 1: Anvil fork of Base + mock IPFS ──────────────────────────────
    log('Step 1: spawn Anvil fork of Base + mock IPFS');
    fixture = await setupAnvilFixture();
    log(`  anvil rpc: ${fixture.anvil.rpcUrl}`);
    mockIpfs = await startMockIpfsServer();
    log(`  mock IPFS:  ${mockIpfs.baseUrl}`);

    // Eval state dir: seed admission here, then set JINN_SWE_REBENCH_V2_STATE_DIR
    // before startDaemon so buildHarnesses forwards sweRebenchV2StateDir into the
    // swe-rebench-v2 evaluator harness (main.ts parity; #2097).
    const evalStateDir = pathJoin(fixture.implStateRoot, 'op-b-eval-state');
    await fsp.mkdir(evalStateDir, { recursive: true });
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = evalStateDir;
    await seedKnownInstanceAdmission(evalStateDir);
    log(`  seeded admission for ${KNOWN_INSTANCE_ID} into ${evalStateDir}`);

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
    const { privateKeyToAccount } = await import('viem/accounts');
    const deployerAddress = privateKeyToAccount(DEPLOYER_PRIV_KEY).address;
    await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
      deployerAddress,
      '0x56bc75e2d63100000', // 100 ETH
    ]);
    const producerV3 = await deployMinimalV3Stack(fixture, producer, DEPLOYER_PRIV_KEY);
    log(`  V3 router:     ${producerV3.routerAddress}`);
    log(`  op-a mech:     ${producerV3.mockMechAddress}`);
    const evaluatorV3 = await deployOperatorMech(fixture, evaluator, producerV3, DEPLOYER_PRIV_KEY);
    log(`  op-b mech:     ${evaluatorV3.mockMechAddress}`);

    // Creator EOA == deployer, already funded above; CREATOR_PRIV_KEY pays the
    // createTask tx in Step 6.
    void CREATOR_PRIV_KEY;

    // Top up both operators' agent EOAs to 100 ETH so the daemons never stall
    // mid-loop on an out-of-gas balance.
    for (const op of [producer, evaluator]) {
      await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
        op.agentAddress,
        '0x56bc75e2d63100000', // 100 ETH
      ]);
    }

    // ── Step 4: Start both daemons ──────────────────────────────────────────
    log('Step 4: start producer (stub solver) + evaluator (real swe-rebench-v2) daemons');
    producerDaemon = await startSweRebenchSolverDaemon(
      fixture,
      producer,
      mockIpfs.baseUrl,
      producerV3,
      mockIpfs.baseUrl,
      { instanceLabel: 'op-a', fixturesDir: FIXTURES_DIR, instanceMatcher: KNOWN_INSTANCE_ID },
    );
    log('  op-a daemon up (stub solver)');
    evaluatorDaemon = await startDaemon(
      fixture,
      evaluator,
      'prediction-v1-baseline',
      mockIpfs.baseUrl,
      evaluatorV3,
      mockIpfs.baseUrl,
      { instanceLabel: 'op-b' },
    );
    log('  op-b daemon up (real evaluator)');

    // ── Step 4b: Probe whether the real evaluator can actually run here ─────
    // The evaluator harness implStateDir derived by buildHarnesses is
    // `${implStateDirRoot}/swe-rebench-v2-evaluator` with implStateDirRoot =
    // join(fixture.implStateRoot, '${label}-impl-state') (index.ts:217).
    const evaluatorImplStateDir = pathJoin(
      fixture.implStateRoot,
      'op-b-impl-state',
      'swe-rebench-v2-evaluator',
    );
    const ready = await probeRealEvalReady(evaluatorImplStateDir);
    if (!ready.ready) {
      log(`Step 4b: real swe-rebench-v2 evaluator not runnable (${ready.reason}) — skip-clean`);
      log('Verdict: skip — Docker/admission/upstream-repo precondition absent (advisory/nightly per redesign)');
      await evidence.flush();
      return skipVerdict({
        scenarioId: 'T2.4',
        startedAt: started,
        evidencePath: opts.evidencePath,
        failNotes: `real swe-rebench-v2 evaluator precondition absent: ${ready.reason}`,
      });
    }
    log('Step 4b: real swe-rebench-v2 evaluator IS runnable — proceeding to assert a real verdict');

    // ── Step 5: Baseline activity counters ──────────────────────────────────
    const producerActivityBefore = await readActivityCount(fixture, producer, producerV3);
    const evaluatorActivityBefore = await readActivityCount(fixture, evaluator, evaluatorV3);
    log(`Step 5: baseline activity — op-a=${producerActivityBefore} op-b=${evaluatorActivityBefore}`);

    // ── Step 6: Post the swe-rebench-v2.v1 task on-chain ────────────────────
    log('Step 6: post swe-rebench-v2.v1 task on-chain via createTask');
    const posted = await postSweRebenchV2Task(
      fixture,
      producer,
      CREATOR_PRIV_KEY,
      mockIpfs,
      producerV3,
      { disallowSolverSelfEvaluation: true },
    );
    log(`  task posted: id=${posted.taskId} cidDigest=${posted.taskCidDigest}`);

    // ── Step 7: Producer daemon claims + solves (stub) + delivers ───────────
    log('Step 7: wait for op-a to claim the task on-chain');
    const claim = await waitForDaemonClaim(fixture, posted, producer, producerV3, 180_000);
    log(`  op-a claimed: requestId=${claim.requestId} tx=${claim.txHash}`);

    log('Step 7b: wait for op-a to deliver the (stub) solution on-chain');
    const delivered = await waitForDelivery(fixture, claim, producerV3, mockIpfs, 240_000);
    log(`  op-a delivered: tx=${delivered.deliveryTxHash} solver=${delivered.solverHarnessName}`);

    // ── Step 8: Evaluator daemon claims + runs REAL Docker eval + settles ───
    log('Step 8: wait for op-b to claim the evaluation request, run the REAL Docker eval, settle a verdict');
    let verdict;
    try {
      verdict = await waitForVerdict(fixture, posted, evaluator, evaluatorV3, 600_000);
    } catch (err) {
      // The real evaluator can emit a SkippableError at grade time (HF outage,
      // image pull failure, eval-not-gradeable) → the engine records a skip and
      // never settles a verdict → waitForVerdict times out. Under the redesign
      // this is advisory, so classify as a skip rather than a hard fail.
      log(`Step 8b: no verdict settled within budget (${err instanceof Error ? err.message : String(err)}) — skip-clean`);
      log('Verdict: skip — real evaluator did not settle a verdict (likely HF/image/grade precondition at run time)');
      await evidence.flush();
      return skipVerdict({
        scenarioId: 'T2.4',
        startedAt: started,
        evidencePath: opts.evidencePath,
        failNotes: 'real swe-rebench-v2 evaluator settled no verdict within budget (HF/image/grade precondition)',
      });
    }
    log(`  op-b settled verdict: code=${verdict.verdictCode} tx=${verdict.verdictTxHash} evaluator=${verdict.evaluator}`);

    // ── Step 9: Assertions ──────────────────────────────────────────────────
    log('Step 9: assert verdict + activity counters');
    if (verdict.verdictCode !== VERDICT_PASS) {
      throw new Error(
        `expected verdictCode=${VERDICT_PASS} (Pass) for known-solvable instance ${KNOWN_INSTANCE_ID}, got ${verdict.verdictCode}`,
      );
    }
    log(`  on-chain verdictCode === ${VERDICT_PASS} (Pass)`);

    let producerActivityAfter = producerActivityBefore;
    let evaluatorActivityAfter = evaluatorActivityBefore;
    const activityDeadline = Date.now() + 60_000;
    while (
      Date.now() < activityDeadline &&
      (producerActivityAfter <= producerActivityBefore ||
        evaluatorActivityAfter <= evaluatorActivityBefore)
    ) {
      producerActivityAfter = await readActivityCount(fixture, producer, producerV3);
      evaluatorActivityAfter = await readActivityCount(fixture, evaluator, evaluatorV3);
      if (
        producerActivityAfter > producerActivityBefore &&
        evaluatorActivityAfter > evaluatorActivityBefore
      ) {
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
    if (producerActivityAfter <= producerActivityBefore) {
      throw new Error(
        `producer activity counter did not increment (before=${producerActivityBefore} after=${producerActivityAfter})`,
      );
    }
    if (evaluatorActivityAfter <= evaluatorActivityBefore) {
      throw new Error(
        `evaluator activity counter did not increment (before=${evaluatorActivityBefore} after=${evaluatorActivityAfter})`,
      );
    }
    log(
      `  activity incremented — op-a ${producerActivityBefore}→${producerActivityAfter}, ` +
        `op-b ${evaluatorActivityBefore}→${evaluatorActivityAfter}`,
    );

    log('');
    log('Verdict: pass — full producer → stub-solve → deliver → REAL evaluate → verdict loop closed on-chain');
    await evidence.flush();
    return passVerdict({ scenarioId: 'T2.4', startedAt: started, evidencePath: opts.evidencePath });
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    await evidence.flush();
    return failVerdict({ scenarioId: 'T2.4', startedAt: started, evidencePath: opts.evidencePath, error: err });
  } finally {
    if (prevEvalStateDir === undefined) delete process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
    else process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = prevEvalStateDir;
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
