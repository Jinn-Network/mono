/**
 * evidence-simhash.ts — Compute SimHash of evidence checkpoints for anti-farming.
 *
 * SimHash produces a 256-bit fingerprint where similar inputs produce similar hashes
 * (low Hamming distance). The on-chain activity checker (RestorationActivityCheckerV2)
 * compares these hashes to detect farming — repeated submission of similar evidence.
 *
 * The algorithm:
 *   1. Extract string features from the evidence checkpoint
 *   2. Hash each feature to 256 bits via keccak256
 *   3. For each bit position, tally +1 (bit set) or -1 (bit unset) across all features
 *   4. The SimHash bit is 1 if the tally is non-negative, 0 otherwise
 */

import { keccak256, toHex, type Hex } from 'viem';

/** Structured evidence checkpoint captured during restoration. */
export interface EvidenceCheckpointV1 {
  version: 1;
  /** keccak256 of the Task description text. */
  desiredStateHash: string;
  /** Tool calls made during restoration. */
  toolCalls: {
    /** Normalized tool name (lowercase, trimmed). */
    name: string;
    /** keccak256 of JSON-stringified sorted args. */
    argsHash: string;
  }[];
  /** External interactions (API calls, file reads, etc.). */
  externalInteractions: {
    /** Normalized URL or path. */
    endpoint: string;
    /** HTTP method or interaction type. */
    method: string;
  }[];
  /** Restoration outcome. */
  outcome: 'success' | 'failure' | 'partial';
}

/**
 * Extract string features from an evidence checkpoint.
 * Each feature becomes one "vote" in the SimHash computation.
 */
export function extractFeatures(checkpoint: EvidenceCheckpointV1): string[] {
  const features: string[] = [];

  features.push(`desired:${checkpoint.desiredStateHash}`);

  for (const tc of checkpoint.toolCalls) {
    features.push(`tool:${tc.name.toLowerCase().trim()}:${tc.argsHash}`);
  }

  for (const ei of checkpoint.externalInteractions) {
    features.push(`ext:${ei.endpoint.toLowerCase().trim()}:${ei.method.toLowerCase().trim()}`);
  }

  features.push(`outcome:${checkpoint.outcome}`);

  return features;
}

/**
 * Compute a 256-bit SimHash from an array of string features.
 *
 * Each feature is hashed to 256 bits via keccak256. For each bit position,
 * we tally +1 if the bit is set, -1 if not. The output bit is 1 if the
 * tally is non-negative.
 */
export function simhashFromFeatures(features: string[]): Hex {
  if (features.length === 0) {
    return '0x0000000000000000000000000000000000000000000000000000000000000000';
  }

  // Hash each feature to 256 bits
  const featureHashes = features.map((f) =>
    BigInt(keccak256(toHex(f)))
  );

  // Vote on each bit position
  const votes = new Int32Array(256);
  for (const hash of featureHashes) {
    for (let i = 0; i < 256; i++) {
      if ((hash >> BigInt(i)) & 1n) {
        votes[i] += 1;
      } else {
        votes[i] -= 1;
      }
    }
  }

  // Construct SimHash from vote signs
  let simhash = 0n;
  for (let i = 0; i < 256; i++) {
    if (votes[i] >= 0) {
      simhash |= 1n << BigInt(i);
    }
  }

  return ('0x' + simhash.toString(16).padStart(64, '0')) as Hex;
}

/**
 * Compute the SimHash of an evidence checkpoint.
 * Returns a bytes32 hex string suitable for submission to the on-chain activity checker.
 */
export function computeEvidenceSimHash(checkpoint: EvidenceCheckpointV1): Hex {
  const features = extractFeatures(checkpoint);
  return simhashFromFeatures(features);
}

/**
 * Compute the Hamming distance between two bytes32 hex strings.
 * Useful for client-side similarity checking before submitting on-chain.
 */
export function hammingDistance(a: Hex, b: Hex): number {
  const xor = BigInt(a) ^ BigInt(b);
  let count = 0;
  let bits = xor;
  while (bits > 0n) {
    count += Number(bits & 1n);
    bits >>= 1n;
  }
  return count;
}
