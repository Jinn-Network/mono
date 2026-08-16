/**
 * Capability handles passed to a {@link Harness} via
 * {@link HarnessContext}. The daemon mints these per-call and
 * enforces the impl's manifest allow-list before delegating to the
 * underlying signer / RPC client.
 *
 * Spec: `spec/2026-05-executor-trust-boundary.md` §3.
 */

import type { Address, Hex } from 'viem';

/**
 * EIP-712 typed-data signing payload. Mirrors viem's signTypedData
 * input but with `account` removed — the daemon binds the signer to
 * its master EOA before delegation.
 */
export interface SignTypedDataArgs {
  domain: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Allow-listed transaction shape. Each call's `(chainId, to, selector)`
 * triple must match the impl's manifest capability allow-list; the
 * daemon refuses calls outside the list.
 */
export interface SendAllowedCallArgs {
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * Scoped signer — an impl never sees a raw private key. The daemon
 * issues this handle per `run()` call, validates each request against
 * the manifest allow-list, and discards it on return.
 */
export interface ScopedSigner {
  /** EOA address the daemon will sign as. Read-only. */
  readonly address: Address;
  /** Sign EIP-712 typed data for an allow-listed domain. */
  signTypedData(args: SignTypedDataArgs): Promise<Hex>;
  /** Send a tx whose (chainId, to, selector) is on the impl allow-list. */
  sendAllowedCall(call: SendAllowedCallArgs): Promise<Hex>;
}

/**
 * Scoped RPC — read-only subset of viem's PublicClient interface.
 * The daemon enforces method allow-list, rate limiting, and chain
 * filtering per `spec/2026-05-executor-trust-boundary.md` §3.3.
 */
export interface ScopedRpc {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  getChainId(): Promise<number>;
}

/**
 * Per-impl secret bag. Populated by the impl's own `onEnable` flow
 * and persisted under `implStateDir/<impl>/secrets/`. Read-only.
 */
export type ScopedSecrets = Readonly<Record<string, string>>;

export { createScopedSigner } from './scoped-signer.js';
export type {
  CapabilityAllowEntry,
  CreateScopedSignerArgs,
  TypedDataAllowEntry,
} from './scoped-signer.js';
export { createScopedRpc } from './scoped-rpc.js';
export type { CreateScopedRpcArgs } from './scoped-rpc.js';
export { freezeSecrets } from './scoped-secrets.js';
