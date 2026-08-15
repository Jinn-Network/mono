// operator/test/e2e/_jinn-repo-loop-helpers.ts
//
// Helpers specific to the jinn-repo.v1 on-chain loop driver. Mirrors
// `postPredictionV1Task` from `_daemon-harness-helpers.ts` but builds a
// jinn-repo.v1 task whose spec is the leak-controlled solverView of a pool
// item. Reuses the existing wait helpers (waitForDaemonClaim / waitForDelivery
// / waitForVerdict) unchanged — those are solverType-agnostic (they scan the
// V3 router / mock mech events by taskId + operator, not by spec shape).

import {
  keccak256,
  parseEther,
  toBytes,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  solverView,
  type JinnRepoPoolItem,
} from '../../src/solver-types/_jinn-repo-pool.js';
import type { JinnRepoLiveIssueTask } from '../../src/solver-types/jinn-repo.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';
import { getMechDeliveryRate, getTimeoutBounds } from '../../src/adapters/mech/contracts.js';
import { JINN_ROUTER_ABI } from '../../src/adapters/mech/types.js';
import { writeContractTx, decodeFirstEvent } from './task-first-helpers.js';
import type {
  BootstrappedOperator,
  DaemonHarnessFixture,
  MockIpfsServer,
  PostedPredictionTask,
  TaskV3Env,
} from './_daemon-harness-helpers.js';

/**
 * Build, sign, and register a `jinn-repo.v1` task with the mock IPFS server,
 * then post it on the locally-deployed V3 JinnRouter.
 *
 * Identical on-chain mechanics to `postPredictionV1Task` (the wait helpers are
 * shared and solverType-agnostic). The only domain differences:
 *   - solverType = 'jinn-repo.v1'
 *   - spec = solverView(item) — leak-controlled (schemaVersion, instance_id,
 *     repo, base_commit, problem_statement only; no gold tests, no solution).
 *   - solverNetManifestCid = 'jinn-repo.v1';
 *     manifestDigest = keccak256(toBytes('jinn-repo.v1')).
 *   - disallowSolverSelfEvaluation defaults to false (single node solves AND
 *     self-evaluates — allowed).
 */
