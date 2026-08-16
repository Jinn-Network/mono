/**
 * Hermetic gate — adversarial claim/delivery conditions on REAL bytecode.
 *
 * Spec: docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md
 * §5 ("Fidelity strategy — provoke real state, don't fake behavior"). The
 * production `claimDelivery` path (`operator/src/adapters/mech/contracts.ts`)
 * handles a rich set of marketplace conditions — `AlreadyClaimed`, the "not
 * yet delivered, retry" window, deadline-expired refusal, claim contention,
 * idempotent re-delivery — and the audit found NONE of these branches are
 * exercised end-to-end, and most can't be reliably produced on a single-
 * operator real testnet either (no contention; deliveries land before you
 * poll; you don't blow the deadline on purpose).
 *
 * So we drive the REAL V3 contracts (JinnRouterV3 + TaskCoordinator +
 * MockTaskMarketplace + MockTaskMechWithDelivery, all loaded from the committed
 * Anvil snapshot) into each adversarial state rather than hand-coding fake
 * reverts. A mock that is subtly wrong is worse than no test; here every revert
 * is the contract's own.
 *
 * Snapshot (spec §4): built offline by `contracts/scripts/build-anvil-snapshot.ts`,
 * loaded via `spawnAnvilFromState` (the Step-1a helper) — deterministic, no live
 * RPC. The snapshot seeds a deterministic deployer EOA (key 0x..01) that
 * deployed the V3 stack and a mock mech whose `operator` is the operator EOA
 * (key 0x..02). We read the deployed router/mech addresses from the build's
 * addresses.json manifest (the forked deployer's nonce is its real Base nonce,
 * so CREATE addresses are not derivable from a low nonce), then read the
 * marketplace/coordinator/activity-checker off the router itself.
 *
 * SKIP-CLEAN: if the committed fixture is absent (it is large + human-generated;
 * see SHARED CONVENTIONS), the whole suite skips with a clear pointer to
 * `build-anvil-snapshot.ts` rather than failing — the gate workflow asserts the
 * fixture's presence separately and fails loud there.
 *
 * Coverage (spec §5 table):
 *   - AlreadyDelivered          deliver once + claim once, claim again → real revert
 *   - "not yet delivered" retry don't deliver → real getRequestStatus / RouterNotDelivered
 *   - deadline expired          evm_increaseTime past the deadline → the contract's own check
 *   - claim contention          a second EOA claims first → real contention path
 *   - idempotent re-delivery     replay the real deliver tx → real idempotency branch
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  numberToHex,
  parseEther,
  toBytes,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  spawnAnvilFromState,
  jsonRpc as anvilJsonRpc,
  type AnvilHarness,
} from '../_support/chain/anvil.js';
import { canClaimTask } from '../../src/adapters/mech/contracts.js';
import { formatKnownRevert, formatKnownRevertDetail } from '../../src/adapters/mech/safe-revert.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(TEST_DIR, '..', '..', '..', 'contracts');

/** Committed snapshot fixture — same path build-anvil-snapshot.ts writes. */
const SNAPSHOT_DIR = resolve(
  TEST_DIR,
  '..',
  '_support',
  'fixtures',
  'anvil-base-v3-state',
);
const SNAPSHOT_STATE = join(SNAPSHOT_DIR, 'state.json');
const SNAPSHOT_ADDRESSES = join(SNAPSHOT_DIR, 'addresses.json');

/** Deterministic EOAs the snapshot builder seeded (build-anvil-snapshot.ts). */
const DEPLOYER_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;
const OPERATOR_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000002' as Hex;
/** A throwaway EOA we fund on the loaded state to drive the claim-contention path. */
const CONTENDER_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000003' as Hex;

// build-anvil-snapshot.ts writes the deployed addresses to addresses.json next
// to state.json. The deployer EOA is a FORKED account whose nonce is its real
// Base nonce (NOT 0), so deploy CREATE addresses are NOT derivable from a low
// nonce — read them from the manifest. The router still exposes
// mechMarketplace()/taskCoordinator(), so we read those off-chain from it.

