import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { MECH_MARKETPLACE_ABI } from './types.js';
import { claimJob, getJobClaim } from './contracts.js';
import type { Store } from '../../store/store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RequestCandidate {
  requestId: string;
  requestDataHex: string;
  priorityMech: string;
}

/**
 * ClaimPolicy decides whether an operator should pick up a given request.
 *
 * Two-stage filtering:
 * - shouldAccept(): sync pre-filter on event data (no RPC)
 * - confirmClaim(): async check + claim attempt before runner starts work
 */
export interface ClaimPolicy {
  shouldAccept(candidate: RequestCandidate): boolean;
  confirmClaim(requestId: string): Promise<boolean>;
}

// ── Claim store interface (for SignedClaimPolicy) ────────────────────────────

export interface ClaimRecord {
  requestId: string;
  claimerMech: string;
  expiresAt: number;
  signature: string;
}

export interface ClaimStore {
  getClaim(requestId: string): Promise<ClaimRecord | null>;
  publishClaim(claim: ClaimRecord): Promise<void>;
}

// ── AcceptAllPolicy ──────────────────────────────────────────────────────────

export class AcceptAllPolicy implements ClaimPolicy {
  shouldAccept(_candidate: RequestCandidate): boolean {
    return true;
  }

  async confirmClaim(_requestId: string): Promise<boolean> {
    return true;
  }
}

// ── PriorityWindowPolicy ─────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export class PriorityWindowPolicy implements ClaimPolicy {
  constructor(
    private readonly ourMechAddress: Address,
    private readonly publicClient: PublicClient,
    private readonly marketplaceAddress: Address,
  ) {}

  shouldAccept(candidate: RequestCandidate): boolean {
    // Fast accept if we are the priority mech
    if (candidate.priorityMech.toLowerCase() === this.ourMechAddress.toLowerCase()) {
      return true;
    }
    // Let non-priority through — confirmClaim checks the window
    return true;
  }

  async confirmClaim(requestId: string): Promise<boolean> {
    const info = await this.publicClient.readContract({
      address: this.marketplaceAddress,
      abi: MECH_MARKETPLACE_ABI,
      functionName: 'mapRequestIdInfos',
      args: [requestId as Hex],
    }) as [string, string, string, bigint, bigint, string];

    const [priorityMech, deliveryMech, , responseTimeout] = info;

    // Already delivered — skip
    if (deliveryMech !== ZERO_ADDRESS) {
      return false;
    }

    // We are the priority mech — proceed
    if (priorityMech.toLowerCase() === this.ourMechAddress.toLowerCase()) {
      return true;
    }

    // Not our priority — only proceed if window expired
    const block = await this.publicClient.getBlock();
    return block.timestamp >= responseTimeout;
  }
}

// ── SignedClaimPolicy ────────────────────────────────────────────────────────

const CLAIM_DOMAIN = {
  name: 'JinnClaims',
  version: '1',
} as const;

