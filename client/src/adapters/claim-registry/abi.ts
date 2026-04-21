/**
 * Typed ABI fragments for ClaimRegistry.
 *
 * Mirrors the Solidity interface in contracts/src/claiming/ClaimRegistry.sol.
 * Use these instead of the inline fragment in adapters/mech/types.ts when
 * constructing a ClaimRegistryClient — they include the full event set.
 */

export const CLAIM_REGISTRY_ABI = [
  // ── Write functions ──────────────────────────────────────────────────────────

  {
    name: 'claimJob',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'releaseClaim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'expireClaim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [],
  },

  // ── Read functions ───────────────────────────────────────────────────────────

  {
    name: 'getJobClaim',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [
      { name: 'claimer', type: 'address' },
      { name: 'expiresAt', type: 'uint256' },
    ],
  },
  {
    name: 'claims',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'claimer', type: 'address' },
      { name: 'expiresAt', type: 'uint256' },
    ],
  },
  {
    name: 'claimTTL',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'expiredClaimCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },

  // ── Events ───────────────────────────────────────────────────────────────────

  {
    name: 'JobClaimed',
    type: 'event',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'claimer', type: 'address', indexed: true },
      { name: 'expiresAt', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'ClaimExpired',
    type: 'event',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'previousClaimer', type: 'address', indexed: true },
    ],
  },
  {
    name: 'ClaimReleased',
    type: 'event',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'claimer', type: 'address', indexed: true },
    ],
  },
] as const;

export type ClaimRegistryAbi = typeof CLAIM_REGISTRY_ABI;
