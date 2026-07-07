/**
 * Canonical OP-Stack storage proof construction for the cross-chain JINN claim
 * loop. Implements `jinnMessengerMode === 'canonical'`.
 *
 * The builder is intended for the verifier-only canary path during testnet
 * burn-in. Active burn-in still uses MockMessenger; this module constructs
 * the canonical proof blob so operators can call
 * `CanonicalOpStackMessenger.verifyClaim` via `eth_call` after finality.
 *
 * The proof blob uses the locked ABI:
 *
 *        (
 *          bytes32 disputeGameId,
 *          bytes outputRootProof,
 *          bytes[] accountProof,
 *          bytes[] storageProof,
 *          uint256 claimId,
 *          uint256 serviceId,
 *          uint256 taskCreationWeight,
 *          uint256 solutionDeliveryWeight,
 *          uint256 verdictDeliveryWeight,
 *          address multisig
 *        )
 *
 * The proof uses an account proof + storage proof for
 * `TaskClaimEmitter.claimSnapshotHashes[claimId]` against the finalized L2
 * state root. Events are discovery only; L1 canonical verification proves the
 * stored snapshot hash.
 *
 * Tracked follow-up: bd `jinn-mono-7x5` Phase B-canonical.
 */

import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { getProof } from 'viem/actions';
import { getGames } from 'viem/op-stack';
import {
  CLAIM_MESSENGER_ABI,
  CLAIM_TICKET_TOPIC0,
  JINN_CLAIM_EMITTER_ABI,
  JINN_DISTRIBUTOR_ABI,
} from '../earning/contracts.js';

export interface CanonicalProofInputs {
  /** Decoded ClaimTicket snapshot (use `decodeClaimTicketFromReceipt`). */
  snapshot: CanonicalClaimSnapshot;
  /** L2 block number containing the emit tx. */
  l2BlockNumber: bigint;
}

export interface OpStackTargetChain {
  contracts: {
    disputeGameFactory: Readonly<Record<number, { readonly address: Address }>>;
    portal: Readonly<Record<number, { readonly address: Address }>>;
  };
}

export interface CanonicalProofClients {
  l1Client: PublicClient;
  /**
   * L2 client used for `getBlock` + historical `eth_getProof` at the dispute
   * game's L2 block. Must be archive-capable.
   */
  l2ProofClient: PublicClient;
  /** OP Stack L2 target chain used by viem/op-stack game lookup. */
  targetChain: OpStackTargetChain;
  /** L1 OptimismPortal2 address. */
  optimismPortal: Address;
  /** L1 DisputeGameFactory address. */
  disputeGameFactory: Address;
  /** L2 TaskClaimEmitter address that emitted ClaimTicket. */
  claimEmitter: Address;
}

export interface CanonicalClaimSnapshot {
  claimId: bigint;
  serviceId: bigint;
  taskCreationWeight: bigint;
  solutionDeliveryWeight: bigint;
  verdictDeliveryWeight: bigint;
  multisig: Address;
  claimer: Address;
}

export interface CanonicalGameSelection {
  index: bigint;
  l2BlockNumber: bigint;
  proxy: Address;
  factoryGameType: number;
  proxyGameType: number;
  rootClaim: Hex;
}

export interface CanonicalProofBuildResult {
  proof: Hex;
  snapshot: CanonicalClaimSnapshot;
  game: CanonicalGameSelection;
  proofBlockNumber: bigint;
}

export const DISPUTE_GAME_FACTORY_ABI = parseAbi([
  'function gameAtIndex(uint256) view returns (uint32 gameType_, uint64 timestamp_, address proxy_)',
]);

export const DISPUTE_GAME_ABI = parseAbi([
  'function gameType() view returns (uint32)',
  'function status() view returns (uint8)',
  'function resolvedAt() view returns (uint64)',
  'function rootClaim() view returns (bytes32)',
  'function wasRespectedGameTypeWhenCreated() view returns (bool)',
]);

export const OPTIMISM_PORTAL_ABI = parseAbi([
  'function respectedGameType() view returns (uint32)',
  'function proofMaturityDelaySeconds() view returns (uint256)',
  'function disputeGameFinalityDelaySeconds() view returns (uint256)',
]);

const OUTPUT_ROOT_PROOF_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'version', type: 'bytes32' },
      { name: 'stateRoot', type: 'bytes32' },
      { name: 'messagePasserStorageRoot', type: 'bytes32' },
      { name: 'latestBlockHash', type: 'bytes32' },
    ],
  },
] as const;

const CANONICAL_PROOF_ABI = [
  { name: 'disputeGameId', type: 'bytes32' },
  { name: 'outputRootProof', type: 'bytes' },
  { name: 'accountProof', type: 'bytes[]' },
  { name: 'storageProof', type: 'bytes[]' },
  { name: 'claimId', type: 'uint256' },
  { name: 'serviceId', type: 'uint256' },
  { name: 'taskCreationWeight', type: 'uint256' },
  { name: 'solutionDeliveryWeight', type: 'uint256' },
  { name: 'verdictDeliveryWeight', type: 'uint256' },
  { name: 'multisig', type: 'address' },
] as const;

