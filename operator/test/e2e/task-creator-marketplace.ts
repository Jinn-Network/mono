// operator/test/e2e/task-creator-marketplace.ts
/**
 * Task Creator marketplace-leg e2e (WP6 / Task 5).
 *
 * The plumbing proof (`task-creator-harvest-e2e.test.ts`) stops at
 * `minted-pool.json` + IPFS — it never posts a minted task on-chain. This
 * script proves the on-chain half of the loop on an Anvil fork of Base,
 * reusing the settlement rig from `operator/test/e2e/daemon-harness-cycle.ts`
 * (`_daemon-harness-helpers.ts`: Anvil fork, local JinnRouterV3 stack, mock
 * IPFS, production Daemon).
 *
 * Five assertions (see task-5-brief.md):
 *   1. A minted instance (syntheticProvenance present) is selected by the
 *      generator (`selectNextPostingCandidates`) and posted on-chain with the
 *      complexity-weighted escrow (`resolveMintedTaskDeliveryRate` →
 *      `computeEscrowWei`), not the flat mech rate.
 *   2. A claim attempt by the MINTER operator is refused (`syntheticClaimBlocked`,
 *      enforced live at `harnesses/engine/engine.ts:1134`).
 *   3. A claim by a second operator identity succeeds; the mock solver
 *      (StubHarness, env-gated, no Claude/Docker) returns the gold patch once
 *      and a garbage patch once, across two on-chain postings of the same
 *      minted instance.
 *   4. The evaluator grades both: gold ⇒ pass verdict, garbage ⇒ fail verdict.
 *   5. `computeExemplarPairYield` over the two verified trajectories counts
 *      exactly one exemplar pair for the minted instance, attributed to the
 *      minted (not baseline) bucket of `buildTaskCreatorMetricReport`.
 *
 * Scoping (see task-5-report.md for the full rationale):
 *   - REAL on-chain: task posting (createTask), the minter's refused claim
 *     attempt (a live Daemon that never emits a claimTx), the solver's real
 *     claim + solution delivery (a live Daemon via MechAdapter), and the
 *     verdict settlement (claimEvaluation → deliverToMarketplace →
 *     claimVerdictDelivery, Safe-mediated production `contracts.ts` calls).
 *   - FAKED (per controller resolution #3, matching task-creator-harvest-e2e.test.ts):
 *     the solver is a StubHarness returning a canned patch (no Claude); the
 *     evaluator grade is a deterministic score chosen by this script instead
 *     of running the real Docker-backed `SweRebenchV2Evaluator` (which needs
 *     a cloned upstream repo + Docker and is not wired for injectable stubs
 *     through `buildHarnesses`). computeExemplarPairYield is driven directly
 *     on the two real on-chain verdict outcomes rather than through the full
 *     yield-report/Docker pipeline.
 *
 * Public command: `yarn e2e:task-creator`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
} from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import {
  setupAnvilFixture,
  startMockIpfsServer,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  startSweRebenchSolverDaemon,
  startDaemon,
  waitForDaemonClaim,
  waitForDelivery,
  ANVIL_PRIVATE_KEYS,
  type DaemonHarnessFixture,
  type BootstrappedOperator,
  type TaskV3Env,
  type MockIpfsServer,
  type RunningDaemon,
} from './_daemon-harness-helpers.js';
import {
  assert,
  compileContracts,
  decodeFirstEvent,
  signedExecutionEnvelope,
  writeContractTx,
} from './task-first-helpers.js';
import { KNOWN_MANIFEST_CID } from '../release/tier-2/fixtures/known-instance.js';
import { jsonRpc as anvilJsonRpc } from '../_support/chain/anvil.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';
import { JINN_ROUTER_ABI } from '../../src/adapters/mech/types.js';
import { getMechDeliveryRate, getTimeoutBounds, claimDelivery, callDeliverToMarketplace } from '../../src/adapters/mech/contracts.js';
// Wave-4 D2: `contracts.ts`'s `claimEvaluation` retired with the mech adapter's
// evaluation half; venue-base's verdict port is the surviving verdict tx path.
import { createVerdictPorts } from '@jinn-network/marketplace-venue-base';
import { createDirectSafeBroadcaster } from '../../src/adapters/mech/direct-safe-broadcaster.js';
import { createClients } from '../../src/adapters/mech/safe.js';
import { VerdictCode } from '../../src/adapters/mech/verdict-code.js';
import { uploadToIpfs } from '../../src/adapters/mech/ipfs.js';
import {
  selectNextPostingCandidates,
  DEFAULT_GENERATOR_CONFIG,
} from '../../src/solver-types/swe-rebench-v2-auto.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import {
  MintedPoolStore,
  loadMintedPoolTasks,
  EVAL_SEMANTICS_VERSION,
  type MintedProvenance,
  type MintedPoolEntry,
  type MintedPoolRow,
} from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import {
  escrowInputsFromPatch,
  commitEchoLineageHash,
  DEFAULT_SYNTHETIC_ESCROW_PARAMS,
  MINTED_DATASET_PLACEHOLDER,
} from '../../src/solver-types/_swe-rebench-v2-harvest.js';
import { resolveMintedTaskDeliveryRate } from '../../src/solver-types/_swe-rebench-v2-escrow.js';
import { syntheticClaimBlocked } from '../../src/solver-types/_swe-rebench-v2-synthetic-claim.js';
import {
  computeExemplarPairYield,
  buildTaskCreatorMetricReport,
  type InstanceVerdictStats,
} from '../../src/solver-types/_swe-rebench-v2-yield.js';

const MINTED_INSTANCE_ID = 'sympy__sympy__echo-marketplace-e2e-1';
const SOURCE_INSTANCE_ID = 'sympy__sympy-27510';
const BASELINE_INSTANCE_ID = 'zzz-baseline-noop-task'; // sorts after MINTED_INSTANCE_ID (tie-break on instance_id)
const REPO = 'sympy/sympy';
const FAIL_TO_PASS = ['sympy/tests/test_x.py::test_fix'];
const GOLD_PATCH =
  '--- a/sympy/core.py\n+++ b/sympy/core.py\n@@ -1,2 +1,2 @@\n-def value():\n-    return 0\n+def value():\n+    return 1\n';
const GARBAGE_PATCH =
  '--- a/sympy/core.py\n+++ b/sympy/core.py\n@@ -1,2 +1,2 @@\n-def value():\n-    return 0\n+def value():\n+    return 999  # garbage, does not fix the bug\n';

interface PostedMintedTask {
  taskId: bigint;
  taskCidDigest: `0x${string}`;
  manifestDigest: `0x${string}`;
  createdAtBlock: bigint;
  creationTxHash: `0x${string}`;
  taskCid: string;
  deliveryRate: bigint;
  onchainSolutionBudget: bigint;
  window: { startTs: number; endTs: number };
}

/**
 * Sign, register with mock IPFS, and post a swe-rebench-v2.v1 task carrying
 * `eligibility` (which may include `syntheticEscrow` / `syntheticProvenance`)
 * on the locally-deployed V3 router. Mirrors `postSweRebenchV2Task` in
 * `_daemon-harness-helpers.ts` but — unlike that helper — computes the
 * delivery rate via the REAL `resolveMintedTaskDeliveryRate` (the same call
 * `MechAdapter.postTask` makes in production, adapter.ts:602-606) instead of
 * the flat mech rate, so a minted task's escrow is genuinely complexity-weighted.
 */
