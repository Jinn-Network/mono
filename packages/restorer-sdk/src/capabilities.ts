import type { Address, Hex } from './types.js';

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
 * The runtime gate on `ScopedSigner.signTypedData` is enforced
 * daemon-side: the daemon constructs the signer with an allow-list
 * derived from the manifest's `capabilities.signer.typedDataDomains`
 * (see {@link TypedDataAllowEntry} on `manifest.ts`) and refuses any
 * domain not on the list. An impl that ships no `typedDataDomains`
 * entry cannot call `signTypedData` at all (default-deny). The
 * `ScopedSigner` interface itself is unchanged — the gate lives in
 * the construction args, not the contract surface.
 */

export interface SendAllowedCallArgs {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface ScopedSigner {
  readonly address: Address;
  signTypedData(args: SignTypedDataArgs): Promise<Hex>;
  sendAllowedCall(call: SendAllowedCallArgs): Promise<Hex>;
}

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

export type ScopedSecrets = Readonly<Record<string, string>>;