const NATIVE_PAYMENT_TYPE =
  '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1' as Hex;

const SNAPSHOT_PRESENT = existsSync(SNAPSHOT_STATE) || existsSync(SNAPSHOT_DIR);
const describeMaybe = SNAPSHOT_PRESENT ? describe : describe.skip;

if (!SNAPSHOT_PRESENT) {
  // eslint-disable-next-line no-console
  console.error(
    `[hermetic] snapshot fixture absent at ${SNAPSHOT_STATE} — skipping adversarial ` +
      `claim/delivery suite. Run \`tsx contracts/scripts/build-anvil-snapshot.ts\` ` +
      `(needs BASE_RPC_URL) and commit the fixture to exercise these scenarios.`,
  );
}

async function loadArtifact(pathFromContracts: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const raw = JSON.parse(
    await readFile(join(CONTRACTS_DIR, pathFromContracts), 'utf8'),
  ) as { abi: Abi; bytecode: Hex };
  return { abi: raw.abi, bytecode: raw.bytecode };
}

interface Artifacts {
  router: { abi: Abi; bytecode: Hex };
  marketplace: { abi: Abi; bytecode: Hex };
  mech: { abi: Abi; bytecode: Hex };
}

interface Ctx {
  anvil: AnvilHarness;
  publicClient: PublicClient;
  deployer: PrivateKeyAccount;
  operator: PrivateKeyAccount;
  contender: PrivateKeyAccount;
  routerAddress: Address;
  marketplaceAddress: Address;
  mockMechAddress: Address;
  /** A second mock mech whose operator is the contender EOA — for real contention. */
  contenderMechAddress: Address;
  mechRate: bigint;
  responseTimeout: bigint;
  artifacts: Artifacts;
}

