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
    // Subsequent tasks fill in: bootstrap → daemon → task post → wait → assert
    console.log('\n=== Task 1 skeleton ok — Anvil + fixture up ===');
  } finally {
    await fixture.teardown();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
