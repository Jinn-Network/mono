// SPDX-License-Identifier: Apache-2.0

import type { SyncedEntry, VerifyDriver } from "@jinn-network/record-discovery-client";
import type { SourceHead, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import type { DsseEnvelope } from "@jinn-network/trust-core";

import { describeError } from "./errors.js";

export interface ChainVerificationInput {
  readonly source: SourceIdentity;
  readonly head: SourceHead;
  readonly headSignature?: DsseEnvelope;
  readonly entries: readonly SyncedEntry[];
  readonly firstAdoption: boolean;
}

export type ChainVerificationOutcome =
  | { readonly status: "ok" }
  | { readonly status: "rejected"; readonly reason: string };

export interface ChainVerification {
  readonly mode: "verified" | "unverified";
  verify(input: ChainVerificationInput): Promise<ChainVerificationOutcome>;
}

/**
 * `record-discovery-client`'s `coldSync`/`returningSync` are DATA ACQUISITION
 * ONLY — `packages/discovery/client/src/sync.ts:16-19` says so explicitly:
 * `verify-driver.ts` is what verifies a walked chain. A mirror is therefore
 * required to state which of the three postures it takes, at construction,
 * with no default.
 */

/** The construction-time default: verify nothing, admit nothing. */
export function createRejectingChainVerification(): ChainVerification {
  return Object.freeze({
    mode: "unverified" as const,
    async verify(): Promise<ChainVerificationOutcome> {
      return { status: "rejected", reason: "chain-verification-not-configured" };
    },
  });
}

export const UNVERIFIED_CHAIN_ACKNOWLEDGEMENT =
  "announcement-chain-signatures-are-not-verified-by-this-runtime" as const;

export type UnverifiedChainAcknowledgement = typeof UNVERIFIED_CHAIN_ACKNOWLEDGEMENT;

/**
 * Mirrors without verifying announcement-chain signatures. The literal
 * acknowledgement argument makes the posture impossible to acquire by
 * accident, and the `mode: "unverified"` field makes the capability's health
 * check report it rather than pretending. Downstream gates (record-digest
 * validation in the indexer, producer admission at read) still hold.
 */
export function createUnverifiedChainVerification(
  acknowledgement: UnverifiedChainAcknowledgement,
): ChainVerification {
  void acknowledgement;
  return Object.freeze({
    mode: "unverified" as const,
    async verify(): Promise<ChainVerificationOutcome> {
      return { status: "ok" };
    },
  });
}

/** The real posture: `record-discovery-client`'s verification driver. */
export function createDriverChainVerification(driver: VerifyDriver): ChainVerification {
  return Object.freeze({
    mode: "verified" as const,
    async verify(input: ChainVerificationInput): Promise<ChainVerificationOutcome> {
      const headSignature = input.headSignature;
      if (headSignature === undefined) {
        // The unpublished-source profile omits head signatures. A runtime
        // that injects corpus content into a live agent session does not
        // accept it. Fail-closed.
        return { status: "rejected", reason: "head-unsigned" };
      }

      const signed = input.entries.filter(
        (entry): entry is SyncedEntry & { signature: DsseEnvelope } => entry.signature !== undefined,
      );

      async function* entries(): AsyncGenerator<{
        entry: SyncedEntry["entry"];
        signature: DsseEnvelope;
      }> {
        for (const item of signed) yield { entry: item.entry, signature: item.signature };
      }

      try {
        const outcome = await driver.verifySource({
          source: input.source,
          head: input.head,
          headSignature,
          entries: entries(),
          firstAdoption: input.firstAdoption,
        });
        return outcome.status === "ok"
          ? { status: "ok" }
          : { status: "rejected", reason: outcome.status };
      } catch (error) {
        void describeError(error);
        return { status: "rejected", reason: "verification-failed" };
      }
    },
  });
}