async function postMintedTask(args: {
  fixture: DaemonHarnessFixture;
  mockIpfs: MockIpfsServer;
  v3Env: TaskV3Env;
  creatorPrivKey: `0x${string}`;
  creatorSafeAddress: `0x${string}`;
  id: string;
  description: string;
  eligibility: Record<string, unknown>;
}): Promise<PostedMintedTask> {
  const { fixture, mockIpfs, v3Env } = args;
  const rpcUrl = fixture.anvil.rpcUrl;
  const creator = privateKeyToAccount(args.creatorPrivKey);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const window = { startTs: now - 5_000, endTs: now + 600_000 };

  const unsignedTaskDoc = {
    schemaVersion: 'task.v1' as const,
    id: args.id,
    solverType: 'swe-rebench-v2.v1',
    solverNetManifestCid: KNOWN_MANIFEST_CID,
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    role: 'restoration' as const,
    description: args.description,
    window,
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: MINTED_INSTANCE_ID,
      repo: REPO,
      base_commit: 'a'.repeat(40),
      language: 'python',
      problem_statement: `task-creator marketplace e2e: ${MINTED_INSTANCE_ID}`,
      interface: '',
      hf_dataset: MINTED_DATASET_PLACEHOLDER,
      hf_split: 'minted',
      deadline_unix: nowSec + 3600,
      round_month: '2026-07',
    },
    eligibility: args.eligibility,
    claimPolicy: {
      mode: 'parallel' as const,
      maxClaims: 1,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 600,
      claimWindowStartTs: nowSec - 5,
      claimWindowEndTs: nowSec + 300,
      submissionDeadlineTs: nowSec + 900,
    },
    creator: {
      safeAddress: args.creatorSafeAddress,
      agentEoa: creator.address as `0x${string}`,
    },
    createdAt: now,
  };

  const signed = await signCanonical(unsignedTaskDoc, args.creatorPrivKey, creator.address);
  const signedTaskDoc = {
    ...unsignedTaskDoc,
    signature: { algo: 'secp256k1' as const, signer: creator.address, hash: signed.hash, sig: signed.sig },
  };
  const taskJson = JSON.stringify(signedTaskDoc);
  const taskCidDigest = keccak256(toBytes(taskJson)) as `0x${string}`;
  mockIpfs.register(taskCidDigest, signedTaskDoc);
  const taskCid = `f01551220${taskCidDigest.slice(2)}`;

  const manifestDigest = keccak256(toBytes(KNOWN_MANIFEST_CID));

  // Real production computation: base flat mech rate → complexity-weighted
  // rate via resolveMintedTaskDeliveryRate (same call adapter.ts makes).
  const baseFlatRate = await getMechDeliveryRate(fixture.publicClient, v3Env.mockMechAddress as Address);
  const deliveryRate = resolveMintedTaskDeliveryRate(baseFlatRate, args.eligibility);

  const timeoutBounds = await getTimeoutBounds(fixture.publicClient, v3Env.mockMarketplaceAddress as Address);
  const responseTimeout = timeoutBounds.min > 0n ? timeoutBounds.min : 3600n;
  const MAX_CLAIMS = 1n;
  const policy = { maxClaims: 1, allowSolverSelfEvaluation: true };
  const value = deliveryRate * MAX_CLAIMS * 2n;

  const created = await writeContractTx({
    publicClient: fixture.publicClient,
    rpcUrl,
    account: creator,
    address: v3Env.routerAddress as Address,
    abi: JINN_ROUTER_ABI,
    functionName: 'createTask',
    args: [taskCidDigest, manifestDigest, policy, deliveryRate, deliveryRate, responseTimeout],
    value,
  });

  const taskCreated = decodeFirstEvent(created.receipt, JINN_ROUTER_ABI, 'TaskCreated');
  const taskId = BigInt(String(taskCreated['taskId']));
  const onchainSolutionBudget = BigInt(String(taskCreated['solutionBudget']));
  const createdAtBlock = BigInt(created.receipt.blockNumber ?? 0n);

  return {
    taskId,
    taskCidDigest,
    manifestDigest,
    createdAtBlock,
    creationTxHash: created.hash,
    taskCid,
    deliveryRate,
    onchainSolutionBudget,
    window,
  };
}

