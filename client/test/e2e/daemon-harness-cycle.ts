// client/test/e2e/daemon-harness-cycle.ts
/**
 * Daemon + real harness + on-chain settlement loop e2e (jinn-mono-wyy6).
 *
 * Public command: `yarn e2e:daemon-harness`.
 *
 * Spans:
 *   Anvil fork → earning bootstrap → production Daemon (MechAdapter)
 *   → prediction.v1 task post → daemon claims + executes (real harness)
 *   → on-chain deliver tx → activity counter increments.
 *
 * Pick harness via JINN_E2E_HARNESS=hermes-agent|claude-code|codex.
 * Skips cleanly if the selected harness's API key isn't available.
 */
import {
  harnessSelectorFromEnv,
  setupAnvilFixture,
  bootstrapStakedOperator,
  startDaemon,
} from './_daemon-harness-helpers.js';

async function main(): Promise<void> {
  const harness = harnessSelectorFromEnv();
  console.log(`\n=== daemon-harness e2e — harness=${harness} ===`);
  const fixture = await setupAnvilFixture();
  try {
    console.log(`anvil rpc: ${fixture.anvil.rpcUrl}`);
    console.log(`operator EOA: ${fixture.operatorEoa.address}`);
    console.log(`workingDirRoot: ${fixture.workingDirRoot}`);
    console.log(`implStateRoot: ${fixture.implStateRoot}`);

    const operator = await bootstrapStakedOperator(fixture);
    console.log(`agent EOA:    ${operator.agentAddress}`);
    console.log(`Safe:         ${operator.safeAddress}`);
    console.log(`service id:   ${operator.serviceId}`);
    console.log(`mech:         ${operator.mechAddress}`);

    const running = await startDaemon(fixture, operator, harness);
    try {
      console.log('daemon started — loops running');
      // Next tasks: post task, wait for delivery, assert.
      console.log('\n=== Task 3 ok — production Daemon up against Anvil fork ===');
    } finally {
      // Daemon must stop before Anvil tears down (avoids loops throwing on disconnect).
      await running.stop();
    }
  } finally {
    await fixture.teardown();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
