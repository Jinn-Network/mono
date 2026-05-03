/**
 * Fast local Task-first smoke.
 *
 * Public command: `yarn e2e:task-first-local`
 *
 * This keeps the mock/local contract loop available for quick iteration. The
 * release-confidence `yarn e2e` path runs the Base Sepolia fork by default.
 */

import {
  runAnvilTaskFirstFullLoop,
  runContractIntegration,
  runLocalTaskFirstLifecycle,
  runPhase,
  runPredictionV1Smoke,
  summarize,
} from './task-first-helpers.js';

async function main(): Promise<void> {
  const results = [];

  results.push(await runPhase('Prediction v1 schema smoke', async () => {
    await runPredictionV1Smoke();
  }));

  results.push(await runPhase('Client Task-first lifecycle', async () => {
    const result = await runLocalTaskFirstLifecycle();
    process.stdout.write(
      `taskId=${result.postedTaskId} requestIds=${result.request.requestId},${result.secondRequest.requestId}\n`,
    );
  }));

  if (process.env['JINN_E2E_SKIP_ANVIL'] === '1') {
    process.stdout.write('\n--- Local Anvil Task-first full loop ---\nskipped by JINN_E2E_SKIP_ANVIL=1\n');
  } else {
    results.push(await runPhase('Local Anvil Task-first full loop with evaluator', async () => {
      const result = await runAnvilTaskFirstFullLoop();
      process.stdout.write(
        `taskId=${result.taskId} attempts=${result.attempts.map((a) => `${a.attemptIndex}:${a.requestId}`).join(',')} ` +
        `verdict=${result.verdict} score=${result.score} submitted=${result.submittedCount}\n`,
      );
    }));
  }

  if (process.env['JINN_E2E_SKIP_CONTRACTS'] === '1') {
    process.stdout.write('\n--- TaskCoordinator/JinnRouterV3 contract integration ---\nskipped by JINN_E2E_SKIP_CONTRACTS=1\n');
  } else {
    results.push(await runPhase('TaskCoordinator/JinnRouterV3 contract integration', async () => {
      await runContractIntegration();
    }));
  }

  summarize(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