/** Decode the `attemptIndex` a daemon's claim tx recorded, from its receipt. */
async function attemptIndexFromClaimTx(fixture: DaemonHarnessFixture, txHash: `0x${string}`): Promise<number> {
  const receipt = await fixture.publicClient.getTransactionReceipt({ hash: txHash });
  const decoded = decodeFirstEvent(receipt, JINN_ROUTER_ABI, 'TaskAttemptCreated');
  return Number(decoded['attemptIndex']);
}

/**
 * Self-evaluate a solved swe-rebench-v2.v1 attempt via REAL on-chain, Safe-
 * mediated production calls (`claimEvaluation` → `callDeliverToMarketplace` →
 * `claimDelivery`), with a deterministic score chosen by the caller instead
 * of running the real Docker-backed evaluator (per controller resolution #3).
 */
async function submitSelfEvaluation(args: {
  fixture: DaemonHarnessFixture;
  v3Env: TaskV3Env;
  evaluator: BootstrappedOperator;
  posted: PostedMintedTask;
  attemptIndex: number;
  score: 0 | 1;
}): Promise<{ verdictCode: number; verdictTxHash: Hex }> {
  const { fixture, v3Env, evaluator, posted } = args;
  const { publicClient, walletClient } = createClients(fixture.anvil.rpcUrl, evaluator.agentPrivateKey, base);

  const evaluationTaskCidDigest = keccak256(
    toBytes(`evaluation:${posted.taskCid}:${posted.taskId}:${args.attemptIndex}`),
  ) as Hex;
  const claimEvalResult = await createVerdictPorts({
    publicClient,
    broadcaster: createDirectSafeBroadcaster(
      publicClient,
      walletClient,
      evaluator.safeAddress as Address,
    ) as never,
    safeAddress: evaluator.safeAddress as Address,
    routerAddress: v3Env.routerAddress as Address,
    mechAddress: v3Env.mockMechAddress as Address, // self-eval: same mech the solver claimed with
  }).openVerdictAttempt({
    operationId: `e2e-open-verdict:${posted.taskId}:${args.attemptIndex}`,
    taskId: BigInt(posted.taskId),
    attemptIndex: args.attemptIndex,
    evaluationTaskCidDigest,
  });

  const verdictPayload = SweRebenchV2VerdictPayloadSchema.parse({
    schemaVersion: 'swe-rebench-v2-verdict.v1',
    score: args.score,
    passed_match: args.score === 1,
    evaluator_cost_usd: 0,
  });
  const verdictEnvelope = await signedExecutionEnvelope({
    solverType: 'swe-rebench-v2.v1',
    role: 'verdict',
    taskCid: posted.taskCid,
    requestId: claimEvalResult.requestId,
    onchainCreationTx: posted.creationTxHash,
    onchainCreationBlock: Number(posted.createdAtBlock),
    safeAddress: evaluator.safeAddress as Address,
    privateKey: evaluator.agentPrivateKey,
    window: posted.window,
    payload: verdictPayload as unknown as Record<string, unknown>,
    implName: 'task-creator-marketplace-e2e-evaluator-stub',
  });

  await callDeliverToMarketplace(
    publicClient,
    walletClient,
    evaluator.safeAddress as Address,
    v3Env.mockMechAddress as Address,
    [claimEvalResult.requestId as Hex],
    [verdictEnvelope.signature.hash as Hex],
  );

  const submittedVerdictCode = args.score === 1 ? VerdictCode.Pass : VerdictCode.Fail;
  const verdictTxHash = await claimDelivery(
    publicClient,
    walletClient,
    evaluator.safeAddress as Address,
    v3Env.routerAddress as Address,
    claimEvalResult.requestId as Hex,
    { variant: 'v3', kind: 'verdict', evidenceHash: verdictEnvelope.signature.hash as Hex, verdictCode: submittedVerdictCode },
  );

  // Return the verdict code decoded from the on-chain VerdictDeliveryClaimed
  // event, NOT the locally computed value — downstream assertions (4 and 5)
  // must consume chain truth so they fail if the settlement recorded something
  // other than what was submitted.
  assert(
    verdictTxHash !== '0x',
    `claimVerdictDelivery for requestId=${claimEvalResult.requestId} returned no tx hash (already claimed?)`,
  );
  const verdictReceipt = await publicClient.getTransactionReceipt({ hash: verdictTxHash });
  const verdictEvent = decodeFirstEvent(verdictReceipt, JINN_ROUTER_ABI, 'VerdictDeliveryClaimed');
  const verdictCode = Number(verdictEvent['verdictCode']);

  return { verdictCode, verdictTxHash };
}

