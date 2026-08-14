/**
 * Task-first end-to-end validation.
 *
 * Public command: `yarn e2e`
 *
 * Clean-break lifecycle:
 *   Task -> claim Task -> internal Mech requestId -> submit Solution
 *   -> claim evaluation -> internal Mech verdictRequestId -> submit Verdict
 *   -> attempt finalized -> activity counted.
 */

import {
  runBaseSepoliaForkSolverNetCreationLoop,
  runBaseSepoliaForkTaskFirstFullLoop,
  runContractIntegration,
  runAnvilTaskFirstFullLoop,
  runFreezeFenceForkE2E,
  runPhase,
  runPredictionV1Smoke,
  runTrainVsFrozenTrajectoryE2E,
  summarize,
} from './task-first-helpers.js';
import {
  runSweRebenchV2AnvilSettlementE2E,
  runSweRebenchV2DockerEvalE2E,
  runSweRebenchV2HfFetchE2E,
  runSweRebenchV2SolverTypeRegistrationE2E,
} from './swe-rebench-v2-real-infra.js';

async function main(): Promise<void> {
  const results = [];

  results.push(await runPhase('Prediction v1 schema smoke', async () => {
    await runPredictionV1Smoke();
  }));

  if (process.env['JINN_E2E_SKIP_FORK'] === '1') {
    process.stdout.write('\n--- Base Sepolia fork Task-first full loop ---\nskipped by JINN_E2E_SKIP_FORK=1; running local Anvil smoke instead\n');
    results.push(await runPhase('Local Anvil Task-first full loop with evaluator', async () => {
      const result = await runAnvilTaskFirstFullLoop();
      process.stdout.write(
        `taskId=${result.taskId} attempts=${result.attempts.map((a) => `${a.attemptIndex}:${a.requestId}`).join(',')} ` +
        `verdict=${result.verdict} score=${result.score} submitted=${result.submittedCount}\n`,
      );
    }));
    process.stdout.write('\n--- Base Sepolia fork SolverNet creation + launch + lifecycle ---\nskipped by JINN_E2E_SKIP_FORK=1\n');
  } else {
    results.push(await runPhase('Base Sepolia fork Task-first full loop with real Mech', async () => {
      const result = await runBaseSepoliaForkTaskFirstFullLoop();
      process.stdout.write(
        `taskId=${result.taskId} attempts=${result.attempts.map((a) => `${a.attemptIndex}:${a.requestId}`).join(',')} ` +
        `verdict=${result.verdict} score=${result.score} submitted=${result.submittedCount}\n`,
      );
    }));
    results.push(await runPhase('Base Sepolia fork SolverNet creation + launch + lifecycle', async () => {
      const result = await runBaseSepoliaForkSolverNetCreationLoop();
      process.stdout.write(
        `manifestCid=${result.manifestCid} taskId=${result.taskId} ` +
        `verdict=${result.verdict} score=${result.score} submitted=${result.submittedCount} ` +
        `lifecycle=${result.lifecycleSequence.join('->')} setMetadataCalls=${result.setMetadataCalls} ` +
        `filter=${result.filterAssertions.join(',')}\n`,
      );
    }));
  }

  // Freeze-fence phases use plain local Anvil (no Base Sepolia RPC needed),
  // so they run even under JINN_E2E_SKIP_FORK=1 — they only require the
  // `anvil` binary, like `runAnvilTaskFirstFullLoop`.
  results.push(await runPhase('Anvil-fork freeze-fence e2e (stable digest, mutation detected, rollback)', async () => {
    const result = await runFreezeFenceForkE2E();
    process.stdout.write(
      `rpcUrl=${result.rpcUrl} ` +
      `digestStable=${result.codeDigestRun1 === result.codeDigestRun2} ` +
      `violationHarness=${result.violationHarnessName} ` +
      `rollbackOk=${result.preViolationHash === result.postViolationHash}\n`,
    );
  }));

  results.push(await runPhase('Anvil-fork train-vs-frozen trajectory e2e (improve/memory gating)', async () => {
    const result = await runTrainVsFrozenTrajectoryE2E();
    process.stdout.write(
      `rpcUrl=${result.rpcUrl} ` +
      `train=[${result.trainPhaseSpans.join(',')}] ` +
      `frozen=[${result.frozenPhaseSpans.join(',')}]\n`,
    );
  }));

  if (process.env['JINN_E2E_SKIP_CONTRACTS'] === '1') {
    process.stdout.write('\n--- TaskCoordinator/JinnRouterV3 contract integration ---\nskipped by JINN_E2E_SKIP_CONTRACTS=1\n');
  } else {
    results.push(await runPhase('TaskCoordinator/JinnRouterV3 contract integration', async () => {
      await runContractIntegration();
    }));
  }

  // ── swe-rebench-v2 real-infrastructure phases ───────────────────────────────
  // Step 1 (HF fetch) is required for Tier 3 verification; steps 2 (Docker
  // pull + eval.py) and 3 (SolverType registration) gracefully degrade with
  // explicit BLOCKED reasons when their environment isn't available.

  results.push(await runPhase('swe-rebench-v2 real HF fetch + schema hydration + state-store round-trip', async () => {
    const r = await runSweRebenchV2HfFetchE2E();
    if (r.partition === 'skipped') return;
    process.stdout.write(
      `partition=${r.partition} rows=${r.rowCount} sample=${r.sampledInstanceId} ` +
      `schemaParsed=${r.schemaParsed} storeRoundTrip=${r.storeRoundTrip}\n`,
    );
  }));

  results.push(await runPhase('swe-rebench-v2 real Docker pull + eval.py subprocess', async () => {
    const r = await runSweRebenchV2DockerEvalE2E();
    if (r.status === 'blocked') {
      // Surface a precise BLOCKED reason in stdout but do not fail the phase —
      // graceful degradation is the intent for env-dependent verifications.
      process.stdout.write(`BLOCKED: ${r.reason}\n`);
      return;
    }
    process.stdout.write(
      `image=${r.imageName} instance=${r.instanceId} exit=${r.exitCode} ` +
      `tail="${r.stderrTail.slice(0, 160)}"\n`,
    );
  }));

  results.push(await runPhase('swe-rebench-v2 SolverType registration + parseSpec round-trip', async () => {
    const r = await runSweRebenchV2SolverTypeRegistrationE2E();
    if (r.status === 'blocked') {
      process.stdout.write(`BLOCKED: ${r.reason}\n`);
      return;
    }
    process.stdout.write(
      `registered=${r.registered} parseSpecOk=${r.parseSpecOk} ` +
      `schemaVersion=${r.schemaVersionEcho} instance=${r.generatedTaskInstanceId}\n`,
    );
  }));

  // Verify swe-rebench-v2.v1 round-trips cleanly through the on-chain Task
  // lifecycle: manifestDigest is preserved (no implicit downcast to
  // prediction.v1 or legacy solverType digest), Solution/Verdict envelope
  // schemaVersions survive the SignedEnvelope round-trip, and settlement
  // consumes operator escrow.
  // Plain Anvil — no external RPC needed.
  results.push(await runPhase('swe-rebench-v2 Anvil settlement (Task → claim → Solution → Verdict → settle)', async () => {
    const r = await runSweRebenchV2AnvilSettlementE2E();
    process.stdout.write(
      `taskId=${r.taskId} manifestDigestPreserved=${r.manifestDigestPreserved} ` +
      `solutionSchema=${r.solutionSchemaVersion} verdictSchema=${r.verdictSchemaVersion} ` +
      `verdictScore=${r.verdictScore} attemptFinalization=${r.attemptFinalization} ` +
      `submitted=${r.submittedCount} solutionBudgetConsumed=${r.solutionBudgetConsumed} ` +
      `verdictBudgetConsumed=${r.verdictBudgetConsumed} ` +
      `payloadV2=ok(version=${r.payloadV2VersionByte} ` +
      `codeDigest=${r.payloadV2CodeDigestRoundTrip} implName=${r.payloadV2ImplNameRoundTrip} ` +
      `mode=${r.payloadV2ModeRoundTrip})\n`,
    );
  }));

  summarize(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
