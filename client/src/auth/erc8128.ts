/**
 * ERC-8128 HTTP Message Signatures for jinn-client.
 *
 * Ported from jinn-gemini-3/packages/crypto/src/erc8128.ts.
 * Uses @slicekit/erc8128 (RFC 9421 + Ethereum signatures).
 *
 * Usage:
 *   const signer = createPrivateKeyHttpSigner(privateKey, 8453);
 *   const signed = await signRequestWithErc8128({ signer, input: url, init: { method: 'POST', body } });
 *   // signed Request has signature, signature-input, content-digest headers
 *
 *   const result = await verifyRequestWithErc8128({ request: signed, nonceStore });
 *   // result.address is the verified signer
 */

import {
  signRequest,
  verifyRequest as erc8128VerifyRequest,
  type EthHttpSigner,
  type NonceStore,
  type VerifyMessageFn,
  type VerifyResult,
  type VerifyPolicy,
  type SignOptions,
} from '@slicekit/erc8128';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';

type Hex = `0x${string}`;

// ── Nonce store ──────────────────────────────────────────────────────────────

/**
 * In-memory nonce store with TTL-based expiration.
 * Tracks seen nonces and garbage-collects expired entries on access.
 */
export class InMemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();

  async consume(key: string, ttlSeconds: number): Promise<boolean> {
    this.gc();
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  private gc(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
  }
}

// ── Verification helper ──────────────────────────────────────────────────────

/**
 * Verify an ERC-191 personal_sign message using viem.
 * Matches the VerifyMessageFn shape expected by @slicekit/erc8128.
 */
export const ethVerifyMessage: VerifyMessageFn = async (args) => {
  try {
    return await verifyMessage({
      address: args.address as Hex,
      message: { raw: args.message.raw as Hex },
      signature: args.signature as Hex,
    });
  } catch {
    return false;
  }
};

// ── Signer construction ─────────────────────────────────────────────────────

export function createPrivateKeyHttpSigner(privateKey: Hex, chainId: number): EthHttpSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address as Hex,
    chainId,
    signMessage: (msg: Uint8Array) =>
      account.signMessage({ message: { raw: msg } }),
  };
}

// ── Request signing & verification ───────────────────────────────────────────

export async function signRequestWithErc8128(args: {
  signer: EthHttpSigner;
  input: RequestInfo;
  init?: RequestInit;
  signOptions?: SignOptions;
}): Promise<Request> {
  return signRequest(args.input, args.init, args.signer, {
    binding: 'request-bound',
    replay: 'non-replayable',
    ttlSeconds: 60,
    ...(args.signOptions ?? {}),
  });
}

export async function verifyRequestWithErc8128(args: {
  request: Request;
  nonceStore: NonceStore;
  policy?: Partial<VerifyPolicy>;
}): Promise<VerifyResult> {
  return erc8128VerifyRequest({
    request: args.request,
    verifyMessage: ethVerifyMessage,
    nonceStore: args.nonceStore,
    policy: {
      maxValiditySec: 300,
      clockSkewSec: 5,
      ...args.policy,
    },
  });
}

// ── Re-exported types ────────────────────────────────────────────────────────

export type {
  EthHttpSigner,
  NonceStore,
  VerifyResult,
  VerifyPolicy,
  SignOptions,
};