describeMaybe('hermetic adversarial claim/delivery (real bytecode, snapshot)', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    const artifacts: Artifacts = {
      router: await loadArtifact('artifacts/src/staking/JinnRouterV3.sol/JinnRouterV3.json'),
      marketplace: await loadArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json'),
      mech: await loadArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json'),
    };

    const anvil = await spawnAnvilFromState({ statePath: SNAPSHOT_STATE });
    const publicClient = createPublicClient({
      chain: base,
      transport: http(anvil.rpcUrl),
    }) as unknown as PublicClient;

    const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    const operator = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
    const contender = privateKeyToAccount(CONTENDER_PRIVATE_KEY);

    const manifest = JSON.parse(await readFile(SNAPSHOT_ADDRESSES, 'utf8')) as {
      router: Address;
      mockMech: Address;
    };
    const routerAddress = manifest.router;
    const mockMechAddress = manifest.mockMech;

    // Read the marketplace off the real router so we don't depend on a fixture
    // manifest, and assert the snapshot is wired the way we expect.
    const marketplaceAddress = (await publicClient.readContract({
      address: routerAddress,
      abi: artifacts.router.abi,
      functionName: 'mechMarketplace',
    })) as Address;
    expect(marketplaceAddress).not.toBe(zeroAddress);

    const operatorIsMechOperator = (await publicClient.readContract({
      address: mockMechAddress,
      abi: artifacts.mech.abi,
      functionName: 'isOperator',
      args: [operator.address],
    })) as boolean;
    expect(operatorIsMechOperator).toBe(true);

    const mechRate = (await publicClient.readContract({
      address: mockMechAddress,
      abi: artifacts.mech.abi,
      functionName: 'maxDeliveryRate',
    })) as bigint;
    expect(mechRate).toBeGreaterThan(0n);

    // Fund the contender EOA on the loaded state and deploy a second mock mech
    // it operates, so the claim-contention scenario is a real two-operator race
    // (the snapshot ships a single operator EOA + mech).
    await anvilJsonRpc(anvil.rpcUrl, 'anvil_setBalance', [
      contender.address,
      numberToHex(parseEther('100')),
    ]);
    const contenderWallet = createWalletClient({ account: contender, chain: base, transport: http(anvil.rpcUrl) });
    const deployHash = await contenderWallet.deployContract({
      abi: artifacts.mech.abi,
      bytecode: artifacts.mech.bytecode,
      args: [mechRate, NATIVE_PAYMENT_TYPE, contender.address, marketplaceAddress],
      account: contender,
      chain: base,
    });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    if (!deployReceipt.contractAddress) throw new Error('contender mech deploy returned no address');
    const contenderMechAddress = deployReceipt.contractAddress as Address;

    const responseTimeout = (await publicClient.readContract({
      address: marketplaceAddress,
      abi: artifacts.marketplace.abi,
      functionName: 'minResponseTimeout',
    })) as bigint;

    ctx = {
      anvil,
      publicClient,
      deployer,
      operator,
      contender,
      routerAddress,
      marketplaceAddress,
      mockMechAddress,
      contenderMechAddress,
      mechRate,
      responseTimeout: responseTimeout > 0n ? responseTimeout : 3600n,
      artifacts,
    };
  }, 60_000);

  afterAll(async () => {
    if (ctx?.anvil) await ctx.anvil.teardown();
  });

  // ── Local on-chain drivers (the operator EOA == mock-mech operator) ──────────

  /** Write a tx from `account` and wait for a successful receipt. */
  async function send(
    account: PrivateKeyAccount,
    address: Address,
    artifact: { abi: Abi },
    functionName: string,
    args: readonly unknown[],
    value = 0n,
  ): Promise<Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>> {
    const client = createWalletClient({ account, chain: base, transport: http(ctx.anvil.rpcUrl) });
    const hash = await client.writeContract({ address, abi: artifact.abi, functionName, args, value, account, chain: base });
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`tx reverted: ${functionName} (${hash})`);
    return receipt;
  }

  function decodeFirst(
    receipt: { logs: readonly unknown[] },
    artifact: { abi: Abi },
    eventName: string,
  ): Record<string, unknown> {
    for (const log of receipt.logs as Log[]) {
      try {
        const decoded = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics });
        if (decoded.eventName === eventName) return decoded.args as Record<string, unknown>;
      } catch {
        // not this event
      }
    }
    throw new Error(`missing ${eventName} event`);
  }

  /**
   * Post a fresh task with a controllable claim window, claim it from `claimant`
   * (whose mech is `claimantMech`), and return the requestId + taskId + window
   * bounds. Each scenario gets its own task so state never leaks between tests.
   */
  async function postAndClaim(opts: {
    claimant: PrivateKeyAccount;
    claimantMech: Address;
    /** Seconds the claim window stays open from `now`. Default 300. */
    claimWindowSeconds?: number;
    /** Seconds until the submission deadline from `now`. Default 900. */
    submissionDeadlineSeconds?: number;
    /** maxClaimsPerOperator on the task policy. Default 1 (drives contention). */
    maxClaimsPerOperator?: number;
  }): Promise<{ taskId: bigint; requestId: Hex }> {
    const { router } = ctx.artifacts;
    const block = await ctx.publicClient.getBlock();
    const nowSec = Number(block.timestamp);
    // Tokenless-OLAS pivot: claim windows / submission deadlines / per-operator
    // caps are gone on-chain. These knobs are retained on the opts type for the
    // scenarios that still reference them, but no longer cross the wire.
    void opts.claimWindowSeconds;
    void opts.submissionDeadlineSeconds;
    void opts.maxClaimsPerOperator;

    // Tokenless-OLAS pivot: TaskPolicy is { maxClaims, allowSolverSelfEvaluation } (bool, default false → self-eval blocked).
    const policy = { maxClaims: 10, allowSolverSelfEvaluation: false };

    // Unique digest per task so requestIds never collide across scenarios.
    const salt = `${nowSec}:${Math.random()}`;
    const taskCidDigest = keccak256(toBytes(`task:${salt}`)) as Hex;
    const manifestDigest = keccak256(toBytes(`manifest:${salt}`)) as Hex;

    // Trimmed createTask escrows rate*maxClaims per side (no requiredVerdicts).
    const MAX_CLAIMS = 10n;
    const solutionBudget = ctx.mechRate * MAX_CLAIMS;
    const verdictBudget = ctx.mechRate * MAX_CLAIMS;

    const created = await send(
      ctx.operator,
      ctx.routerAddress,
      router,
      'createTask',
      [taskCidDigest, manifestDigest, policy, ctx.mechRate, ctx.mechRate, ctx.responseTimeout],
      solutionBudget + verdictBudget,
    );
    const taskId = BigInt(String(decodeFirst(created, router, 'TaskCreated')['taskId']));

    const claimed = await send(
      opts.claimant,
      ctx.routerAddress,
      router,
      'claimTask',
      [taskId, opts.claimantMech],
    );
    // The claim only succeeds if the claimant operates `claimantMech` — the
    // router's _validateMechOperator would have reverted otherwise.
    const requestId = String(decodeFirst(claimed, router, 'TaskAttemptCreated')['requestId']) as Hex;
    return { taskId, requestId };
  }

  /** Deliver `requestId` from `mechOperator`'s mech to the marketplace; returns the receipt. */
  async function deliver(
    mech: Address,
    mechOperator: PrivateKeyAccount,
    requestId: Hex,
    digest: Hex,
  ): Promise<Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>> {
    return send(mechOperator, mech, ctx.artifacts.mech, 'deliverToMarketplace', [[requestId], [digest]]);
  }

  async function isClaimed(requestId: Hex): Promise<boolean> {
    return Boolean(
      await ctx.publicClient.readContract({
        address: ctx.routerAddress,
        abi: ctx.artifacts.router.abi,
        functionName: 'claimed',
        args: [requestId],
      }),
    );
  }

  async function requestStatus(requestId: Hex): Promise<number> {
    return Number(
      await ctx.publicClient.readContract({
        address: ctx.marketplaceAddress,
        abi: ctx.artifacts.marketplace.abi,
        functionName: 'getRequestStatus',
        args: [requestId],
      }),
    );
  }

  /**
   * Expect a write to revert; return the decoded revert name for assertion.
   *
   * The raw viem error only carries a decoded name when the call's ABI includes
   * the error fragment — true for router errors (in the router artifact) but NOT
   * for coordinator errors (`TC*`) that bubble through the router. So we run the
   * caught error through the production selector-table decoder
   * (`formatKnownRevert`, the same one `canClaimTask`/the mech adapter use), which
   * recovers the name from the revert data regardless of ABI. Falls back to the
   * raw message when no known selector is extractable.
   */
  async function expectRevert(action: () => Promise<unknown>): Promise<{ message: string; name: string | null }> {
    try {
      await action();
    } catch (err) {
      const known = formatKnownRevert(err);
      const raw = err instanceof Error ? err.message : String(err);
      // `name` is the PRODUCTION decoder's output (safe-revert.ts KNOWN_INNER_ERRORS
      // selector→name map) — distinct from the raw router-ABI string. Asserting on
      // it verifies the decoder's name mapping, so a KNOWN_INNER_ERRORS name/selector
      // regression is caught here (not only by abi-selector-conformance).
      return {
        message: known ? `${known} | ${raw}` : raw,
        name: formatKnownRevertDetail(err)?.name ?? null,
      };
    }
    throw new Error('expected the contract call to revert, but it succeeded');
  }

  const SOLUTION_DIGEST = keccak256(toBytes('solution-digest')) as Hex;

  // ── Scenarios ────────────────────────────────────────────────────────────────

  it('AlreadyDelivered: a second claimSolutionDelivery reverts RouterAlreadyClaimed', async () => {
    const { requestId } = await postAndClaim({ claimant: ctx.operator, claimantMech: ctx.mockMechAddress });
    await deliver(ctx.mockMechAddress, ctx.operator, requestId, SOLUTION_DIGEST);

    // First claim settles — claimed flips true.
    await send(ctx.operator, ctx.routerAddress, ctx.artifacts.router, 'claimSolutionDelivery', [requestId, SOLUTION_DIGEST]);
    expect(await isClaimed(requestId)).toBe(true);

    // Second claim hits the real RouterAlreadyClaimed guard.
    const { message, name } = await expectRevert(() =>
      send(ctx.operator, ctx.routerAddress, ctx.artifacts.router, 'claimSolutionDelivery', [requestId, SOLUTION_DIGEST]),
    );
    expect(message).toMatch(/RouterAlreadyClaimed/);
    // The production decoder must map the real selector to the right name.
    expect(name).toBe('RouterAlreadyClaimed');
    expect(await isClaimed(requestId)).toBe(true);
  }, 60_000);

  it('"not yet delivered": claimSolutionDelivery before delivery reverts RouterNotDelivered', async () => {
    const { requestId } = await postAndClaim({ claimant: ctx.operator, claimantMech: ctx.mockMechAddress });

    // No deliverToMarketplace yet → the marketplace request is RequestedPriority,
    // not Delivered → the real _requireDelivered fires. This is exactly the
    // branch the production claimDelivery helper retries on (NotDelivered).
    expect(await requestStatus(requestId)).not.toBe(3 /* Delivered */);
    const { message, name } = await expectRevert(() =>
      send(ctx.operator, ctx.routerAddress, ctx.artifacts.router, 'claimSolutionDelivery', [requestId, SOLUTION_DIGEST]),
    );
    expect(message).toMatch(/RouterNotDelivered/);
    expect(name).toBe('RouterNotDelivered');
    expect(await isClaimed(requestId)).toBe(false);

    // Deliver, then the same call succeeds — proving the retry window closes
    // cleanly once the marketplace settles.
    await deliver(ctx.mockMechAddress, ctx.operator, requestId, SOLUTION_DIGEST);
    expect(await requestStatus(requestId)).toBe(3 /* Delivered */);
    await send(ctx.operator, ctx.routerAddress, ctx.artifacts.router, 'claimSolutionDelivery', [requestId, SOLUTION_DIGEST]);
    expect(await isClaimed(requestId)).toBe(true);
  }, 60_000);

  // Tokenless-OLAS pivot: claim windows / submission deadlines were removed from
  // TaskCoordinator — a task now stays claimable until its maxClaims slots fill,
  // and the TCClaimWindowClosed / TCSubmissionDeadlinePassed errors no longer
  // exist. This scenario asserted the deleted window behavior; skip it pending a
  // re-scope to whatever (if anything) replaces deadline-based unclaimability.
  it.skip('deadline expired: claimTask is unclaimable after evm_increaseTime past the window', async () => {
    // Post a task with a short claim window; do NOT claim it. The production
    // canClaimTask() (a real simulateContract against the router) must report
    // the task unclaimable once the coordinator's own claim-window check fails.
    const { router } = ctx.artifacts;
    const block = await ctx.publicClient.getBlock();
    const nowSec = Number(block.timestamp);
    const policy = { maxClaims: 10, allowSolverSelfEvaluation: false };
    const salt = `deadline:${nowSec}:${Math.random()}`;
    const taskCidDigest = keccak256(toBytes(salt)) as Hex;
    const manifestDigest = keccak256(toBytes(`m:${salt}`)) as Hex;
    const budget = ctx.mechRate * 10n + ctx.mechRate * 10n;
    const created = await send(
      ctx.operator, ctx.routerAddress, router, 'createTask',
      [taskCidDigest, manifestDigest, policy, ctx.mechRate, ctx.mechRate, ctx.responseTimeout],
      budget,
    );
    const taskId = BigInt(String(decodeFirst(created, router, 'TaskCreated')['taskId']));

    // Before expiry the production canClaimTask sees it as claimable.
    const beforeExpiry = await canClaimTask(
      ctx.publicClient,
      ctx.operator.address as Address,
      ctx.routerAddress,
      taskId,
      ctx.mockMechAddress,
    );
    expect(beforeExpiry.ok).toBe(true);

    // Advance the controlled clock past the claim window (better than a fork —
    // a fork can't move the clock; spec §4).
    await ctx.anvil.advanceTime(120);

    const afterExpiry = await canClaimTask(
      ctx.publicClient,
      ctx.operator.address as Address,
      ctx.routerAddress,
      taskId,
      ctx.mockMechAddress,
    );
    expect(afterExpiry.ok).toBe(false);
    if (!afterExpiry.ok) {
      expect(afterExpiry.reason).toMatch(/TCClaimWindowClosed|TCSubmissionDeadlinePassed/);
    }
  }, 60_000);

  // Tokenless-OLAS pivot: the per-operator claim cap (maxClaimsPerOperator) and
  // its TCOperatorClaimLimitReached guard were removed from TaskCoordinator — an
  // operator may now consume multiple of a task's maxClaims slots. This scenario
  // asserted the deleted per-operator contention guard; skip it pending a
  // re-scope of multi-claim contention under the trimmed policy.
  it.skip('claim contention: a second EOA claims the same slot; the first is rejected at the per-operator limit', async () => {
    // maxClaimsPerOperator = 1: the contender claims one slot via its own mech,
    // then a second claim from the SAME operator hits the real coordinator
    // contention guard (TCOperatorClaimLimitReached) — the real two-operator
    // race you can't reliably stage on a single-operator testnet.
    const { taskId } = await postAndClaim({
      claimant: ctx.contender,
      claimantMech: ctx.contenderMechAddress,
      maxClaimsPerOperator: 1,
    });

    // The operator EOA can still claim — distinct operator, distinct slot.
    await send(ctx.operator, ctx.routerAddress, ctx.artifacts.router, 'claimTask', [taskId, ctx.mockMechAddress]);

    // The contender re-claiming the same task exceeds its per-operator limit.
    const { message, name } = await expectRevert(() =>
      send(ctx.contender, ctx.routerAddress, ctx.artifacts.router, 'claimTask', [taskId, ctx.contenderMechAddress]),
    );
    expect(message).toMatch(/TCOperatorClaimLimitReached/);
    // A TaskCoordinator error that bubbles through the router (not in the router
    // ABI) — only the production selector-table decoder recovers the name.
    expect(name).toBe('TCOperatorClaimLimitReached');
  }, 60_000);

  it('idempotent re-delivery: replaying deliverToMarketplace keeps the request Delivered and the claim final', async () => {
    const { requestId } = await postAndClaim({ claimant: ctx.operator, claimantMech: ctx.mockMechAddress });

    // First delivery + settle.
    await deliver(ctx.mockMechAddress, ctx.operator, requestId, SOLUTION_DIGEST);
    await send(ctx.operator, ctx.routerAddress, ctx.artifacts.router, 'claimSolutionDelivery', [requestId, SOLUTION_DIGEST]);
    expect(await requestStatus(requestId)).toBe(3 /* Delivered */);
    expect(await isClaimed(requestId)).toBe(true);

    // Crash-replay: re-run the real deliver tx (the mock mech re-emits Deliver
    // and re-marks the marketplace Delivered — the idempotency boundary the
    // production callDeliverToMarketplace treats as success). Assert the replay
    // ACTUALLY executed (emitted Deliver) — a no-op re-delivery would otherwise
    // let this scenario false-pass on the unchanged downstream state.
    const replayReceipt = await deliver(ctx.mockMechAddress, ctx.operator, requestId, SOLUTION_DIGEST);
    const replayEvent = decodeFirst(replayReceipt, ctx.artifacts.mech, 'Deliver');
    expect(String(replayEvent['requestId'])).toBe(requestId);
    expect(await requestStatus(requestId)).toBe(3 /* Delivered */);

    // And a re-settle still hits RouterAlreadyClaimed — the claim is final.
    const { message, name } = await expectRevert(() =>
      send(ctx.operator, ctx.routerAddress, ctx.artifacts.router, 'claimSolutionDelivery', [requestId, SOLUTION_DIGEST]),
    );
    expect(message).toMatch(/RouterAlreadyClaimed/);
    expect(name).toBe('RouterAlreadyClaimed');
    expect(await isClaimed(requestId)).toBe(true);
  }, 60_000);
});
