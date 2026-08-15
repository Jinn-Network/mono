/**
 * Prediction SolverNet v1 e2e.
 *
 * Public command: `yarn e2e:prediction`.
 */

import {
  runBaseSepoliaForkTaskFirstFullLoop,
  runAnvilTaskFirstFullLoop,
  runPhase,
  runPredictionV1Smoke,
  summarize,
} from './task-first-helpers.js';

async function main(): Promise<void> {
  const results = [];

  results.push(await runPhase('Prediction v1 Task/Solution/Verdict payloads', async () => {
    await runPredictionV1Smoke();
  }));

  if (process.env['JINN_E2E_SKIP_FORK'] === '1') {
    process.stdout.write('\n--- Prediction v1 Base Sepolia fork loop ---\nskipped by JINN_E2E_SKIP_FORK=1; running local Anvil smoke instead\n');
    results.push(await runPhase('Prediction v1 local Anvil full loop with evaluator', async () => {
      const result = await runAnvilTaskFirstFullLoop();
      process.stdout.write(
        `taskId=${result.taskId} attempts=${result.attempts.map((a) => `${a.attemptIndex}:${a.requestId}`).join(',')} ` +
        `verdict=${result.verdict} score=${result.score}\n`,
      );
    }));
  } else {
    results.push(await runPhase('Prediction v1 Base Sepolia fork loop with real Mech', async () => {
      const result = await runBaseSepoliaForkTaskFirstFullLoop();
      process.stdout.write(
        `taskId=${result.taskId} attempts=${result.attempts.map((a) => `${a.attemptIndex}:${a.requestId}`).join(',')} ` +
        `verdict=${result.verdict} score=${result.score}\n`,
      );
    }));
  }

  summarize(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