const GAME_STATUS_DEFENDER_WINS = 2;
const CLAIM_SNAPSHOT_HASHES_SLOT = 1n;
const OUTPUT_ROOT_VERSION = `0x${'0'.repeat(64)}` as const;
const L2_TO_L1_MESSAGE_PASSER = '0x4200000000000000000000000000000000000016' as const;

/**
 * Wait until the L2 emit transaction is finalized through the canonical
 * OP-Stack pipeline (DisputeGame resolved + finality airgap elapsed) and
 * construct the `bytes proof` blob accepted by CanonicalOpStackMessenger.
 *
 * This is deliberately one-shot: if no covering/resolved/finalized dispute
 * game exists yet, it throws and the daemon retries on a later tick.
 */
export async function buildCanonicalProof(
  clients: CanonicalProofClients,
  inputs: CanonicalProofInputs,
): Promise<CanonicalProofBuildResult> {
  const { snapshot, l2BlockNumber } = inputs;
  const game = await selectCoveringDisputeGame(clients, l2BlockNumber);
  await assertDisputeGameReady(clients, game);

  const snapshotSlot = claimSnapshotStorageSlot(snapshot.claimId);
  const [proofBlock, messagePasserProof, snapshotProof] = await Promise.all([
    clients.l2ProofClient.getBlock({ blockNumber: game.l2BlockNumber }),
    getProof(clients.l2ProofClient, {
      address: L2_TO_L1_MESSAGE_PASSER,
      storageKeys: [],
      blockNumber: game.l2BlockNumber,
    }),
    getProof(clients.l2ProofClient, {
      address: clients.claimEmitter,
      storageKeys: [snapshotSlot],
      blockNumber: game.l2BlockNumber,
    }),
  ]);
  if (!proofBlock.hash) throw new Error('[jinn-claim-loop] proof L2 block is missing hash');
  const storageProof = snapshotProof.storageProof[0]?.proof;
  if (!storageProof || storageProof.length === 0) {
    throw new Error('[jinn-claim-loop] missing storage proof for claimSnapshotHashes[claimId]');
  }

  const outputRootProof = encodeAbiParameters(OUTPUT_ROOT_PROOF_ABI, [{
    version: OUTPUT_ROOT_VERSION,
    stateRoot: proofBlock.stateRoot,
    messagePasserStorageRoot: messagePasserProof.storageHash,
    latestBlockHash: proofBlock.hash,
  }]);

  const proof = encodeAbiParameters(CANONICAL_PROOF_ABI, [
    toHex(game.index, { size: 32 }),
    outputRootProof,
    snapshotProof.accountProof,
    storageProof,
    snapshot.claimId,
    snapshot.serviceId,
    snapshot.taskCreationWeight,
    snapshot.solutionDeliveryWeight,
    snapshot.verdictDeliveryWeight,
    snapshot.multisig,
  ]);

  return {
    proof,
    snapshot,
    game,
    proofBlockNumber: game.l2BlockNumber,
  };
}

export function claimSnapshotStorageSlot(claimId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [claimId, CLAIM_SNAPSHOT_HASHES_SLOT],
    ),
  );
}

