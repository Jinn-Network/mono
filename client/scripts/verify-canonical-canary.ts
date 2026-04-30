#!/usr/bin/env tsx
/**
 * Verifier-only canonical canary (Phase D): build the OP-Stack storage proof for an
 * existing Base Sepolia `JinnClaimEmitter` ClaimTicket tx after dispute-game finality,
 * then `eth_call` `CanonicalOpStackMessenger.verifyClaim(proof)` on Sepolia.
 *
 * Does not submit `JinnDistributor.claim` — active testnet burn-in should keep
 * MockMessenger on the distributor per cross-chain spec / R-1.
 *
 * Required env:
 *   JINN_L2_TX_HASH          — L2 tx hash that emitted ClaimTicket (0x…)
 *   JINN_CLAIM_EMITTER       — deployed JinnClaimEmitter on Base Sepolia
 *   JINN_CANONICAL_MESSENGER — deployed CanonicalOpStackMessenger on Sepolia
 *
 * Optional env:
 *   JINN_CLAIM_TICKET_LOG_INDEX — decimal log index if multiple ClaimTicket logs (default: auto-pick first match)
 *   JINN_L1_RPC_URL / SEPOLIA_RPC_URL — Sepolia RPC (defaults publicnode)
 *   JINN_L2_RPC_URL / BASE_SEPOLIA_RPC_URL — Base Sepolia RPC for receipts/blocks
 *   JINN_L2_PROOF_RPC_URL — archive-capable RPC for historical eth_getProof at dispute-game block (often required)
 *   JINN_OPTIMISM_PORTAL — Sepolia OptimismPortal2 (defaults viem chain metadata)
 *   JINN_DISPUTE_GAME_FACTORY — Sepolia DisputeGameFactory (defaults viem chain metadata)
 *
 * RPC failures (routing, archive gaps): historical eth_getProof can fail on public endpoints;
 * retry with JINN_L2_PROOF_RPC_URL pointed at Tenderly / Alchemy / other archive-capable URLs.
 */

import 'dotenv/config';
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from 'viem';
import { baseSepolia, sepolia } from 'viem/chains';
import {
  buildCanonicalProof,
  decodeClaimTicketFromReceipt,
  verifyCanonicalClaimCanary,
} from '../src/daemon/jinn-claim-loop-canonical.js';
import { CLAIM_TICKET_TOPIC0 } from '../src/earning/contracts.js';
import { redactRpcUrls } from '../src/util/redact-rpc-urls.js';

function requireHexTx(hash: string | undefined): Hex {
  if (!hash?.startsWith('0x') || hash.length !== 66) {
    throw new Error('Set JINN_L2_TX_HASH to a 32-byte hex tx hash (0x…)');
  }
  return hash as Hex;
}

async function run(): Promise<void> {
  const l2TxHash = requireHexTx(process.env.JINN_L2_TX_HASH);
  const claimEmitter = process.env.JINN_CLAIM_EMITTER
    ? getAddress(process.env.JINN_CLAIM_EMITTER)
    : null;
  const messenger = process.env.JINN_CANONICAL_MESSENGER
    ? getAddress(process.env.JINN_CANONICAL_MESSENGER)
    : null;

  if (!claimEmitter || !messenger) {
    throw new Error('Set JINN_CLAIM_EMITTER and JINN_CANONICAL_MESSENGER');
  }

  const l1Rpc =
    process.env.JINN_L1_RPC_URL ??
    process.env.SEPOLIA_RPC_URL ??
    'https://ethereum-sepolia.publicnode.com';
  const l2Rpc =
    process.env.JINN_L2_RPC_URL ??
    process.env.BASE_SEPOLIA_RPC_URL ??
    'https://sepolia.base.org';
  const l2ProofRpc = process.env.JINN_L2_PROOF_RPC_URL;

  const optimismPortal =
    (process.env.JINN_OPTIMISM_PORTAL
      ? getAddress(process.env.JINN_OPTIMISM_PORTAL)
      : baseSepolia.contracts.portal?.[sepolia.id]?.address) ?? null;
  const disputeGameFactory =
    (process.env.JINN_DISPUTE_GAME_FACTORY
      ? getAddress(process.env.JINN_DISPUTE_GAME_FACTORY)
      : baseSepolia.contracts.disputeGameFactory?.[sepolia.id]?.address) ?? null;

  if (!optimismPortal || !disputeGameFactory) {
    throw new Error(
      'Missing OptimismPortal / DisputeGameFactory — set JINN_OPTIMISM_PORTAL and JINN_DISPUTE_GAME_FACTORY',
    );
  }

  const l1Client = createPublicClient({ chain: sepolia, transport: http(l1Rpc) });
  const l2Client = createPublicClient({ chain: baseSepolia, transport: http(l2Rpc) });
  const l2ProofClient = l2ProofRpc
    ? createPublicClient({ chain: baseSepolia, transport: http(l2ProofRpc) })
    : undefined;

  const expectedTopic = CLAIM_TICKET_TOPIC0.toLowerCase();
  const emitterLc = claimEmitter.toLowerCase();

  const receipt = await l2Client.getTransactionReceipt({ hash: l2TxHash });
  const claimLogs = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === emitterLc
      && log.topics[0]?.toLowerCase() === expectedTopic,
  );
  if (claimLogs.length === 0) {
    throw new Error(
      `[verify-canonical-canary] No ClaimTicket log from ${claimEmitter} in tx ${l2TxHash}`,
    );
  }

  let claimLog = claimLogs[0];
  const idxEnv = process.env.JINN_CLAIM_TICKET_LOG_INDEX;
  if (idxEnv !== undefined && idxEnv !== '') {
    const want = Number(idxEnv);
    const found = claimLogs.find((l) => (l.logIndex ?? 0) === want);
    if (!found) {
      throw new Error(
        `[verify-canonical-canary] No ClaimTicket at log index ${want}; found ${claimLogs.length} ClaimTicket logs`,
      );
    }
    claimLog = found;
  }

  const l2LogIndex = claimLog.logIndex ?? 0;
  const l2BlockNumber = receipt.blockNumber;

  const snapshot = decodeClaimTicketFromReceipt(receipt.logs, claimEmitter, l2LogIndex);
  const buildResult = await buildCanonicalProof(
    {
      l1Client,
      l2ProofClient: l2ProofClient ?? l2Client,
      targetChain: baseSepolia,
      optimismPortal,
      disputeGameFactory,
      claimEmitter,
    },
    { snapshot, l2BlockNumber },
  );

  const verified = await verifyCanonicalClaimCanary(
    l1Client,
    messenger,
    buildResult.proof,
  );

  const out = {
    ok: true,
    l2TxHash,
    claimId: buildResult.snapshot.claimId.toString(),
    serviceId: buildResult.snapshot.serviceId.toString(),
    multisig: buildResult.snapshot.multisig,
    messengerVerifyClaim: {
      serviceId: verified.serviceId.toString(),
      verifiedCreations: verified.verifiedCreations.toString(),
      noveltyWeightedRestorationDeliveries:
        verified.noveltyWeightedRestorationDeliveries.toString(),
      evaluationDeliveryCount: verified.evaluationDeliveryCount.toString(),
      multisig: verified.multisig,
    },
    disputeGameIndex: buildResult.game.index.toString(),
    proofBlockNumber: buildResult.proofBlockNumber.toString(),
  };
  console.log(JSON.stringify(out, null, 2));
}

run().catch((err: unknown) => {
  console.error('[verify-canonical-canary]', redactRpcUrls(err));
  process.exit(1);
});