export async function postJinnRepoTask(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  creatorPrivKey: `0x${string}`,
  mockIpfs: MockIpfsServer,
  v3Env: TaskV3Env,
  item: JinnRepoPoolItem,
  opts: { disallowSolverSelfEvaluation?: boolean } = {},
): Promise<PostedPredictionTask> {
  const rpcUrl = fixture.anvil.rpcUrl;
  const routerAddress = v3Env.routerAddress;
  const marketplaceAddress = v3Env.mockMarketplaceAddress;

  const creator = privateKeyToAccount(creatorPrivKey);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  // ── Step 1: Build the signed task document ────────────────────────────────
  // SignedTaskV1 shape: schemaVersion, id, solverType, solverNetManifestCid,
  // contractId, contractVersion, role, description, window, spec, eligibility,
  // claimPolicy, creator, createdAt, signature.
  const MANIFEST_CID = 'jinn-repo.v1'; // legacy string form, mirrors prediction.v1
  const view = solverView(item);
  const unsignedTaskDoc = {
    schemaVersion: 'task.v1' as const,
    id: `jinn-repo-loop-${item.instance_id}`,
    solverType: 'jinn-repo.v1',
    solverNetManifestCid: MANIFEST_CID,
    contractId: 'jinn-repo',
    contractVersion: 'v1',
    role: 'restoration' as const,
    description: item.problem_statement.split('\n')[0] ?? item.problem_statement,
    window: {
      startTs: now - 5_000,
      endTs: now + 3_600_000,
    },
    // Leak-controlled solver view: never the gold tests, never the solution.
    spec: view,
    eligibility: {},
    claimPolicy: {
      mode: 'parallel' as const,
      maxClaims: 10,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 3600,
      claimWindowStartTs: nowSec - 5,
      claimWindowEndTs: nowSec + 3_600,
      submissionDeadlineTs: nowSec + 7_200,
    },
    creator: {
      safeAddress: operator.safeAddress as `0x${string}`,
      agentEoa: operator.agentAddress as `0x${string}`,
    },
    createdAt: now,
  };

  const signed = await signCanonical(unsignedTaskDoc, creatorPrivKey, creator.address);
  const signedTaskDoc = {
    ...unsignedTaskDoc,
    signature: {
      algo: 'secp256k1' as const,
      signer: creator.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  };

  // ── Step 2: Compute on-chain digest and register with mock IPFS ────────────
  const taskJson = JSON.stringify(signedTaskDoc);
  const taskCidDigest = keccak256(toBytes(taskJson)) as `0x${string}`;
  mockIpfs.register(taskCidDigest, signedTaskDoc);

  // ── Step 3: Compute manifestDigest ────────────────────────────────────────
  const manifestDigest = keccak256(toBytes(MANIFEST_CID)) as `0x${string}`;

  // ── Step 4: Delivery rate + timeout from the mock mech/marketplace ─────────
  const deliveryRate = await getMechDeliveryRate(
    fixture.publicClient,
    v3Env.mockMechAddress as Address,
  );
  const timeoutBounds = await getTimeoutBounds(fixture.publicClient, marketplaceAddress);
  const responseTimeout = timeoutBounds.min > 0n ? timeoutBounds.min : 3600n;

  // ── Step 5: On-chain task policy ───────────────────────────────────────────
  // Tokenless-OLAS pivot: the on-chain TaskCoordinator.TaskPolicy is now just
  // `maxClaims`. Windows / lease / quorum / self-eval gating no longer cross the
  // wire; that off-chain scheduling intent stays on the signed task.v1
  // `claimPolicy` field. (`opts.disallowSolverSelfEvaluation` is moot — the
  // coordinator rejects self-evaluation unconditionally now.)
  void opts.disallowSolverSelfEvaluation;
  const onchainPolicy = { maxClaims: 10 };

  // ── Step 6: Post task on-chain via the locally-deployed V3 JinnRouter ──────
  // Trimmed createTask escrows rate*maxClaims per side (solution + verdict); no
  // requiredVerdicts multiplier.
  const MAX_CLAIMS = 10n;
  const rateArg = deliveryRate > 0n ? deliveryRate : parseEther('0.0001');
  const solutionBudget = rateArg * MAX_CLAIMS;
  const verdictBudget = rateArg * MAX_CLAIMS;
  const value = solutionBudget + verdictBudget;

  const created = await writeContractTx({
    publicClient: fixture.publicClient,
    rpcUrl,
    account: creator,
    address: routerAddress,
    abi: JINN_ROUTER_ABI,
    functionName: 'createTask',
    args: [taskCidDigest, manifestDigest, onchainPolicy, rateArg, rateArg, responseTimeout],
    value,
  });

  const taskCreated = decodeFirstEvent(created.receipt, JINN_ROUTER_ABI, 'TaskCreated');
  const taskId = BigInt(String(taskCreated['taskId']));
  const createdAtBlock = BigInt(created.receipt.blockNumber ?? 0n);

  return { taskId, taskCidDigest, manifestDigest, createdAtBlock };
}

/**
 * Live-issue variant of {@link postJinnRepoTask} (issue #1891). Identical
 * on-chain mechanics — the only domain difference is `spec`: a live-issue
 * task has no gold to leak-protect, so the FULL `JinnRepoLiveIssueTask` is
 * posted directly as `spec` rather than a `solverView()` projection of a
 * pool item (there is no separate pool item for live-issue tasks — see
 * `_jinn-repo-pool.ts`'s module doc).
 */
export async function postJinnRepoLiveTask(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  creatorPrivKey: `0x${string}`,
  mockIpfs: MockIpfsServer,
  v3Env: TaskV3Env,
  liveTask: JinnRepoLiveIssueTask,
): Promise<PostedPredictionTask> {
  const rpcUrl = fixture.anvil.rpcUrl;
  const routerAddress = v3Env.routerAddress;
  const marketplaceAddress = v3Env.mockMarketplaceAddress;

  const creator = privateKeyToAccount(creatorPrivKey);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  const MANIFEST_CID = 'jinn-repo.v1';
  const unsignedTaskDoc = {
    schemaVersion: 'task.v1' as const,
    id: `jinn-repo-live-loop-${liveTask.instance_id}`,
    solverType: 'jinn-repo.v1',
    solverNetManifestCid: MANIFEST_CID,
    contractId: 'jinn-repo',
    contractVersion: 'v1',
    role: 'restoration' as const,
    description: liveTask.problem_statement.split('\n')[0] ?? liveTask.problem_statement,
    window: {
      startTs: now - 5_000,
      endTs: now + 3_600_000,
    },
    // No leak-control needed — nothing gold-oracle exists for a live-issue
    // task. This IS what canAttempt/run expect the evaluation task's spec to
    // parse as (see harness.ts's routing check).
    spec: liveTask,
    eligibility: {},
    claimPolicy: {
      mode: 'parallel' as const,
      maxClaims: 10,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 3600,
      claimWindowStartTs: nowSec - 5,
      claimWindowEndTs: nowSec + 3_600,
      submissionDeadlineTs: nowSec + 7_200,
    },
    creator: {
      safeAddress: operator.safeAddress as `0x${string}`,
      agentEoa: operator.agentAddress as `0x${string}`,
    },
    createdAt: now,
  };

  const signed = await signCanonical(unsignedTaskDoc, creatorPrivKey, creator.address);
  const signedTaskDoc = {
    ...unsignedTaskDoc,
    signature: {
      algo: 'secp256k1' as const,
      signer: creator.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  };

  const taskJson = JSON.stringify(signedTaskDoc);
  const taskCidDigest = keccak256(toBytes(taskJson)) as `0x${string}`;
  mockIpfs.register(taskCidDigest, signedTaskDoc);

  const manifestDigest = keccak256(toBytes(MANIFEST_CID)) as `0x${string}`;

  const deliveryRate = await getMechDeliveryRate(
    fixture.publicClient,
    v3Env.mockMechAddress as Address,
  );
  const timeoutBounds = await getTimeoutBounds(fixture.publicClient, marketplaceAddress);
  const responseTimeout = timeoutBounds.min > 0n ? timeoutBounds.min : 3600n;

  const onchainPolicy = { maxClaims: 10 };

  const MAX_CLAIMS = 10n;
  const rateArg = deliveryRate > 0n ? deliveryRate : parseEther('0.0001');
  const solutionBudget = rateArg * MAX_CLAIMS;
  const verdictBudget = rateArg * MAX_CLAIMS;
  const value = solutionBudget + verdictBudget;

  const created = await writeContractTx({
    publicClient: fixture.publicClient,
    rpcUrl,
    account: creator,
    address: routerAddress,
    abi: JINN_ROUTER_ABI,
    functionName: 'createTask',
    args: [taskCidDigest, manifestDigest, onchainPolicy, rateArg, rateArg, responseTimeout],
    value,
  });

  const taskCreated = decodeFirstEvent(created.receipt, JINN_ROUTER_ABI, 'TaskCreated');
  const taskId = BigInt(String(taskCreated['taskId']));
  const createdAtBlock = BigInt(created.receipt.blockNumber ?? 0n);

  return { taskId, taskCidDigest, manifestDigest, createdAtBlock };
}
