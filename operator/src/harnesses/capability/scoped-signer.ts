/**
 * Scoped signer constructor — Phase 1 implementation. The (chainId,
 * to, selector) allow-list is enforced before `sendAllowedCall`
 * delegates, and the EIP-712 domain allow-list is enforced before
 * `signTypedData` delegates. Actual transaction signing is wired in a
 * follow-up plan (the daemon plan that owns the wallet); the typed-data
 * delegation hits the master account immediately.
 *
 * Spec: `spec/2026-05-executor-trust-boundary.md` §3.
 */

import type { Account, Address, Hex } from 'viem';
import type { ScopedSigner, SignTypedDataArgs, SendAllowedCallArgs } from './index.js';

export interface CapabilityAllowEntry {
  chainId: number;
  to: Address;
  /** Lower-case 4-byte selector with `0x` prefix (e.g. `0xdeadbeef`). */
  selector: Hex;
}

/**
 * EIP-712 typed-data domain allow-list entry. See
 * `operator/src/harnesses/manifest/types.ts:TypedDataAllowEntry` and
 * the manifest-schema field `capabilities.signer.typedDataDomains`.
 *
 * - `chainId` MUST match exactly.
 * - `verifyingContract` / `name` / `version` match only when set on
 *   the entry; an unset field on the entry means "any value".
 */
export interface TypedDataAllowEntry {
  chainId: number;
  name?: string;
  version?: string;
  verifyingContract?: Address;
}

export interface CreateScopedSignerArgs {
  account: Account;
  allowList: readonly CapabilityAllowEntry[];
  /**
   * Domain allow-list for `signTypedData`. The daemon refuses any
   * `signTypedData` call whose domain does not match an entry here.
   * Default-deny: an empty array means EVERY `signTypedData` call
   * throws (matches the "no typedDataDomains in the manifest" case).
   */
  typedDataAllowList: readonly TypedDataAllowEntry[];
  chainId: number;
}

function eqLowerOrUndef(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function matchesEntry(
  entry: TypedDataAllowEntry,
  domain: SignTypedDataArgs['domain'],
): boolean {
  if (domain.chainId !== entry.chainId) return false;
  if (entry.verifyingContract !== undefined) {
    if (!domain.verifyingContract) return false;
    if (!eqLowerOrUndef(entry.verifyingContract, domain.verifyingContract)) {
      return false;
    }
  }
  if (entry.name !== undefined) {
    if (domain.name !== entry.name) return false;
  }
  if (entry.version !== undefined) {
    if (domain.version !== entry.version) return false;
  }
  return true;
}

export function createScopedSigner({
  account,
  allowList,
  typedDataAllowList,
  chainId,
}: CreateScopedSignerArgs): ScopedSigner {
  return {
    get address() {
      return account.address;
    },

    async signTypedData(args: SignTypedDataArgs): Promise<Hex> {
      // Default-deny: empty allow-list refuses everything. Operators
      // who need typed-data signing MUST declare a
      // `capabilities.signer.typedDataDomains` entry on the manifest.
      // Finding 3.
      const allowed = typedDataAllowList.some((entry) =>
        matchesEntry(entry, args.domain),
      );
      if (!allowed) {
        throw new Error(
          `signTypedData domain not in allow-list (chainId=${args.domain.chainId ?? 'unspecified'}, ` +
            `verifyingContract=${args.domain.verifyingContract ?? 'unspecified'})`,
        );
      }
      if (typeof account.signTypedData !== 'function') {
        throw new Error('master account does not support signTypedData');
      }
      return account.signTypedData(args as never);
    },

    async sendAllowedCall(call: SendAllowedCallArgs): Promise<Hex> {
      const selector = call.data.slice(0, 10).toLowerCase() as Hex;
      const entry = allowList.find(
        (e) =>
          e.chainId === chainId &&
          e.to.toLowerCase() === call.to.toLowerCase() &&
          e.selector.toLowerCase() === selector,
      );
      if (!entry) {
        const haveContract = allowList.some(
          (e) => e.chainId === chainId && e.to.toLowerCase() === call.to.toLowerCase(),
        );
        if (!haveContract) {
          throw new Error(`to ${call.to} not in allow-list for chain ${chainId}`);
        }
        throw new Error(
          `selector ${selector} not in allow-list for ${call.to} on chain ${chainId}`,
        );
      }
      // Phase 1: shape only — actual signing is wired in the daemon plan.
      throw new Error(
        'sendAllowedCall is allow-list-validated but signing is wired in the daemon plan',
      );
    },
  };
}
