/**
 * ClaimRegistryClient — typed wrapper for the ClaimRegistry contract.
 *
 * Wraps the read/write surfaces of ClaimRegistry with proper types and
 * idiomatic async interfaces.
 *
 * Write operations (claimJob, releaseClaim) go through the Safe multisig via
 * executeSafeTransaction. This is required so that the on-chain claimer address
 * matches the Safe — our canonical OLAS/staking identity. Using the raw EOA
 * would cause a mismatch: OnChainClaimPolicy already claims through the Safe,
 * so `weAlreadyClaimed()` would return false even when the Safe holds the claim,
 * triggering a redundant on-chain write that reverts as JobAlreadyClaimed.
 *
 * expireClaim() is permissionless (anyone can GC others' expired claims) and
 * is kept as a direct EOA call — the gas payer does not affect claim ownership.
 */

import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { CLAIM_REGISTRY_ABI } from './abi.js';
import { executeSafeTransaction } from '../mech/safe.js';
import { SafeInnerRevertError } from '../mech/safe-revert.js';
import { waitForTransactionReceiptWithRetry } from '../../tx-retry.js';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JobClaimInfo {
  claimer: Address;
  /** Unix timestamp (seconds) when the claim expires. 0 if no active claim. */
  expiresAt: bigint;
  /** True if claimer !== ZERO_ADDRESS and expiresAt > 0 (claim is still active per contract). */
  isActive: boolean;
}

export interface ClaimJobResult {
  /** Transaction hash. Empty string when skipped (already ours or failed). */
  txHash: string;
  /** True if we now hold the claim (new or pre-existing). */
  claimed: boolean;
  /**
   * Set when claimed=false. Disambiguates between:
   *  - 'lost-race': another operator holds the claim (decoded from JobAlreadyClaimed)
   *  - 'ineligible': eligibility checker rejected
   *  - 'reverted':   tx reverted for an unknown reason
   */
  reason?: 'lost-race' | 'ineligible' | 'reverted';
  /** When reason='lost-race', the address that won the race (if recoverable). */
  competitor?: Address;
}

// ── ClaimRegistryClient ───────────────────────────────────────────────────────