const CLAIM_TYPES = {
  Claim: [
    { name: 'requestId', type: 'bytes32' },
    { name: 'claimerMech', type: 'address' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

export class SignedClaimPolicy implements ClaimPolicy {
  private readonly claimTTLSeconds: number;

  constructor(
    private readonly ourMechAddress: Address,
    private readonly publicClient: PublicClient,
    private readonly marketplaceAddress: Address,
    private readonly walletClient: WalletClient,
    private readonly claimStore: ClaimStore,
    claimTTLSeconds = 300,
  ) {
    this.claimTTLSeconds = claimTTLSeconds;
  }

  shouldAccept(candidate: RequestCandidate): boolean {
    // Same fast filter as PriorityWindowPolicy
    return true;
  }

  async confirmClaim(requestId: string): Promise<boolean> {
    // 1. Check delivery status
    const info = await this.publicClient.readContract({
      address: this.marketplaceAddress,
      abi: MECH_MARKETPLACE_ABI,
      functionName: 'mapRequestIdInfos',
      args: [requestId as Hex],
    }) as [string, string, string, bigint, bigint, string];

    const [priorityMech, deliveryMech, , responseTimeout] = info;

    if (deliveryMech !== ZERO_ADDRESS) {
      return false;
    }

    // 2. Check priority window
    const block = await this.publicClient.getBlock();
    if (priorityMech.toLowerCase() !== this.ourMechAddress.toLowerCase()) {
      if (block.timestamp < responseTimeout) {
        return false;
      }
    }

    // 3. Check existing claims
    const existingClaim = await this.claimStore.getClaim(requestId);
    if (existingClaim) {
      const now = Math.floor(Date.now() / 1000);
      if (existingClaim.claimerMech.toLowerCase() !== this.ourMechAddress.toLowerCase() && existingClaim.expiresAt > now) {
        return false; // Active claim from another operator
      }
    }

    // 4. Sign and publish our claim
    const expiresAt = Math.floor(Date.now() / 1000) + this.claimTTLSeconds;

    const [account] = await this.walletClient.getAddresses();
    const signature = await this.walletClient.signTypedData({
      account,
      domain: { ...CLAIM_DOMAIN, chainId: await this.publicClient.getChainId() },
      types: CLAIM_TYPES,
      primaryType: 'Claim',
      message: {
        requestId: requestId as Hex,
        claimerMech: this.ourMechAddress,
        expiresAt: BigInt(expiresAt),
      },
    });

    await this.claimStore.publishClaim({
      requestId,
      claimerMech: this.ourMechAddress,
      expiresAt,
      signature,
    });

    return true;
  }
}

// ── LocalClaimStore (SQLite-backed) ──────────────────────────────────────────

export class LocalClaimStore implements ClaimStore {
  constructor(private readonly store: Store) {}

  async getClaim(requestId: string): Promise<ClaimRecord | null> {
    return this.store.getActiveClaim(requestId);
  }

  async publishClaim(claim: ClaimRecord): Promise<void> {
    this.store.insertClaim(claim);
  }
}

// ── OnChainClaimPolicy ───────────────────────────────────────────────────────

export class OnChainClaimPolicy implements ClaimPolicy {
  constructor(
    private readonly ourMechAddress: Address,
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly safeAddress: Address,
    private readonly marketplaceAddress: Address,
    private readonly claimRegistryAddress: Address,
  ) {}

  shouldAccept(_candidate: RequestCandidate): boolean {
    return true;
  }

  async confirmClaim(requestId: string): Promise<boolean> {
    // 1. Check delivery status
    const info = await this.publicClient.readContract({
      address: this.marketplaceAddress,
      abi: MECH_MARKETPLACE_ABI,
      functionName: 'mapRequestIdInfos',
      args: [requestId as Hex],
    }) as [string, string, string, bigint, bigint, string];

    const [priorityMech, deliveryMech, , responseTimeout] = info;

    if (deliveryMech !== ZERO_ADDRESS) {
      return false; // Already delivered
    }

    // 2. Check priority window
    const block = await this.publicClient.getBlock();
    if (priorityMech.toLowerCase() !== this.ourMechAddress.toLowerCase()) {
      if (block.timestamp < responseTimeout) {
        return false; // Not our priority window yet
      }
    }

    // 3. Check existing on-chain claim
    const { claimer, expiresAt } = await getJobClaim(
      this.publicClient,
      this.claimRegistryAddress,
      requestId as Hex,
    );

    if (claimer !== ZERO_ADDRESS && expiresAt > 0n) {
      // Active claim exists
      if (claimer.toLowerCase() === this.safeAddress.toLowerCase()) {
        return true; // We already claimed — idempotent
      }
      return false; // Someone else has an active claim
    }

    // 4. Claim on-chain via Safe tx
    const txHash = await claimJob(
      this.publicClient,
      this.walletClient,
      this.safeAddress,
      this.claimRegistryAddress,
      requestId as Hex,
    );

    return txHash !== ''; // Empty string = claim failed (already claimed or ineligible)
  }
}
