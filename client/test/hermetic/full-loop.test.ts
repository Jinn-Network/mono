/**
 * Hermetic gate — the full daemon loop on the snapshot.
 *
 * Spec: docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md
 * §3.1 ("bootstrap → claim → execute → deliver → settle → activity-counter →
 * indexer round-trip") and §6 Home 1 ("Loop plumbing (claim→…→activity-counter)
 * | [consolidate] one hermetic loop, deterministic harness").
 *
 * This is the headline §3.1 capability: the REAL production Daemon (MechAdapter,
 * Store, harness engine) running the whole settlement loop against the committed
 * Anvil snapshot — deterministic, no live RPC. It is the hermetic sibling of the
 * live-fork `daemon-harness-cycle.ts` e2e, sourced from `spawnAnvilFromState`.
 *
 * Flow: load snapshot → bootstrap a fresh staked operator → deploy a fresh V3
 * task stack on the loaded state → start the production Daemon with the
 * DETERMINISTIC prediction-v1-baseline harness (no API key) + a mock IPFS server
 * → post a prediction.v1 task → daemon discovers + claims it → harness executes
 * → daemon delivers on-chain → assert the operator's on-chain ACTIVITY COUNTER
 * incremented (the load-bearing proof the settlement loop closed).
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
  readActivityCount,
  selectorToHarnessName,
  startMockPolymarketGammaServer,
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

describeMaybe('hermetic full daemon loop (spec §3.1 / §6 Home 1)', () => {
  it(
    'bootstrap → claim → execute → deliver → settle → activity-counter increment, on the snapshot',
    async () => {
      const fixture = await setupAnvilFixtureFromState(SNAPSHOT_STATE);
      const mockIpfs = await startMockIpfsServer();
      // Deterministic, offline Polymarket Gamma mirror keyed to the task-4
      // fixture identifiers (see postPredictionV1Task). The restoration leg
      // (prediction-v1-baseline) needs no market lookup, but once the daemon
      // delivers it can create a self-evaluation job whose evaluator resolves
      // the market via getResolution. Without this mirror that call reaches the
      // LIVE gamma-api.polymarket.com and 422s (the slug is a fixture, not a
      // real market) — a live-network dependency the hermetic gate forbids, and
      // the extra failing tick perturbs the loop enough to lose the
      // waitForDelivery scan-floor race. Pointing the evaluator here keeps the
      // whole gate offline and deterministic regardless of runner timing.
      const mockGamma = await startMockPolymarketGammaServer({
        marketId: 'jinn-daemon-harness-e2e-task4',
        conditionId: '0xcondition-daemon-harness-e2e-task4',
        slug: 'jinn-daemon-harness-e2e-task4',
      });
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
            polymarketGammaBaseUrl: mockGamma.baseUrl,
            enableComposition: true,
          },
        );

        // Baseline the activity counter before posting.
        const activityBefore = await readActivityCount(fixture, operator, v3Env);

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

        // LOAD-BEARING: the settle tx must have incremented the operator's
        // on-chain activity counter (recordSolutionDelivery → activity checker).
        // Poll briefly — the claimSolutionDelivery tx may land just after Deliver.
        let activityAfter = activityBefore;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && activityAfter <= activityBefore) {
          activityAfter = await readActivityCount(fixture, operator, v3Env);
          if (activityAfter > activityBefore) break;
          await new Promise<void>((r) => setTimeout(r, 1000));
        }
        expect(
          activityAfter,
          `activity counter did not increment (before=${activityBefore} after=${activityAfter}) — the settlement loop did not close`,
        ).toBeGreaterThan(activityBefore);
      } finally {
        // Daemon must stop before Anvil tears down (loops throw on disconnect).
        if (running) { try { await running.stop(); } catch { /* best-effort */ } }
        try { await mockIpfs.close(); } catch { /* best-effort */ }
        try { await mockGamma.close(); } catch { /* best-effort */ }
        try { await fixture.teardown(); } catch { /* best-effort */ }
      }
    },
    240_000,
  );
});