export class ClaimRegistryClient {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly contractAddress: Address,
    /**
     * The Safe multisig address — used as the canonical claimer identity.
     * claimJob/releaseClaim are routed through Safe so that msg.sender on-chain
     * is the Safe address, matching the OLAS staking identity.
     */
    private readonly safeAddress: Address,
  ) {}

  // ── Read methods ─────────────────────────────────────────────────────────────

  /**
   * Read the active claim for a request.
   * Returns `(ZERO_ADDRESS, 0, false)` if no active claim (contract returns
   * (address(0), 0) for expired/non-existent claims).
   */
  async getJobClaim(requestId: Hex): Promise<JobClaimInfo> {
    const result = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: CLAIM_REGISTRY_ABI,
      functionName: 'getJobClaim',
      args: [requestId],
    }) as [Address, bigint];

    const claimer = result[0];
    const expiresAt = result[1];
    return {
      claimer,
      expiresAt,
      isActive: claimer !== ZERO_ADDRESS && expiresAt > 0n,
    };
  }

  /**
   * Check whether the Safe already holds an active claim for this request.
   * Used for idempotency on resume.
   */
  async weAlreadyClaimed(requestId: Hex): Promise<boolean> {
    const info = await this.getJobClaim(requestId);
    return (
      info.isActive &&
      info.claimer.toLowerCase() === this.safeAddress.toLowerCase()
    );
  }

  // ── Write methods ─────────────────────────────────────────────────────────────

  /**
   * Claim a marketplace request through the Safe multisig.
   *
   * Idempotent: if the Safe already holds an active claim, returns
   * `{ txHash: '', claimed: true }` without submitting a transaction.
   *
   * Returns `{ txHash: '', claimed: false }` when:
   *   - Another address holds an active claim
   *   - The eligibility check fails (IneligibleToClaim)
   *   - The tx reverts for any other handled reason
   *
   * Throws on unrecognised RPC errors.
   */
  async claimJob(requestId: Hex): Promise<ClaimJobResult> {
    // Idempotency: already claimed by our Safe
    const existing = await this.getJobClaim(requestId);
    if (existing.isActive) {
      if (existing.claimer.toLowerCase() === this.safeAddress.toLowerCase()) {
        return { txHash: '', claimed: true };
      }
      // Someone else has an active claim
      return { txHash: '', claimed: false, reason: 'lost-race', competitor: existing.claimer };
    }

    const data = encodeFunctionData({
      abi: CLAIM_REGISTRY_ABI,
      functionName: 'claimJob',
      args: [requestId],
    });

    try {
      const txHash = await executeSafeTransaction(this.publicClient, this.walletClient, {
        safeAddress: this.safeAddress,
        to: this.contractAddress,
        value: 0n,
        data,
      });

      // executeSafeTransaction waits for the receipt internally, but does not
      // inspect its status. Wait again with full retry and throw if reverted so
      // callers don't see a false-positive claimed=true on a reverted claim.
      const receipt = await waitForTransactionReceiptWithRetry(
        this.publicClient,
        txHash as `0x${string}`,
        {
          onRetry: ({ attempt, message }) => {
            console.error(`[claim-registry] wait claimJob receipt retry ${attempt}: ${message}`);
          },
        },
      );
      if (receipt.status !== 'success') {
        throw new Error(`claimJob transaction reverted (status=${receipt.status}, txHash=${txHash})`);
      }

      return { txHash, claimed: true };
    } catch (err) {
      // Decoded inner revert from Safe's GS013 wrapper — the actual on-chain
      // failure cause is now legible.
      if (err instanceof SafeInnerRevertError) {
        if (err.decodedName === 'JobAlreadyClaimed') {
          const competitor = err.decodedArgs?.[1] as Address | undefined;
          // RPC eventual-consistency case: a prior attempt's tx mined but
          // the daemon retried (e.g. waitForTransactionReceipt timed out),
          // and the retry's gas-estimate reverts because the Safe already
          // holds the claim. Treat as success.
          if (competitor && competitor.toLowerCase() === this.safeAddress.toLowerCase()) {
            return { txHash: '', claimed: true };
          }
          return { txHash: '', claimed: false, reason: 'lost-race', competitor };
        }
        if (err.decodedName === 'IneligibleToClaim') {
          return { txHash: '', claimed: false, reason: 'ineligible' };
        }
        return { txHash: '', claimed: false, reason: 'reverted' };
      }
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('JobAlreadyClaimed') ||
        message.includes('IneligibleToClaim') ||
        message.includes('execution reverted')
      ) {
        return { txHash: '', claimed: false, reason: 'reverted' };
      }
      throw err;
    }
  }

  /**
   * Voluntarily release a claim through the Safe multisig (no punishment).
   * Should only be called when the Safe holds the claim.
   * No-op (returns false) if the Safe doesn't hold the claim.
   */
  async releaseClaim(requestId: Hex): Promise<boolean> {
    // Verify the Safe holds the claim before sending a tx that would revert
    const existing = await this.getJobClaim(requestId);
    if (
      !existing.isActive ||
      existing.claimer.toLowerCase() !== this.safeAddress.toLowerCase()
    ) {
      return false;
    }

    const data = encodeFunctionData({
      abi: CLAIM_REGISTRY_ABI,
      functionName: 'releaseClaim',
      args: [requestId],
    });

    try {
      await executeSafeTransaction(this.publicClient, this.walletClient, {
        safeAddress: this.safeAddress,
        to: this.contractAddress,
        value: 0n,
        data,
      });

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // NotClaimOwner or NoClaimExists — claim was already gone
      if (message.includes('NotClaimOwner') || message.includes('NoClaimExists')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Garbage-collect a stale (expired) claim.
   *
   * expireClaim is permissionless — anyone can call it to GC others' expired
   * claims. The caller gets no reward; the previous claimer gets an
   * expiredClaimCount increment. Since the gas payer doesn't affect claim
   * ownership, this is sent directly from the EOA (cheaper than a Safe tx).
   */
  async expireClaim(requestId: Hex): Promise<boolean> {
    const account = this.walletClient.account;
    if (!account) throw new Error('[ClaimRegistryClient] walletClient has no account');

    const data = encodeFunctionData({
      abi: CLAIM_REGISTRY_ABI,
      functionName: 'expireClaim',
      args: [requestId],
    });

    try {
      const txHash = await this.walletClient.sendTransaction({
        account,
        chain: null,
        to: this.contractAddress,
        data,
        value: 0n,
      });

      await waitForTransactionReceiptWithRetry(this.publicClient, txHash as Hex, {
        onRetry: ({ attempt, message }) => {
          console.error(`[claim-registry] wait expireClaim receipt retry ${attempt}: ${message}`);
        },
      });

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('NoClaimExists') || message.includes('ClaimNotExpired')) {
        return false;
      }
      throw err;
    }
  }
}
