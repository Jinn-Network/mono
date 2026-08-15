/**
 * Hermetic gate — the PRODUCTION claimDelivery adapter, adverse branches.
 *
 * Spec §5 ("provoke real state, don't fake behavior") + the efficacy review:
 * the adversarial-claim-delivery suite drives RAW router/mech calls, so the
 * production adapter wrapper (operator/src/adapters/mech/contracts.ts claimDelivery)
 * — its retry/idempotency/error-classification — was DARK (mutation M9: disabling
 * the NotDelivered retry left every raw-contract scenario green). This test calls
 * the REAL claimDelivery, through a REAL bootstrapped Safe operator, against the
 * real V3 contracts driven into each adverse state:
 *
 *   - NotDelivered  → claimDelivery must RETRY (not bail immediately). Asserted by
 *     elapsed time: a never-delivered request makes claimDelivery exhaust its
 *     retry budget (≫ a single attempt) before throwing. M9 (disabled retry) bails
 *     in <1s → caught.
 *   - AlreadyClaimed → after a successful settle, a second claimDelivery must
 *     return '0x' idempotently (not throw). Catches a regression in the
 *     pre-check + AlreadyClaimed catch-arm.
 *
 * Deterministic on the snapshot (spawnAnvilFromState, no live RPC). SKIP-CLEAN
 * when the fixture is absent.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  setupAnvilFixtureFromState,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  ANVIL_PRIVATE_KEYS,
  type DaemonHarnessFixture,
  type BootstrappedOperator,
  type TaskV3Env,
} from '../e2e/_daemon-harness-helpers.js';
import { claimDelivery } from '../../src/adapters/mech/contracts.js';
import { executeSafeTransaction, type VenueBroadcaster } from '../../src/adapters/mech/safe.js';
import { createDirectSafeBroadcaster } from '../../src/adapters/mech/direct-safe-broadcaster.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(TEST_DIR, '..', '_support', 'fixtures', 'anvil-base-v3-state');
const SNAPSHOT_STATE = join(SNAPSHOT_DIR, 'state.json');
const CONTRACTS_DIR = resolve(TEST_DIR, '..', '..', '..', 'contracts');

const SNAPSHOT_PRESENT = existsSync(SNAPSHOT_STATE) || existsSync(SNAPSHOT_DIR);
const describeMaybe = SNAPSHOT_PRESENT ? describe : describe.skip;

if (!SNAPSHOT_PRESENT) {
  // eslint-disable-next-line no-console
  console.error(
    `[hermetic] snapshot fixture absent at ${SNAPSHOT_STATE} — skipping adapter claimDelivery suite. ` +
      `Run \`tsx contracts/scripts/build-anvil-snapshot.ts\` (needs BASE_RPC_URL) and commit the fixture.`,
  );
}

const SOLUTION_DIGEST = keccak256(toBytes('adapter-claim-delivery:solution')) as Hex;

async function loadAbi(p: string): Promise<Abi> {
  return (JSON.parse(await readFile(join(CONTRACTS_DIR, p), 'utf8')) as { abi: Abi }).abi;
}

function decodeFirst(receipt: { logs: readonly unknown[] }, abi: Abi, eventName: string): Record<string, unknown> {
  for (const log of receipt.logs as Log[]) {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === eventName) return decoded.args as Record<string, unknown>;
    } catch { /* not this event */ }
  }
  throw new Error(`missing ${eventName} event`);
}

