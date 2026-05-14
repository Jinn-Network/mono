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
 * Pick harness via JINN_E2E_HARNESS=prediction-v1-baseline|hermes-agent|claude-code|codex.
 * Defaults to prediction-v1-baseline (deterministic, no API key required).
 * Skips cleanly if the selected harness's API key isn't available.
 */
import {
  harnessSelectorFromEnv,
  checkHarnessApiKey,
  selectorToHarnessName,
  setupAnvilFixture,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  startDaemon,
  startMockIpfsServer,
  postPredictionV1Task,
  waitForDaemonClaim,
  waitForDelivery,
  ANVIL_PRIVATE_KEYS,
} from './_daemon-harness-helpers.js';
import { jsonRpc as anvilJsonRpc } from '../_support/chain/anvil.js';

async function main(): Promise<void> {
  const harness = harnessSelectorFromEnv();

  // Skip cleanly (exit 0) when the selected harness's API key is absent.
  // This avoids CI failures when only a subset of provider keys are available.
  const keyCheck = checkHarnessApiKey(harness);
  if (!keyCheck.ok) {
    console.log(`\n=== daemon-harness e2e — SKIPPED: ${keyCheck.reason} ===`);
    return;
  }

  console.log(`\n=== daemon-harness e2e — harness=${harness} ===`);
  const fixture = await setupAnvilFixture();

  // Start the mock IPFS server before the daemon so its baseUrl is known.
  const mockIpfs = await startMockIpfsServer();
  try {
    console.log(`anvil rpc: ${fixture.anvil.rpcUrl}`);
    console.log(`operator EOA: ${fixture.operatorEoa.address}`);
    console.log(`workingDirRoot: ${fixture.workingDirRoot}`);
    console.log(`implStateRoot: ${fixture.implStateRoot}`);
    console.log(`mock IPFS: ${mockIpfs.baseUrl}`);

    const operator = await bootstrapStakedOperator(fixture);
    console.log(`agent EOA:    ${operator.agentAddress}`);
    console.log(`Safe:         ${operator.safeAddress}`);
    console.log(`service id:   ${operator.serviceId}`);
    console.log(`mech:         ${operator.mechAddress}`);

    // Fund the creator EOA (ANVIL_PRIVATE_KEYS[0]) — separate from operator EOA (key[1]).
    const CREATOR_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
    const DEPLOYER_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!; // same key — deployer + creator
    const { privateKeyToAccount } = await import('viem/accounts');
    const creatorAddress = privateKeyToAccount(CREATOR_PRIV_KEY).address;
    await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
      creatorAddress,
      '0x56bc75e2d63100000', // 100 ETH
    ]);
    console.log(`creator EOA:  ${creatorAddress}`);

    // Deploy V3 task stack locally. The production JinnRouter V1 on Base mainnet
    // does not have the createTask(taskCidDigest, manifestDigest, policy, ...)
    // interface — it uses the older OLAS request-first flow. We deploy a fresh
    // V3 stack so we can post tasks and have the daemon claim them.
    const v3Env = await deployMinimalV3Stack(fixture, operator, DEPLOYER_PRIV_KEY);
    console.log(`V3 router:    ${v3Env.routerAddress}`);
    console.log(`mock mech:    ${v3Env.mockMechAddress}`);
    console.log(`mock market:  ${v3Env.mockMarketplaceAddress}`);

    // Start the daemon pointing at:
    //   - mock IPFS gateway so task fetches hit our in-process server
    //   - mock IPFS registry so envelope uploads hit our in-process server
    //   - V3 router so the daemon scans for and claims V3 tasks
    const running = await startDaemon(
      fixture,
      operator,
      harness,
      mockIpfs.baseUrl,  // ipfsGatewayUrl — for GET /ipfs/{cid} (task fetch)
      v3Env,
      mockIpfs.baseUrl,  // ipfsRegistryUrl — for POST /api/v0/add (envelope upload)
    );
    try {
      console.log('daemon started — loops running');

      // Post the task and register it with the mock IPFS server.
      const posted = await postPredictionV1Task(
        fixture,
        operator,
        CREATOR_PRIV_KEY,
        mockIpfs,
        v3Env,
      );
      console.log(`posted task:  id=${posted.taskId} cidDigest=${posted.taskCidDigest}`);

      // Wait for the daemon to discover and claim the task.
      const claim = await waitForDaemonClaim(fixture, posted, operator, v3Env);
      console.log(`daemon claimed task: requestId=${claim.requestId} tx=${claim.txHash}`);

      // Wait for the daemon to complete the full settlement loop:
      // harness runs → envelope assembled + uploaded → deliverToMarketplace on-chain.
      const delivered = await waitForDelivery(fixture, claim, v3Env, mockIpfs);
      console.log(`delivered: tx=${delivered.deliveryTxHash} solver=${delivered.solverHarnessName}`);

      // Task 6 assertion: the envelope must name the harness we selected.
      const expected = selectorToHarnessName(harness);
      if (delivered.solverHarnessName !== expected) {
        throw new Error(
          `expected solver=${expected} got=${delivered.solverHarnessName}`,
        );
      }
      console.log(`  ✓ envelope.executor.implName = ${delivered.solverHarnessName}`);

      console.log(`\n=== Task 6 ok — daemon + ${harness} settled prediction.v1 task on Anvil ===`);
    } finally {
      // Daemon must stop before Anvil tears down (avoids loops throwing on disconnect).
      await running.stop();
    }
  } finally {
    await mockIpfs.close();
    await fixture.teardown();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