export function decodeClaimTicketFromReceipt(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex; logIndex?: number | null }[],
  claimEmitter: Address,
  logIndex: number,
): CanonicalClaimSnapshot {
  const expectedEmitter = claimEmitter.toLowerCase();
  const expectedTopic = CLAIM_TICKET_TOPIC0.toLowerCase();
  const log = logs.find((candidate) =>
    candidate.address.toLowerCase() === expectedEmitter
    && candidate.topics[0]?.toLowerCase() === expectedTopic
    && (candidate.logIndex ?? 0) === logIndex
  );
  if (!log) {
    throw new Error(`[jinn-claim-loop] no ClaimTicket log at index ${logIndex}`);
  }

  const decoded = decodeEventLog({
    abi: JINN_CLAIM_EMITTER_ABI,
    eventName: 'ClaimTicket',
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const args = decoded.args as unknown as CanonicalClaimSnapshot;
  return {
    claimId: args.claimId,
    serviceId: args.serviceId,
    taskCreationWeight: args.taskCreationWeight,
    solutionDeliveryWeight: args.solutionDeliveryWeight,
    verdictDeliveryWeight: args.verdictDeliveryWeight,
    multisig: getAddress(args.multisig),
    claimer: getAddress(args.claimer),
  };
}

export async function selectCoveringDisputeGame(
  clients: CanonicalProofClients,
  l2BlockNumber: bigint,
): Promise<CanonicalGameSelection> {
  const games = await getGames(clients.l1Client, {
    chain: null,
    targetChain: clients.targetChain,
    limit: 100,
  });
  const covering = games
    .filter((game) => game.l2BlockNumber >= l2BlockNumber)
    .sort((a, b) => (a.l2BlockNumber < b.l2BlockNumber ? -1 : 1))[0];
  if (!covering) {
    throw new Error(
      `[jinn-claim-loop] no OP dispute game covers L2 block ${l2BlockNumber}; retry later`,
    );
  }

  const [factoryGameType, , proxy] = await clients.l1Client.readContract({
    address: clients.disputeGameFactory,
    abi: DISPUTE_GAME_FACTORY_ABI,
    functionName: 'gameAtIndex',
    args: [covering.index],
  });
  if (proxy === '0x0000000000000000000000000000000000000000') {
    throw new Error(`[jinn-claim-loop] dispute game ${covering.index} has zero proxy`);
  }

  const [proxyGameType, rootClaim] = await Promise.all([
    clients.l1Client.readContract({
      address: proxy,
      abi: DISPUTE_GAME_ABI,
      functionName: 'gameType',
    }),
    clients.l1Client.readContract({
      address: proxy,
      abi: DISPUTE_GAME_ABI,
      functionName: 'rootClaim',
    }),
  ]);

  return {
    index: covering.index,
    l2BlockNumber: covering.l2BlockNumber,
    proxy,
    factoryGameType,
    proxyGameType,
    rootClaim,
  };
}

export async function assertDisputeGameReady(
  clients: CanonicalProofClients,
  game: CanonicalGameSelection,
): Promise<void> {
  if (game.factoryGameType !== game.proxyGameType) {
    throw new Error('[jinn-claim-loop] dispute game factory/proxy gameType mismatch');
  }

  const [
    respectedGameType,
    proofMaturityDelaySeconds,
    disputeGameFinalityDelaySeconds,
    status,
    resolvedAt,
    wasRespectedGameTypeWhenCreated,
    latestL1Block,
  ] = await Promise.all([
    clients.l1Client.readContract({
      address: clients.optimismPortal,
      abi: OPTIMISM_PORTAL_ABI,
      functionName: 'respectedGameType',
    }),
    clients.l1Client.readContract({
      address: clients.optimismPortal,
      abi: OPTIMISM_PORTAL_ABI,
      functionName: 'proofMaturityDelaySeconds',
    }),
    clients.l1Client.readContract({
      address: clients.optimismPortal,
      abi: OPTIMISM_PORTAL_ABI,
      functionName: 'disputeGameFinalityDelaySeconds',
    }),
    clients.l1Client.readContract({
      address: game.proxy,
      abi: DISPUTE_GAME_ABI,
      functionName: 'status',
    }),
    clients.l1Client.readContract({
      address: game.proxy,
      abi: DISPUTE_GAME_ABI,
      functionName: 'resolvedAt',
    }),
    clients.l1Client.readContract({
      address: game.proxy,
      abi: DISPUTE_GAME_ABI,
      functionName: 'wasRespectedGameTypeWhenCreated',
    }),
    clients.l1Client.getBlock({ blockTag: 'latest' }),
  ]);

  if (!wasRespectedGameTypeWhenCreated && game.proxyGameType !== respectedGameType) {
    throw new Error('[jinn-claim-loop] dispute game was not portal-respected when created');
  }
  if (status !== GAME_STATUS_DEFENDER_WINS) {
    throw new Error('[jinn-claim-loop] dispute game is not resolved DEFENDER_WINS');
  }

  const finalizedAt =
    BigInt(resolvedAt) +
    maxBigInt(BigInt(proofMaturityDelaySeconds), BigInt(disputeGameFinalityDelaySeconds));
  if (resolvedAt === 0n || latestL1Block.timestamp < finalizedAt) {
    throw new Error('[jinn-claim-loop] dispute game finality airgap has not elapsed');
  }
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Submit `JinnDistributor.claim(proof)` on L1 once a canonical proof has
 * been constructed. Mirrors the mock-mode submission path; idempotent at
 * the contract layer.
 */
export async function submitCanonicalClaim(
  l1Client: PublicClient,
  l1Wallet: WalletClient,
  distributor: Address,
  proof: Hex,
): Promise<Hex> {
  const account = l1Wallet.account;
  if (!account) throw new Error('[jinn-claim-loop] L1 wallet has no account configured');

  const { request } = await l1Client.simulateContract({
    address: distributor,
    abi: JINN_DISTRIBUTOR_ABI,
    functionName: 'claim',
    args: [proof],
    account,
  });
  return l1Wallet.writeContract(request);
}

/**
 * Verifier-only canonical canary. This intentionally uses `eth_call`
 * (`readContract`) against the messenger and does not submit
 * `JinnDistributor.claim`. Burn-in keeps MockMessenger active.
 */
export async function verifyCanonicalClaimCanary(
  l1Client: PublicClient,
  messenger: Address,
  proof: Hex,
): Promise<{
  serviceId: bigint;
  taskCreationWeight: bigint;
  solutionDeliveryWeight: bigint;
  verdictDeliveryWeight: bigint;
  multisig: Address;
}> {
  const [
    serviceId,
    taskCreationWeight,
    solutionDeliveryWeight,
    verdictDeliveryWeight,
    multisig,
  ] = await l1Client.readContract({
    address: messenger,
    abi: CLAIM_MESSENGER_ABI,
    functionName: 'verifyClaim',
    args: [proof],
  });
  return {
    serviceId,
    taskCreationWeight,
    solutionDeliveryWeight,
    verdictDeliveryWeight,
    multisig,
  };
}
