// client/test/e2e/daemon-harness-cycle.ts
/**
 * Daemon + real harness + on-chain settlement loop e2e (jinn-mono-wyy6).
 *
 * Public command: `yarn e2e:daemon-harness`.
 *
 * Spans:
 *   Anvil fork → earning bootstrap → production Daemon (MechAdapter)
 *   → prediction.v1 task post → daemon claims + executes (real harness)
 *   → on-chain deliver tx → self-eval verdict → activity counter increments.
 *
 * Pick harness via JINN_E2E_HARNESS=prediction-v1-baseline|hermes-agent|claude-code|codex.
 * Defaults to prediction-v1-baseline (deterministic, no API key required).
 * Skips cleanly if the selected harness's API key isn't available.
 *
 * Activity credit on V3 is verdict-gated (`claimVerdictDelivery` → recordSolutionDelivery),
 * not solution Deliver — see readActivityCount docstring.
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
  waitForVerdict,
  readActivityCount,
  startMockPolymarketGammaServer,
  ANVIL_PRIVATE_KEYS,
} from './_daemon-harness-helpers.js';
import { jsonRpc as anvilJsonRpc } from '../_support/chain/anvil.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';

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
  let mockGamma: Awaited<ReturnType<typeof startMockPolymarketGammaServer>> | undefined;
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

    // Offline Polymarket Gamma so self-eval does not hit live gamma-api (fixture market → 422).
    // Same pattern as hermetic/full-loop.test.ts and T2.2-producer-evaluator.
    const mockGammaServer = await startMockPolymarketGammaServer({
      marketId: 'jinn-daemon-harness-e2e-task4',
      conditionId: '0xcondition-daemon-harness-e2e-task4',
      slug: 'jinn-daemon-harness-e2e-task4',
    });
    mockGamma = mockGammaServer;
    console.log(`mock gamma:   ${mockGammaServer.baseUrl}`);

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
      // Task 18: build the stage-1 cutover composition root (main.ts's testnet branch) so a
      // broadcaster is built and threaded to the daemon's legacy Safe-write call sites before
      // daemon.start() — every Safe-executed transaction now requires one (Finding E16 / the C2
      // ruling: per-daemon state, not a process-global — see startDaemon's opts doc comment).
      { enableComposition: true, polymarketGammaBaseUrl: mockGammaServer.baseUrl },
    );
    try {
      console.log('daemon started — loops running');

      // Sample the activity counter BEFORE posting the task (baseline).
      const activityBefore = await readActivityCount(fixture, operator, v3Env);
      console.log(`activity counter before: ${activityBefore}`);

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

      // Anvil forks leave the `finalized` tag stuck at the fork point. Venue-base's chain log
      // source falls back to `latest - 120` in that shape (see chain-log-source.ts), so the
      // claim is only finalizable once ≥120 blocks have been mined past it. Without this the
      // work loop hangs in `awaitFinalized` for the e2e's entire delivery wait.
      await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_mine', ['0x79']); // 121 blocks
      console.log('mined 121 blocks so anvil-fork finality depth can cover the claim');

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

      // V3 activity increments on the first verdict, not on solution Deliver. Wait for the
      // operator to self-evaluate (allowSolverSelfEvaluation: true on the posted task).
      const verdict = await waitForVerdict(fixture, posted, operator, v3Env);
      console.log(`verdict claimed: tx=${verdict.verdictTxHash}`);

      // Task 7 assertion: daemon's settle tx must have incremented the operator's
      // on-chain activity counter. The V3 router calls
      // `recordSolutionDelivery(safeAddress, solutionDigest)` on our locally-deployed
      // TaskActivityCheckerV3 from claimVerdictDelivery when the attempt finalizes.
      // Poll for up to 60s — the claimVerdictDelivery tx may execute slightly after
      // the VerdictDeliveryClaimed event we already observed.
      let activityAfter = activityBefore;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && activityAfter <= activityBefore) {
        activityAfter = await readActivityCount(fixture, operator, v3Env);
        if (activityAfter > activityBefore) break;
        await new Promise<void>((r) => setTimeout(r, 1000));
      }
      console.log(`activity counter after:  ${activityAfter}`);
      if (activityAfter <= activityBefore) {
        throw new Error(
          `activity counter did not increment (before=${activityBefore} after=${activityAfter})`,
        );
      }
      console.log(`  ✓ activity counter incremented (${activityBefore} → ${activityAfter})`);

      console.log(`\n=== Task 7 ok — full settlement + activity counter increment for ${harness} ===`);

      // ── #1393: corpus knowledge autoload — second run of the same task type ──
      //
      // Run 1's pack() must have projected its envelope into the local corpus
      // index; run 2 (same solverType) must have consumed it: the injected
      // refs are persisted as consumed_refs_json and mirrored in a
      // corpus_knowledge activity event. All assertions read RunningDaemon's
      // own SQLite store — no discovery/indexer infra (startDaemon omits
      // corpusFactory, so this exercises the store-only knowledge path).
      const persistence = new TaskRunPersistence(running.store.db);
      const row1 = persistence.getByRequestId(claim.requestId);
      const run1EnvelopeCid = row1?.manifestCid;
      if (!run1EnvelopeCid) {
        throw new Error(`run 1 has no manifestCid persisted (requestId=${claim.requestId})`);
      }

      // (a) run 1's envelope projection exists locally.
      const projections = running.store.queryEnvelopeProjections({
        solverType: 'prediction.v1',
        role: 'solution',
      });
      if (!projections.some((p) => p.envelopeCid === run1EnvelopeCid)) {
        throw new Error(
          `run 1 envelope projection missing (want envelopeCid=${run1EnvelopeCid}, `
          + `have ${projections.map((p) => p.envelopeCid).join(', ') || 'none'})`,
        );
      }
      console.log(`  ✓ run 1 envelope projection exists (${run1EnvelopeCid})`);

      // Run 1's solution artifact sha256 (served_artifacts, backfilled with the
      // envelope CID by pack()).
      const run1Artifacts = running.store
        .searchOwnAndCached({ artifactType: 'prediction_v1_solution', limit: 50 })
        .filter((a) => a.envelopeCid === run1EnvelopeCid);
      if (run1Artifacts.length === 0) {
        throw new Error(`run 1 has no prediction_v1_solution artifact for ${run1EnvelopeCid}`);
      }
      const run1ArtifactSha = run1Artifacts[0]!.sha256;

      // Post a second prediction.v1 task and drive it to delivery.
      const posted2 = await postPredictionV1Task(fixture, operator, CREATOR_PRIV_KEY, mockIpfs, v3Env);
      console.log(`posted task 2: id=${posted2.taskId} cidDigest=${posted2.taskCidDigest}`);
      // Advance the fork head so the projector/archive feed observes TaskCreated for task 2
      // promptly after the long verdict/activity-counter leg above.
      await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_mine', ['0x5']);
      const claim2 = await waitForDaemonClaim(fixture, posted2, operator, v3Env, 180_000);
      console.log(`daemon claimed task 2: requestId=${claim2.requestId}`);
      await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_mine', ['0x79']);
      const delivered2 = await waitForDelivery(fixture, claim2, v3Env, mockIpfs);
      console.log(`delivered task 2: tx=${delivered2.deliveryTxHash}`);

      // (b) run 2 consumed run 1's record: consumed_refs_json references the
      // first envelope CID and the solution artifact sha256.
      const row2 = persistence.getByRequestId(claim2.requestId);
      const consumed = JSON.parse(row2?.consumedRefsJson ?? '[]') as Array<{
        envelopeCid: string;
        artifacts: Array<{ sha256: string }>;
      }>;
      const consumedRun1 = consumed.find((r) => r.envelopeCid === run1EnvelopeCid);
      if (!consumedRun1) {
        throw new Error(
          `run 2 consumed_refs_json does not reference run 1's envelope `
          + `(want ${run1EnvelopeCid}, got ${JSON.stringify(consumed)})`,
        );
      }
      if (!consumedRun1.artifacts.some((a) => a.sha256 === run1ArtifactSha)) {
        throw new Error(
          `run 2 consumed refs missing run 1's solution artifact sha256 `
          + `(want ${run1ArtifactSha}, got ${JSON.stringify(consumedRun1.artifacts)})`,
        );
      }
      console.log(`  ✓ run 2 consumed run 1's record (envelope=${run1EnvelopeCid} sha=${run1ArtifactSha})`);

      // (c) the corpus_knowledge event fired for run 2.
      const knowledgeEvents = running.store.db
        .prepare(`SELECT detail FROM activity_events WHERE kind = 'corpus_knowledge' AND request_id = ?`)
        .all(claim2.requestId) as Array<{ detail: string }>;
      if (knowledgeEvents.length === 0) {
        throw new Error(`no corpus_knowledge event recorded for run 2 (${claim2.requestId})`);
      }
      console.log(`  ✓ corpus_knowledge event recorded for run 2`);

      console.log(`\n=== #1393 ok — second run consumed the first run's published knowledge ===`);
    } finally {
      // Daemon must stop before Anvil tears down (avoids loops throwing on disconnect).
      await running.stop();
    }
  } finally {
    await mockGamma?.close();
    await mockIpfs.close();
    await fixture.teardown();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