async function main(): Promise<void> {
  console.log('\n=== task-creator-marketplace e2e (WP6 / Task 5) ===');
  await compileContracts();
  const fixture = await setupAnvilFixture();
  const mockIpfs = await startMockIpfsServer();

  let daemonA: RunningDaemon | undefined;
  let daemonB: RunningDaemon | undefined;

  try {
    console.log(`anvil rpc: ${fixture.anvil.rpcUrl}`);

    // ── Two operators: A = minter (never allowed to claim its own mint),
    // B = solver + self-evaluator (allowSolverSelfEvaluation:true, single-
    // operator dogfood pattern already used by daemon-harness-cycle.ts). ──
    console.log('bootstrapping operator A (minter)...');
    const operatorA = await bootstrapStakedOperator(fixture);
    console.log(`  operator A Safe: ${operatorA.safeAddress}`);
    console.log('bootstrapping operator B (solver/evaluator)...');
    const operatorB = await bootstrapStakedOperator(fixture);
    console.log(`  operator B Safe: ${operatorB.safeAddress}`);

    const CREATOR_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
    const DEPLOYER_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
    const creatorAddress = privateKeyToAccount(CREATOR_PRIV_KEY).address;
    await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [creatorAddress, '0x56bc75e2d63100000']);

    // V3 stack + mech bound to operator B's Safe (the actual claimer).
    const v3Env = await deployMinimalV3Stack(fixture, operatorB, DEPLOYER_PRIV_KEY);
    console.log(`V3 router: ${v3Env.routerAddress}`);
    console.log(`mock mech (operator B): ${v3Env.mockMechAddress}`);

    // ── Start operator A's (minter) and operator B's (solver) daemons BEFORE
    // posting any task. MechAdapter's on-chain task-discovery cursor
    // (`requestBlockCursor`) is initialized to the CURRENT block at daemon
    // startup (adapter.ts initialize()) and only scans forward from there —
    // a task posted before the daemon starts is permanently invisible to it. ──
    const stubFixturesDir = mkdtempSync(join(tmpdir(), 'tc-marketplace-e2e-fixtures-'));
    writeFileSync(join(stubFixturesDir, `${MINTED_INSTANCE_ID}.patch`), GOLD_PATCH);

    console.log('\nstarting operator A (minter) daemon — must never claim...');
    daemonA = await startSweRebenchSolverDaemon(fixture, operatorA, mockIpfs.baseUrl, v3Env, mockIpfs.baseUrl, {
      instanceLabel: 'op-a-minter',
      fixturesDir: stubFixturesDir,
      instanceMatcher: MINTED_INSTANCE_ID,
    });
    console.log('starting operator B (solver) daemon...');
    daemonB = await startSweRebenchSolverDaemon(fixture, operatorB, mockIpfs.baseUrl, v3Env, mockIpfs.baseUrl, {
      instanceLabel: 'op-b-solver',
      fixturesDir: stubFixturesDir,
      instanceMatcher: MINTED_INSTANCE_ID,
    });

    // ── Assertion 1a: seed a minted pool entry + prove the generator selects it ──
    console.log('\n--- Assertion 1: generator selects minted instance; posts with weighted escrow ---');
    const stateDir = mkdtempSync(join(tmpdir(), 'tc-marketplace-e2e-state-'));
    const mintedStore = new MintedPoolStore({ stateDir });

    const mintedRow: MintedPoolRow = {
      instance_id: MINTED_INSTANCE_ID,
      repo: REPO,
      problem_statement: 'Marketplace e2e fixture: fix value() to return 1.',
      base_commit: 'a'.repeat(40),
    };
    const provenance: MintedProvenance = {
      synthetic: true,
      mintFamily: 'commit-echo',
      sourceLineageHash: commitEchoLineageHash(REPO, 'b'.repeat(40)),
      sourceInstanceId: SOURCE_INSTANCE_ID,
      minterSafe: operatorA.safeAddress,
    };
    const mintedEntry: MintedPoolEntry & { goldPatch: string } = {
      row: {
        ...mintedRow,
        image_name: 'swe-rebench/sympy:marketplace-e2e',
        FAIL_TO_PASS,
        PASS_TO_PASS: ['sympy/tests/test_x.py::test_other'],
        test_patch: 'diff --git a/sympy/tests/test_x.py b/sympy/tests/test_x.py\n',
        install_config: { test_cmd: 'pytest sympy/tests/test_x.py', log_parser: 'parse_log_pytest', install: ['pip install -e .'] },
      },
      provenance,
      admission: { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString() },
      hf_dataset: MINTED_DATASET_PLACEHOLDER,
      hf_split: 'minted',
      mintedAt: new Date().toISOString(),
      goldPatch: GOLD_PATCH,
    };
    await mintedStore.record(MINTED_INSTANCE_ID, mintedEntry, EVAL_SEMANTICS_VERSION);

    // Publish the minted-pool artifact through the real uploadToIpfs() call
    // (against the mock IPFS server) — loadMintedPoolTasks() only surfaces
    // entries once a publishedArtifactCid exists, matching production.
    const artifact = await mintedStore.exportArtifact(EVAL_SEMANTICS_VERSION);
    const publishedCid = await uploadToIpfs(mockIpfs.baseUrl, artifact);
    await mintedStore.setPublishedArtifact(EVAL_SEMANTICS_VERSION, publishedCid, [MINTED_INSTANCE_ID]);
    console.log(`  minted-pool artifact published: ${publishedCid}`);

    const mintedPoolTasks = await loadMintedPoolTasks(mintedStore, EVAL_SEMANTICS_VERSION);
    assert(mintedPoolTasks.length === 1, `expected 1 minted pool task, got ${mintedPoolTasks.length}`);
    const mintedTask = mintedPoolTasks[0]!;
    assert(mintedTask.instance_id === MINTED_INSTANCE_ID, 'minted pool task instance_id mismatch');
    assert(mintedTask.patch === GOLD_PATCH, 'minted pool task did not carry the gold patch through loadMintedPoolTasks');

    const baselineTask: PoolTask = {
      instance_id: BASELINE_INSTANCE_ID,
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2025_01',
      repo: 'baseline/repo',
      base_commit: 'c'.repeat(40),
      language: 'python',
    };

    // Real generator selection logic (swe-rebench-v2-auto.ts) — batch_size=4
    // so the 25% synthetic quota (applySyntheticQuotaFromTagged) admits ≥1.
    const selected = selectNextPostingCandidates({
      pool: [baselineTask, mintedTask],
      counters: new Map(),
      config: { ...DEFAULT_GENERATOR_CONFIG, post_batch_size: 4 },
      now: Date.now(),
      syntheticInstanceIds: new Set([MINTED_INSTANCE_ID]),
    });
    const selectedMinted = selected.find((t) => t.instance_id === MINTED_INSTANCE_ID);
    assert(!!selectedMinted, 'ASSERTION 1 FAILED: selectNextPostingCandidates did not select the minted instance');
    console.log(`  [OK] generator selected minted instance ${MINTED_INSTANCE_ID} (batch=${selected.length})`);

    // ── Assertion 1b: post on-chain with the complexity-weighted escrow ──
    const escrowInputs = escrowInputsFromPatch(mintedTask.patch ?? '', FAIL_TO_PASS);
    const eligibility = {
      syntheticEscrow: true,
      syntheticProvenance: provenance,
      syntheticEscrowInputs: escrowInputs,
      syntheticEscrowParams: DEFAULT_SYNTHETIC_ESCROW_PARAMS,
    };
    const baseFlatRate = await getMechDeliveryRate(fixture.publicClient, v3Env.mockMechAddress as Address);

    const posted1 = await postMintedTask({
      fixture,
      mockIpfs,
      v3Env,
      creatorPrivKey: CREATOR_PRIV_KEY,
      creatorSafeAddress: operatorA.safeAddress,
      id: 'tc-marketplace-e2e-gold',
      description: `SWE-rebench v2 minted instance ${MINTED_INSTANCE_ID} (gold posting)`,
      eligibility,
    });
    assert(
      posted1.deliveryRate > baseFlatRate,
      `ASSERTION 1 FAILED: computed weighted rate ${posted1.deliveryRate} not > flat base rate ${baseFlatRate}`,
    );
    assert(
      posted1.onchainSolutionBudget === posted1.deliveryRate,
      `ASSERTION 1 FAILED: on-chain solutionBudget ${posted1.onchainSolutionBudget} != weighted deliveryRate ${posted1.deliveryRate}`,
    );
    assert(
      posted1.onchainSolutionBudget > baseFlatRate,
      `ASSERTION 1 FAILED: on-chain solutionBudget ${posted1.onchainSolutionBudget} not > flat base rate ${baseFlatRate}`,
    );
    console.log(
      `  [OK] posted taskId=${posted1.taskId} on-chain solutionBudget=${posted1.onchainSolutionBudget} ` +
      `(flat would have been ${baseFlatRate}) tx=${posted1.creationTxHash}`,
    );

    // ── Assertion 2: minter's claim attempt is refused ──
    console.log('\n--- Assertion 2: minter claim attempt refused (syntheticClaimBlocked) ---');
    const directBlockReason = syntheticClaimBlocked(provenance, operatorA.safeAddress);
    assert(
      !!directBlockReason && directBlockReason.toLowerCase().includes('minter'),
      `ASSERTION 2 FAILED: syntheticClaimBlocked did not block the minter — got ${String(directBlockReason)}`,
    );
    console.log(`  [OK] syntheticClaimBlocked(provenance, minterSafe) = "${directBlockReason}"`);

    let minterClaimed = false;
    try {
      await waitForDaemonClaim(fixture, posted1, operatorA, v3Env, 8_000);
      minterClaimed = true;
    } catch {
      // Expected: timeout — the live engine (engine.ts:1134) blocked the claim
      // attempt off-chain before any claimTask tx was ever sent.
    }
    assert(!minterClaimed, 'ASSERTION 2 FAILED: minter operator A actually claimed its own synthetic task on-chain');
    console.log('  [OK] operator A (minter) never issued a claimTask tx for its own minted task (8s live-daemon window)');

    // ── Assertion 3a + 4a: operator B claims + delivers GOLD; self-evaluates PASS ──
    console.log('\n--- Assertion 3+4 (posting 1/2, gold): claim, deliver, grade PASS ---');
    const claim1 = await waitForDaemonClaim(fixture, posted1, operatorB, v3Env);
    console.log(`  [OK] operator B claimed: requestId=${claim1.requestId} tx=${claim1.txHash}`);
    const delivered1 = await waitForDelivery(fixture, claim1, v3Env, mockIpfs);
    const solutionPayload1 = SweRebenchV2SolutionPayloadSchema.parse(delivered1.envelope.payload);
    assert(solutionPayload1.patch === GOLD_PATCH, 'ASSERTION 3 FAILED: delivered solution 1 did not carry the gold patch');
    console.log(`  [OK] operator B delivered the GOLD patch on-chain: tx=${delivered1.deliveryTxHash}`);

    const attemptIndex1 = await attemptIndexFromClaimTx(fixture, claim1.txHash);
    const verdict1 = await submitSelfEvaluation({
      fixture, v3Env, evaluator: operatorB, posted: posted1, attemptIndex: attemptIndex1, score: 1,
    });
    assert(verdict1.verdictCode === VerdictCode.Pass, `ASSERTION 4 FAILED: gold patch verdict was ${verdict1.verdictCode}, expected Pass`);
    console.log(`  [OK] gold patch graded PASS on-chain: tx=${verdict1.verdictTxHash}`);

    // ── Second posting: swap the fixture to the garbage patch, re-post the SAME minted instance ──
    console.log('\n--- Assertion 3+4 (posting 2/2, garbage): claim, deliver, grade FAIL ---');
    writeFileSync(join(stubFixturesDir, `${MINTED_INSTANCE_ID}.patch`), GARBAGE_PATCH);

    const posted2 = await postMintedTask({
      fixture,
      mockIpfs,
      v3Env,
      creatorPrivKey: CREATOR_PRIV_KEY,
      creatorSafeAddress: operatorA.safeAddress,
      id: 'tc-marketplace-e2e-garbage',
      description: `SWE-rebench v2 minted instance ${MINTED_INSTANCE_ID} (garbage posting)`,
      eligibility,
    });
    console.log(`  [OK] posted second taskId=${posted2.taskId} tx=${posted2.creationTxHash}`);

    const claim2 = await waitForDaemonClaim(fixture, posted2, operatorB, v3Env);
    console.log(`  [OK] operator B claimed: requestId=${claim2.requestId} tx=${claim2.txHash}`);
    const delivered2 = await waitForDelivery(fixture, claim2, v3Env, mockIpfs);
    const solutionPayload2 = SweRebenchV2SolutionPayloadSchema.parse(delivered2.envelope.payload);
    assert(solutionPayload2.patch === GARBAGE_PATCH, 'ASSERTION 3 FAILED: delivered solution 2 did not carry the garbage patch');
    console.log(`  [OK] operator B delivered the GARBAGE patch on-chain: tx=${delivered2.deliveryTxHash}`);

    const attemptIndex2 = await attemptIndexFromClaimTx(fixture, claim2.txHash);
    const verdict2 = await submitSelfEvaluation({
      fixture, v3Env, evaluator: operatorB, posted: posted2, attemptIndex: attemptIndex2, score: 0,
    });
    assert(verdict2.verdictCode === VerdictCode.Fail, `ASSERTION 4 FAILED: garbage patch verdict was ${verdict2.verdictCode}, expected Fail`);
    console.log(`  [OK] garbage patch graded FAIL on-chain: tx=${verdict2.verdictTxHash}`);

    // ── Assertion 5: exemplar-pair yield, attributed to the minted bucket ──
    console.log('\n--- Assertion 5: computeExemplarPairYield + minted-bucket attribution ---');
    // Derive passes/fails from the on-chain verdict codes of the two real
    // settlements (decoded from each VerdictDeliveryClaimed event) — NOT a
    // hand-typed literal. If the chain recorded anything other than one Pass
    // and one Fail, the exemplar-pair count below will not be 1 and the
    // assertion fails.
    const settledVerdictCodes = [verdict1.verdictCode, verdict2.verdictCode];
    const passes = settledVerdictCodes.filter((c) => c === VerdictCode.Pass).length;
    const fails = settledVerdictCodes.filter((c) => c === VerdictCode.Fail).length;
    console.log(
      `  on-chain verdict codes: [${settledVerdictCodes.join(', ')}] → passes=${passes} fails=${fails}`,
    );
    const stats: InstanceVerdictStats[] = [
      { instanceId: MINTED_INSTANCE_ID, passes, fails, synthetic: true },
    ];
    const yieldReport = computeExemplarPairYield(stats);
    assert(yieldReport.exemplarPairs === 1, `ASSERTION 5 FAILED: expected exactly 1 exemplar pair, got ${yieldReport.exemplarPairs}`);
    assert(
      yieldReport.byInstance.length === 1 && yieldReport.byInstance[0]!.instanceId === MINTED_INSTANCE_ID,
      'ASSERTION 5 FAILED: exemplar pair not attributed to the minted instance',
    );
    console.log(`  [OK] computeExemplarPairYield: exemplarPairs=${yieldReport.exemplarPairs} for ${MINTED_INSTANCE_ID}`);

    const metricReport = buildTaskCreatorMetricReport({
      minted: { trajectories: 2, costUsd: 1 },
      baseline: { trajectories: 0, costUsd: 1 },
      instanceStats: stats,
    });
    assert(
      metricReport.distillAdmissiblePerDollarMinted === 1,
      `ASSERTION 5 FAILED: minted bucket did not attribute the exemplar pair (got ${metricReport.distillAdmissiblePerDollarMinted})`,
    );
    assert(
      metricReport.distillAdmissiblePerDollarBaseline === 0,
      `ASSERTION 5 FAILED: exemplar pair leaked into the baseline bucket (got ${metricReport.distillAdmissiblePerDollarBaseline})`,
    );
    console.log(
      `  [OK] buildTaskCreatorMetricReport attributes the pair to minted ` +
      `(minted=${metricReport.distillAdmissiblePerDollarMinted}/$ baseline=${metricReport.distillAdmissiblePerDollarBaseline}/$)`,
    );

    console.log('\n=== task-creator-marketplace e2e — ALL 5 ASSERTIONS PASSED ===');
  } finally {
    await daemonA?.stop().catch(() => {});
    await daemonB?.stop().catch(() => {});
    await mockIpfs.close();
    await fixture.teardown();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
