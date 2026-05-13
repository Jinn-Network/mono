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

    // Subsequent tasks fill in: daemon → task post → wait → assert
    console.log('\n=== Task 2 ok — operator bootstrapped ===');
  } finally {
    await fixture.teardown();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
