/**
 * MockMessenger submission path for the cross-chain JINN claim loop.
 *
 * Used when `jinnMessengerMode === 'mock'` — primarily for testnet burn-in
 * (Phase D / r5z) when canonical OP-Stack finality is impractical and CI.
 * The daemon's wallet must be the MockMessenger's owner during burn-in;
 * `setFixture` is `onlyOwner`.
 *
 * Flow:
 *   1. Read the latest ClaimTicket event from the TaskClaimEmitter on L2.
 *   2. Plant the matching fixture on the L1 MockMessenger via `setFixture`.
 *   3. Submit `JinnDistributor.claim(abi.encode(claimId))`.
 *
 * The MockMessenger encodes the proof as `abi.encode(uint256 claimId)` —
 * the messenger looks up the planted snapshot fixture and returns it. The
 * distributor's per-service accumulator handles replay; resubmitting the
 * same `proof` mints zero on the second call.
 */

import {
  decodeEventLog,
  encodeAbiParameters,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  CLAIM_TICKET_TOPIC0,
  JINN_CLAIM_EMITTER_ABI,
  JINN_DISTRIBUTOR_ABI,
  MOCK_MESSENGER_ABI,
} from '../earning/contracts.js';

export interface MockClaimSnapshot {
  claimId: bigint;
  serviceId: bigint;
  taskCreationWeight: bigint;
  solutionDeliveryWeight: bigint;
  verdictDeliveryWeight: bigint;
  multisig: Address;
  claimer: Address;
  /** L2 transaction hash of the emitClaim. */
  emitTxHash: Hex;
  /** L2 block number containing emitClaim. */
  emitBlockNumber: bigint;
}

/**
 * Read the latest ClaimTicket emitted by `claimEmitter` for the given
 * `serviceId`, optionally bounded to a recent block range. Returns null when
 * no matching event exists.
 */
export async function fetchLatestClaimTicket(
  l2Client: PublicClient,
  claimEmitter: Address,
  serviceId: bigint,
  options: { fromBlock?: bigint; toBlock?: bigint | 'latest' } = {},
): Promise<MockClaimSnapshot | null> {
  const fromBlock = options.fromBlock ?? 0n;
  const toBlock = options.toBlock ?? 'latest';

  const logs = await l2Client.getLogs({
    address: claimEmitter,
    event: JINN_CLAIM_EMITTER_ABI[0],
    args: { serviceId },
    fromBlock,
    toBlock,
  });

  if (logs.length === 0) return null;

  // Sort by blockNumber, logIndex; the last one is the latest.
  logs.sort((a, b) => {
    const aBn = a.blockNumber ?? 0n;
    const bBn = b.blockNumber ?? 0n;
    if (aBn === bBn) return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    return aBn < bBn ? -1 : 1;
  });
  const latest = logs[logs.length - 1] as Log;

  const decoded = decodeEventLog({
    abi: JINN_CLAIM_EMITTER_ABI,
    data: latest.data,
    topics: latest.topics,
    eventName: 'ClaimTicket',
  });
  const args = decoded.args as unknown as {
    claimId: bigint;
    serviceId: bigint;
    taskCreationWeight: bigint;
    solutionDeliveryWeight: bigint;
    verdictDeliveryWeight: bigint;
    multisig: Address;
    claimer: Address;
  };

  return {
    claimId: args.claimId,
    serviceId: args.serviceId,
    taskCreationWeight: args.taskCreationWeight,
    solutionDeliveryWeight: args.solutionDeliveryWeight,
    verdictDeliveryWeight: args.verdictDeliveryWeight,
    multisig: args.multisig,
    claimer: args.claimer,
    emitTxHash: latest.transactionHash ?? ('0x' as Hex),
    emitBlockNumber: latest.blockNumber ?? 0n,
  };
}

/**
 * Plant a fixture on the L1 MockMessenger that mirrors the L2 ClaimTicket
 * snapshot exactly. The daemon's L1 wallet must be the MockMessenger's
 * owner. Returns the L1 tx hash.
 */
export async function plantMockFixture(
  l1Client: PublicClient,
  l1Wallet: WalletClient,
  messenger: Address,
  snapshot: MockClaimSnapshot,
): Promise<Hex> {
  const account = l1Wallet.account;
  if (!account) throw new Error('L1 wallet has no account configured');

  const { request } = await l1Client.simulateContract({
    address: messenger,
    abi: MOCK_MESSENGER_ABI,
    functionName: 'setFixture',
    args: [
      snapshot.claimId,
      {
        serviceId: snapshot.serviceId,
        taskCreationWeight: snapshot.taskCreationWeight,
        solutionDeliveryWeight: snapshot.solutionDeliveryWeight,
        verdictDeliveryWeight: snapshot.verdictDeliveryWeight,
        multisig: snapshot.multisig,
      },
    ],
    account,
  });
  return l1Wallet.writeContract(request);
}

/**
 * Encode the MockMessenger proof: `abi.encode(uint256 claimId)`. The
 * messenger looks up the previously planted fixture by claimId.
 */
export function encodeMockProof(claimId: bigint): Hex {
  return encodeAbiParameters([{ type: 'uint256' }], [claimId]);
}

/**
 * Submit `JinnDistributor.claim(proof)` on L1. Returns the L1 tx hash.
 *
 * Idempotent at the contract layer — the distributor's per-service
 * accumulator clamps repeated submissions to zero mint.
 */
export async function submitMockClaim(
  l1Client: PublicClient,
  l1Wallet: WalletClient,
  distributor: Address,
  claimId: bigint,
): Promise<Hex> {
  const account = l1Wallet.account;
  if (!account) throw new Error('L1 wallet has no account configured');

  const proof = encodeMockProof(claimId);
  const { request } = await l1Client.simulateContract({
    address: distributor,
    abi: JINN_DISTRIBUTOR_ABI,
    functionName: 'claim',
    args: [proof],
    account,
  });
  return l1Wallet.writeContract(request);
}

// Re-export for tests that want to assert on the topic0 directly.
export { CLAIM_TICKET_TOPIC0 };