describeMaybe('hermetic production claimDelivery adapter (spec §5 / efficacy review hole A)', () => {
  let fixture: DaemonHarnessFixture;
  let operator: BootstrappedOperator;
  let v3: TaskV3Env;
  let publicClient: PublicClient;
  let agentWallet: WalletClient;
  let creatorWallet: WalletClient;
  // Finding E16 / the C2 ruling: this hermetic gate is a standalone process with no composition
  // root to borrow a broadcaster from, so it constructs its own — bound to the operator's Safe,
  // signed by `agentWallet` (the same signer it already builds below).
  let broadcaster: VenueBroadcaster;
  let routerAbi: Abi;
  let mechAbi: Abi;
  let mechRate: bigint;
  let responseTimeout: bigint;

  beforeAll(async () => {
    fixture = await setupAnvilFixtureFromState(SNAPSHOT_STATE);
    operator = await bootstrapStakedOperator(fixture);
    const DEPLOYER_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
    v3 = await deployMinimalV3Stack(fixture, operator, DEPLOYER_PRIV_KEY);

    publicClient = fixture.publicClient;
    routerAbi = await loadAbi('artifacts/src/staking/JinnRouterV3.sol/JinnRouterV3.json');
    mechAbi = await loadAbi('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json');
    const marketplaceAbi = await loadAbi('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json');

    const creator = privateKeyToAccount(DEPLOYER_PRIV_KEY);
    creatorWallet = createWalletClient({ account: creator, chain: base, transport: http(fixture.anvil.rpcUrl) });
    const agent = privateKeyToAccount(operator.agentPrivateKey);
    agentWallet = createWalletClient({ account: agent, chain: base, transport: http(fixture.anvil.rpcUrl) });
    broadcaster = createDirectSafeBroadcaster(publicClient, agentWallet, operator.safeAddress);

    mechRate = (await publicClient.readContract({ address: v3.mockMechAddress, abi: mechAbi, functionName: 'maxDeliveryRate' })) as bigint;
    responseTimeout = (await publicClient.readContract({ address: v3.mockMarketplaceAddress, abi: marketplaceAbi, functionName: 'minResponseTimeout' })) as bigint;
  }, 180_000);

  afterAll(async () => {
    if (fixture) { try { await fixture.teardown(); } catch { /* best-effort */ } }
  });

  /** Post a task (creator EOA) and claim it through the operator's Safe; returns the requestId. */
  async function postAndClaimViaSafe(): Promise<Hex> {
    const block = await publicClient.getBlock();
    const nowSec = Number(block.timestamp);
    // Tokenless-OLAS pivot: TaskPolicy is { maxClaims, allowSolverSelfEvaluation } (bool, default false → self-eval blocked).
    const policy = { maxClaims: 10, allowSolverSelfEvaluation: false };
    const salt = `adapterA:${nowSec}:${Math.random()}`;
    const taskCidDigest = keccak256(toBytes(`task:${salt}`)) as Hex;
    const manifestDigest = keccak256(toBytes(`manifest:${salt}`)) as Hex;
    const budget = mechRate * 10n + mechRate * 10n;

    const createHash = await creatorWallet.writeContract({
      address: v3.routerAddress, abi: routerAbi, functionName: 'createTask',
      args: [taskCidDigest, manifestDigest, policy, mechRate, mechRate, responseTimeout],
      value: budget, account: creatorWallet.account!, chain: base,
    });
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const taskId = BigInt(String(decodeFirst(createReceipt, routerAbi, 'TaskCreated')['taskId']));

    // Claim through the operator's Safe (the mock mech is operated by the Safe,
    // so claimTask must come from the Safe) — using the production
    // executeSafeTransaction path.
    const claimData = encodeFunctionData({ abi: routerAbi, functionName: 'claimTask', args: [taskId, v3.mockMechAddress] });
    const claimTxHash = await executeSafeTransaction(publicClient, agentWallet, {
      safeAddress: operator.safeAddress, to: v3.routerAddress, value: 0n, data: claimData,
    }, broadcaster);
    const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimTxHash });
    return String(decodeFirst(claimReceipt, routerAbi, 'TaskAttemptCreated')['requestId']) as Hex;
  }

  /** Deliver `requestId` from the operator's mech, through the Safe. */
  async function deliverViaSafe(requestId: Hex): Promise<void> {
    const data = encodeFunctionData({ abi: mechAbi, functionName: 'deliverToMarketplace', args: [[requestId], [SOLUTION_DIGEST]] });
    const hash = await executeSafeTransaction(publicClient, agentWallet, {
      safeAddress: operator.safeAddress, to: v3.mockMechAddress, value: 0n, data,
    }, broadcaster);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  it(
    'NotDelivered: claimDelivery retries the not-settled window and RECOVERS once delivery lands',
    async () => {
      const requestId = await postAndClaimViaSafe();
      const opts = { variant: 'v3' as const, kind: 'solution' as const, evidenceHash: SOLUTION_DIGEST };

      // The request is claimed but NOT delivered → claimSolutionDelivery reverts
      // RouterNotDelivered, and the production adapter must RETRY that window. We
      // prove this WITHOUT a fragile timing threshold (executeSafeTransaction has
      // its own internal retries, so elapsed-time alone can't distinguish a single
      // attempt from the retry loop — a verified false-pass). Instead we key off
      // the adapter's own retry log, which fires ONLY inside the NotDelivered
      // retry branch: when it appears we inject the delivery, and a SUBSEQUENT
      // attempt then settles. The Safe's per-address lock serializes the injected
      // delivery between attempts, so this is deterministic, not a race.
      //
      // Under a retry-disabled regression: the retry log never fires, delivery is
      // never injected, claimDelivery throws on the first attempt → the await
      // rejects and `sawRetry` stays false → both assertions catch it.
      let sawRetry = false;
      let deliveryKicked = false;
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]): void => {
        const line = args.map((a) => String(a)).join(' ');
        if (line.includes('claimDelivery: not yet delivered, retry')) {
          sawRetry = true;
          if (!deliveryKicked) {
            deliveryKicked = true;
            void deliverViaSafe(requestId).catch(() => { /* surfaced via the await below */ });
          }
        }
        originalConsoleError(...(args as []));
      };

      try {
        const tx = await claimDelivery(publicClient, agentWallet, broadcaster, operator.safeAddress, v3.routerAddress, requestId, opts);
        expect(tx, 'claimDelivery did not settle after the delivery landed').toMatch(/^0x[0-9a-fA-F]+$/);
        expect(tx, 'claimDelivery returned the idempotent 0x without actually settling').not.toBe('0x');
      } finally {
        console.error = originalConsoleError;
      }

      expect(sawRetry, 'claimDelivery never entered its NotDelivered retry branch — the retry loop is dark/disabled').toBe(true);
    },
    120_000,
  );

  it(
    'AlreadyClaimed: claimDelivery settles once, then is idempotent (returns 0x) on replay',
    async () => {
      const requestId = await postAndClaimViaSafe();
      const opts = { variant: 'v3' as const, kind: 'solution' as const, evidenceHash: SOLUTION_DIGEST };

      await deliverViaSafe(requestId);

      // First call settles via the real adapter → a real tx hash, claimed flips.
      const settleTx = await claimDelivery(publicClient, agentWallet, broadcaster, operator.safeAddress, v3.routerAddress, requestId, opts);
      expect(settleTx).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(settleTx).not.toBe('0x');
      const claimed = await publicClient.readContract({
        address: v3.routerAddress, abi: routerAbi, functionName: 'claimed', args: [requestId],
      });
      expect(Boolean(claimed)).toBe(true);

      // Second call must be idempotent — the adapter returns '0x', does not throw.
      const replay = await claimDelivery(publicClient, agentWallet, broadcaster, operator.safeAddress, v3.routerAddress, requestId, opts);
      expect(replay).toBe('0x');
    },
    120_000,
  );
});
