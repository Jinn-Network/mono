/**
 * Hermetic gate — the full daemon loop on the snapshot.
 *
 * Spec: docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md
 * §3.1 ("bootstrap → claim → execute → deliver → settle") and §6 Home 1
 * ("Loop plumbing" — one consolidated hermetic loop with a deterministic harness).
 *
 * This is the headline §3.1 solution capability: the REAL production Daemon
 * (MechAdapter and Store) running the solution loop against the committed
 * Anvil snapshot — deterministic, no live RPC. It is the hermetic sibling of the
 * live-fork `daemon-harness-cycle.ts` e2e, sourced from `spawnAnvilFromState`.
 *
 * Flow: load snapshot → bootstrap a fresh staked operator → deploy a fresh V3
 * task stack on the loaded state → start the production Daemon with the
 * DETERMINISTIC prediction-v1-baseline harness (no API key) + a mock IPFS server
 * → post a prediction.v1 task → daemon discovers + claims it → harness executes
 * → daemon delivers on-chain → assert the V3 router records the exact
 * SolutionDeliveryClaimed event (the load-bearing proof this solution leg closed).
 *
 * Wave-4 D2 retired the legacy evaluator that used to extend this rig through
 * verdict settlement and activity credit. That proof now lives next door on the
 * native evaluator (`native-evaluator-activity.test.ts`, issue #2666); this
 * solution-only rig must not claim that verdict-owned coverage.
 *
 * Deterministic: the prediction-v1-baseline harness needs no key and no network;
 * the V3 stack + bootstrap run on the loaded snapshot state; only the daemon +
 * harness + mock-IPFS subprocesses are live (in-process). SKIP-CLEAN when the
 * committed fixture is absent (the gate asserts its presence separately).
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  setupAnvilFixtureFromState,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  startDaemon,
  startMockIpfsServer,
  postPredictionV1Task,
  waitForDaemonClaim,
  waitForDelivery,
  waitForSolutionSettlement,
  selectorToHarnessName,
  ANVIL_PRIVATE_KEYS,
  type HarnessSelector,
} from '../e2e/_daemon-harness-helpers.js';
import { jsonRpc as anvilJsonRpc } from '../_support/chain/anvil.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(TEST_DIR, '..', '_support', 'fixtures', 'anvil-base-v3-state');
const SNAPSHOT_STATE = join(SNAPSHOT_DIR, 'state.json');

const SNAPSHOT_PRESENT = existsSync(SNAPSHOT_STATE) || existsSync(SNAPSHOT_DIR);
const describeMaybe = SNAPSHOT_PRESENT ? describe : describe.skip;

if (!SNAPSHOT_PRESENT) {
  // eslint-disable-next-line no-console
  console.error(
    `[hermetic] snapshot fixture absent at ${SNAPSHOT_STATE} — skipping full-loop suite. ` +
      `Run \`tsx contracts/scripts/build-anvil-snapshot.ts\` (needs BASE_RPC_URL) and commit ` +
      `the fixture to exercise this scenario.`,
  );
}

// The loop tests the LOOP, not the agent (spec §3.1): the deterministic baseline
// harness needs no API key, so this gate has zero credential dependencies.
const HARNESS: HarnessSelector = 'prediction-v1-baseline';
const PROVENANCE = {
  instanceId: 'jinn__hermetic-envelope-provenance',
  repo: 'Jinn-Network/mono',
  baseCommit: '1'.repeat(40),
};

describeMaybe('hermetic daemon solution loop (spec §3.1 / §6 Home 1)', () => {
  it(
    'bootstrap → claim → execute → deliver → solution settlement, on the snapshot',
    async () => {
      const fixture = await setupAnvilFixtureFromState(SNAPSHOT_STATE);
      const mockIpfs = await startMockIpfsServer();
      let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
      try {
        // Fresh staked operator on the loaded state (bootstrap correctness itself
        // is covered by bootstrap-from-scratch.test.ts; here it's setup).
        const operator = await bootstrapStakedOperator(fixture);

        // Creator EOA (key[0]) funds + posts the task; deployer (key[0]) deploys V3.
        const CREATOR_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
        const DEPLOYER_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
        const creatorAddress = privateKeyToAccount(CREATOR_PRIV_KEY).address;
        await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
          creatorAddress,
          '0x56bc75e2d63100000', // 100 ETH
        ]);

        // Deploy a fresh V3 task stack on the loaded snapshot state (local txs,
        // no network) whose mock mech is operated by THIS operator's Safe — so
        // the daemon can claim with its own mech.
        const v3Env = await deployMinimalV3Stack(fixture, operator, DEPLOYER_PRIV_KEY);

        // The dump-state fixture retains its tip but not arbitrary predecessor blocks. Mine a
        // local finality buffer so the compatibility projector never requests pre-snapshot data.
        await fixture.anvil.mineBlocks(130);

        running = await startDaemon(
          fixture,
          operator,
          HARNESS,
          mockIpfs.baseUrl, // ipfsGatewayUrl (task fetch)
          v3Env,
          mockIpfs.baseUrl, // ipfsRegistryUrl (envelope upload)
          {
            enableComposition: true,
          },
        );

        const posted = await postPredictionV1Task(
          fixture,
          operator,
          CREATOR_PRIV_KEY,
          mockIpfs,
          v3Env,
          { provenance: PROVENANCE },
        );
        expect(posted.taskId, 'task was not posted').toBeGreaterThan(0n);

        // Daemon discovers + claims the task (proves the discovery + claim loop).
        const claim = await waitForDaemonClaim(fixture, posted, operator, v3Env);
        expect(claim.requestId, 'daemon did not claim the task').toMatch(/^0x[0-9a-fA-F]+$/);

        // Daemon runs the harness, assembles + uploads the envelope, and delivers
        // on-chain (proves execute → deliver → settle).
        const delivered = await waitForDelivery(fixture, claim, v3Env, mockIpfs);
        expect(delivered.deliveryTxHash, 'no on-chain delivery tx').toMatch(/^0x[0-9a-fA-F]+$/);
        const settlement = await waitForSolutionSettlement(fixture, claim, operator, v3Env);
        expect(settlement.txHash, 'no on-chain solution-settlement tx').toMatch(/^0x[0-9a-fA-F]+$/);
        expect(settlement.requestId.toLowerCase()).toBe(claim.requestId.toLowerCase());
        expect(settlement.operator.toLowerCase()).toBe(operator.safeAddress.toLowerCase());
        // The envelope must name the deterministic harness we ran.
        expect(delivered.solverHarnessName).toBe(selectorToHarnessName(HARNESS));
        const claimReceipt = await fixture.publicClient.getTransactionReceipt({
          hash: claim.txHash,
        });
        expect(
          claimReceipt.blockNumber,
          'fixture must separate TaskCreated from TaskAttemptCreated',
        ).not.toBe(posted.createdAtBlock);
        // The legacy-to-TEP bridge is explicit about the provenance it cannot reconstruct: it
        // carries the real marketplace request id while leaving creation anchors as documented
        // placeholders. The native exact-document path owns full Task provenance.
        expect(delivered.envelope.task).toMatchObject({
          requestId: claim.requestId,
          onchainCreationTx: '0x',
          onchainCreationBlock: 0,
        });
        expect(delivered.envelope.payload).toMatchObject({ probabilityYes: '0.75' });

      } finally {
        // Daemon must stop before Anvil tears down (loops throw on disconnect).
        if (running) { try { await running.stop(); } catch { /* best-effort */ } }
        try { await mockIpfs.close(); } catch { /* best-effort */ }
        try { await fixture.teardown(); } catch { /* best-effort */ }
      }
    },
    240_000,
  );
});
