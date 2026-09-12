// SPDX-License-Identifier: Apache-2.0

import type { SyncedEntry, VerifyDriver } from "@jinn-network/record-discovery-client";
import type { SourceHead, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import type { DsseEnvelope } from "@jinn-network/trust-core";

import type { RuntimeLogger } from "../logger.js";
import { describeError } from "./errors.js";

export interface ChainVerificationInput {
  readonly source: SourceIdentity;
  readonly head: SourceHead;
  readonly headSignature?: DsseEnvelope;
  readonly entries: readonly SyncedEntry[];
  /**
   * Whether the mirror abandoned the walk before it ran out, and WHY -- so
   * `entries` is a PREFIX of the chain above the mark rather than the whole of
   * it (#3252), and the operator can be told which of the two abandonments it
   * was (#3672).
   *
   * The walk yields oldest-first, so a prefix is missing the newest entries,
   * including the one the head cites. Whether that is fatal is the posture's
   * to say, which is why the fact travels here rather than being judged in the
   * mirror: a posture that verifies linkage cannot accept it, and one that
   * verifies nothing loses nothing by indexing the prefix and resuming from it
   * on the next pass.
   *
   * The cause travels WITH the fact rather than collapsing into one boolean
   * because the two abandonments need different operator advice. `bound` is a
   * config value the operator can raise; `aborted` is a cancellation, and
   * telling that operator to raise the bound sends them to tune a value that
   * was never the constraint.
   */
  readonly truncation: WalkTruncation;
  readonly firstAdoption: boolean;
}

/**
 * The head of a source that is re-serving the chain position this mirror
 * already holds -- byte-identical, or re-signed at a later instant (#3468).
 * `entries` is deliberately absent: the caller only reaches this input having
 * established that the walk yielded nothing.
 */
export interface HeadRevalidationInput {
  readonly source: SourceIdentity;
  readonly head: SourceHead;
  readonly headSignature?: DsseEnvelope;
}

/**
 * Why a walk stopped short, if it did (#3672).
 *
 * One discriminated field rather than a boolean plus an optional cause,
 * because that pair can express `{ truncated: false, cause: "aborted" }` --
 * a state that means nothing -- and does not force a construction site to say
 * which abandonment it saw.
 */
export type WalkTruncation = "none" | "bound" | "aborted";

export type ChainVerificationOutcome =
  | { readonly status: "ok" }
  | { readonly status: "rejected"; readonly reason: string };

/**
 * The one refusal reason in this module that is NOT the archive's doing but
 * this runtime's own per-pass bound (#3252). Shared so the health check can
 * branch its remedy on it without matching a bare literal that could drift
 * away from the value emitted here.
 */
export const SYNC_TRUNCATED_REASON = "sync-truncated";

/**
 * The other refusal that is this runtime's own doing rather than the archive's
 * (#3672): the walk was CANCELLED before it ran out.
 *
 * Kept distinct from `SYNC_TRUNCATED_REASON` because the remedy differs. The
 * bound is a number an operator can raise; a cancellation is not, and rendering
 * the bound's remedy for it sends that operator to tune a config value that did
 * not cause the stop and that raising will not change.
 */
export const SYNC_ABORTED_REASON = "sync-aborted";

export interface ChainVerification {
  readonly mode: "verified" | "unverified";
  verify(input: ChainVerificationInput): Promise<ChainVerificationOutcome>;
  /**
   * `source-head-revalidation`: the same posture applied to a head at the
   * position already on file. Every posture must answer it, and must answer it
   * as strictly as it answers `verify` -- it is the one path a source can take
   * repeatedly without appending anything, so a posture that waved it through
   * would let a revoked key keep a mirror green indefinitely.
   */
  revalidateHead(input: HeadRevalidationInput): Promise<ChainVerificationOutcome>;
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
    async revalidateHead(): Promise<ChainVerificationOutcome> {
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
    async revalidateHead(): Promise<ChainVerificationOutcome> {
      return { status: "ok" };
    },
  });
}

/**
 * The real posture: `record-discovery-client`'s verification driver.
 *
 * The logger is REQUIRED, and is the only place a driver's thrown cause can go
 * (#3253). `verification-failed` is a closed-union literal, and the
 * `corpus-chain-verification` health check interpolates only such literals and
 * locally configured source names into its `detail` and `remedy` — so putting
 * remote-influenced free text into `reason` to carry the cause would widen a
 * surface that is deliberately narrow. Logging it here leaves `reason` the
 * literal and still gives the operator debugging a `verification-failed`
 * archive something more than the symptom.
 */
export function createDriverChainVerification(
  driver: VerifyDriver,
  log: RuntimeLogger,
): ChainVerification {
  function reportDriverFailure(
    source: SourceIdentity,
    operation: "verify" | "revalidate-head",
    error: unknown,
  ): void {
    log.warn("corpus.chain-verification.driver-failed", {
      agent: source.agent,
      name: source.name,
      operation,
      message: describeError(error),
    });
  }

  return Object.freeze({
    mode: "verified" as const,
    async verify(input: ChainVerificationInput): Promise<ChainVerificationOutcome> {
      if (input.truncation !== "none") {
        // Refused ahead of every check on the source, because a cut chain is
        // this runtime's own doing: `verifySourceChain` walks linkage from the
        // head's cited entry, which a truncated walk does not contain, so
        // asking it here would return `broken-chain` and blame the archive for
        // a stop the operator never caused. Naming the real cause is what lets
        // that operator act on it instead of hunting a phantom linkage break
        // (#3252) -- and naming WHICH cause is what keeps that action right
        // (#3672).
        return {
          status: "rejected",
          reason: input.truncation === "aborted" ? SYNC_ABORTED_REASON : SYNC_TRUNCATED_REASON,
        };
      }
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
        reportDriverFailure(input.source, "verify", error);
        return { status: "rejected", reason: "verification-failed" };
      }
    },

    async revalidateHead(input: HeadRevalidationInput): Promise<ChainVerificationOutcome> {
      const headSignature = input.headSignature;
      if (headSignature === undefined) {
        // Same fail-closed rule as `verify`: this runtime does not accept an
        // unsigned head, and one at the position already on file is no different.
        return { status: "rejected", reason: "head-unsigned" };
      }
      try {
        const outcome = await driver.verifyHead({
          source: input.source,
          head: input.head,
          headSignature,
        });
        return outcome.status === "ok"
          ? { status: "ok" }
          : { status: "rejected", reason: outcome.status };
      } catch (error) {
        reportDriverFailure(input.source, "revalidate-head", error);
        return { status: "rejected", reason: "verification-failed" };
      }
    },
  });
}
