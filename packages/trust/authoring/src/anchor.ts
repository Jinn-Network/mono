// SPDX-License-Identifier: Apache-2.0

/**
 * Anchor submission and finality waiting (spec §3.2, §6 laws 1 and 4).
 *
 * Anchoring comes FIRST in every ceremony session, because `validFrom` must be the anchor's block
 * time — and must be the VERBATIM string this module returns, not merely the same instant: the
 * binding resolver compares those timestamps lexicographically, so a `…00Z` vs `…00.000Z` drift
 * changes outcomes. `submitAnchor` therefore emits the millisecond ISO form the production anchor
 * reader emits, and callers pass that string straight through to `authorRoleBinding`.
 *
 * The package holds no RPC configuration: clients are injected as narrow structural ports (§3.3).
 */
import { TrustAuthoringError } from "./errors.js";

export const NATIVE_ANCHOR_PROFILE =
  "https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1" as const;
export const NATIVE_ANCHOR_CHAIN_ID = 84532 as const;

/** The five-key locator the `jinn.native-trust-catalog/2` schema admits. */
export interface AnchorLocatorRecord {
  readonly profile: typeof NATIVE_ANCHOR_PROFILE;
  readonly chainId: typeof NATIVE_ANCHOR_CHAIN_ID;
  readonly transactionHash: `0x${string}`;
  readonly contractAddress: `0x${string}`;
  /** Zero-based byte offset into the canonical transaction input. */
  readonly inputByteOffset: number;
}

/** A submitted anchor: its on-disk locator plus the block time bindings must adopt verbatim. */
export interface AnchorLocator extends AnchorLocatorRecord {
  /** The mined block's timestamp, millisecond ISO — `validFrom`'s only correct value (§6 law 2). */
  readonly anchorTime: string;
}

/** One `anchors[]` entry of the catalog file. */
export interface AnchorDeclaration {
  readonly digest: `sha256:${string}`;
  readonly locator: AnchorLocatorRecord;
}

export interface FinalizedAnchorObservation {
  readonly digest: `sha256:${string}`;
  readonly anchorTime: string;
  readonly chainId: 84532;
  readonly transactionHash: `0x${string}`;
  readonly blockHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly finalized: true;
}

/** Structurally the daemon's `NativeFinalizedAnchorReadClient` — injected, never constructed here. */
export interface FinalizedAnchorReadClient {
  lookupFinalizedAnchor(input: {
    readonly digest: `sha256:${string}`;
    readonly locator: AnchorLocatorRecord;
  }): Promise<FinalizedAnchorObservation | null>;
}

export interface WalletClientLike {
  sendTransaction(input: {
    readonly to: `0x${string}`;
    readonly value: bigint;
    readonly data: `0x${string}`;
  }): Promise<`0x${string}`>;
}

export interface PublicClientLike {
  waitForTransactionReceipt(input: { readonly hash: `0x${string}` }): Promise<{
    readonly blockNumber: bigint;
    readonly status?: string;
  }>;
  getBlock(input: { readonly blockNumber: bigint }): Promise<{ readonly timestamp: bigint }>;
}

/** `sha256:<64 lowercase hex>` — the calldata payload an anchor tx carries. */
function digestHex(digest: `sha256:${string}`): string {
  const hex = digest.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/u.test(hex)) {
    throw new TrustAuthoringError(`anchor digest "${digest}" is not a lowercase sha256 digest`);
  }
  return hex;
}

/** Builds the catalog `anchors[]` entry for a submitted anchor. */
export function anchorDeclaration(
  digest: `sha256:${string}`,
  locator: AnchorLocatorRecord,
): AnchorDeclaration {
  return {
    digest,
    locator: {
      profile: locator.profile,
      chainId: locator.chainId,
      transactionHash: locator.transactionHash,
      contractAddress: locator.contractAddress,
      inputByteOffset: locator.inputByteOffset,
    },
  };
}

/**
 * Sends `0x<digest-hex>` as calldata to the anchor target and reads back the mined block's time.
 * The digest occupies the whole input, so `inputByteOffset` is 0 — the reader checks the exact bytes
 * at that offset, which is what makes the anchor a commitment rather than a mere transaction.
 */
export async function submitAnchor(input: {
  readonly walletClient: WalletClientLike;
  readonly publicClient: PublicClientLike;
  readonly target: `0x${string}`;
  readonly digest: `sha256:${string}`;
}): Promise<AnchorLocator> {
  const data = `0x${digestHex(input.digest)}` as `0x${string}`;
  const transactionHash = await input.walletClient.sendTransaction({
    to: input.target,
    value: 0n,
    data,
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== undefined && receipt.status !== "success") {
    throw new TrustAuthoringError(`anchor transaction ${transactionHash} reverted`);
  }
  const block = await input.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  return {
    profile: NATIVE_ANCHOR_PROFILE,
    chainId: NATIVE_ANCHOR_CHAIN_ID,
    transactionHash,
    contractAddress: input.target,
    inputByteOffset: 0,
    // The exact form the production reader emits, so `validFrom` can be this string verbatim.
    anchorTime: new Date(Number(block.timestamp) * 1_000).toISOString(),
  };
}

/**
 * Polls the injected finalized-anchor reader until the anchor reads back `finalized: true`, or
 * refuses on timeout. The catalog opener accepts only anchors below the finalized head, so a
 * ceremony that declared success before this returned would hand the operator a catalog that
 * refuses to boot. On live Base Sepolia the `finalized` tag trails head by roughly 10-20 minutes.
 */
export async function waitForFinalizedAnchor(input: {
  readonly anchorClient: FinalizedAnchorReadClient;
  readonly digest: `sha256:${string}`;
  readonly locator: AnchorLocatorRecord;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (elapsedMs: number) => void;
}): Promise<FinalizedAnchorObservation> {
  if (input.timeoutMs <= 0) throw new TrustAuthoringError("finality wait requires a positive timeoutMs");
  if (input.pollMs <= 0) throw new TrustAuthoringError("finality wait requires a positive pollMs");
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const startedAt = now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a poll loop is sequential by definition.
    const observation = await input.anchorClient.lookupFinalizedAnchor({
      digest: input.digest,
      locator: input.locator,
    });
    if (observation !== null && observation.finalized === true && observation.digest === input.digest) {
      return observation;
    }
    const elapsed = now() - startedAt;
    if (elapsed >= input.timeoutMs) {
      throw new TrustAuthoringError(
        `anchor ${input.digest} did not read back finalized within ${input.timeoutMs}ms`,
      );
    }
    input.onProgress?.(elapsed);
    // eslint-disable-next-line no-await-in-loop -- see above.
    await sleep(input.pollMs);
  }
}
