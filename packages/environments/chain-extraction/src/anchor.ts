// SPDX-License-Identifier: Apache-2.0

import { normalizeHex32 } from "./hex.js";
import { stageFail, stageOk, type StageOutcome } from "./failures.js";
import type { BudgetedArchivePort } from "./budget.js";
import type { Clock } from "./ports.js";
import type { Hex32 } from "./hex.js";

/** A ResourceDescriptor as the record carries it; CE1 owns the schema, CE4 only passes
 * it through, so the shape here is the minimum this module reads. */
export interface HeaderProofDescriptor {
  readonly name: string;
  readonly digest: { readonly sha256: string };
}

/**
 * Design E5 lives in CE1's `anchorAuthenticityBoundOf(anchor)`, which returns
 * `"not-anchored" | "declared" | "header-proven"`. CE4 **calls that function** and never
 * re-derives the bound; this module only carries the header-proof descriptor the author
 * supplied, so the assembled record can name it and CE1 can classify it.
 */
export type HeaderProofCarrier = HeaderProofDescriptor | undefined;

export interface AnchorFinalityObservation {
  /** RFC 3339 UTC, from the injected clock. Part of the claim: an old observation
   * re-presented later is not a fresh one. */
  readonly observedAt: string;
  readonly finalizedBlockNumber: number;
  /** Positive when the anchor is at or below the finalized head; negative when the
   * author anchored above it, which is legal and recorded rather than refused. */
  readonly depthBelowFinalized: number;
  readonly finalizedAtObservation: boolean;
}

export interface AnchorCapture {
  readonly blockNumber: number;
  readonly blockHash: Hex32;
  readonly stateRoot: Hex32;
  /** Unix seconds, as the chain reports it. */
  readonly timestamp: number;
  readonly finality: AnchorFinalityObservation;
  readonly headerProof: HeaderProofCarrier;
}

export interface AnchorRequest {
  readonly blockNumber: number;
  readonly headerProof?: HeaderProofDescriptor;
}

/** Archives fail two distinguishable ways, and the difference tells the author what to
 * do: get a *different* archive, or get archive access at all. */
function classifyHeaderError(cause: unknown): { reason: "archive-anchor-pruned" | "archive-unreachable"; detail: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  const pruned = /missing trie node|state.*not available|pruned|header not found|block not found/iu.test(message);
  return {
    reason: pruned ? "archive-anchor-pruned" : "archive-unreachable",
    detail: message,
  };
}

export async function captureAnchor(
  archive: BudgetedArchivePort,
  request: AnchorRequest,
  clock: Clock,
): Promise<StageOutcome<AnchorCapture>> {
  if (!Number.isInteger(request.blockNumber) || request.blockNumber < 0) {
    return stageFail("archive-unreachable", `Anchor block must be a non-negative integer; received ${String(request.blockNumber)}.`);
  }

  let anchor;
  try {
    anchor = await archive.getBlockHeader(request.blockNumber);
  } catch (cause) {
    const { reason, detail } = classifyHeaderError(cause);
    return stageFail(reason, detail);
  }
  if (anchor.number !== request.blockNumber) {
    return stageFail(
      "archive-self-disagreement",
      `Asked for block ${request.blockNumber}; the archive answered with block ${anchor.number}.`,
    );
  }

  let finalized;
  try {
    finalized = await archive.getBlockHeader("finalized");
  } catch (cause) {
    const { reason, detail } = classifyHeaderError(cause);
    return stageFail(reason, `Finality observation failed: ${detail}`);
  }

  const observedAt = clock.now().toISOString();
  const depthBelowFinalized = finalized.number - anchor.number;

  return stageOk({
    blockNumber: anchor.number,
    blockHash: normalizeHex32(anchor.hash),
    stateRoot: normalizeHex32(anchor.stateRoot),
    timestamp: anchor.timestamp,
    finality: {
      observedAt,
      finalizedBlockNumber: finalized.number,
      depthBelowFinalized,
      finalizedAtObservation: depthBelowFinalized >= 0,
    },
    headerProof: request.headerProof,
  });
}

/**
 * Re-reads the anchor header after the extraction has consumed the archive, and refuses
 * to proceed if it changed. A frozen historical block cannot legitimately change; a
 * provider that answers differently is either racing across a pool of nodes or serving
 * a reorged view, and either way every byte harvested in between is suspect.
 */
export async function confirmAnchorUnchanged(
  archive: BudgetedArchivePort,
  capture: AnchorCapture,
): Promise<StageOutcome<AnchorCapture>> {
  let again;
  try {
    again = await archive.getBlockHeader(capture.blockNumber);
  } catch (cause) {
    const { reason, detail } = classifyHeaderError(cause);
    return stageFail(reason, `Anchor re-read failed: ${detail}`);
  }
  const differences: string[] = [];
  if (normalizeHex32(again.hash) !== capture.blockHash) {
    differences.push(`blockHash ${capture.blockHash} -> ${normalizeHex32(again.hash)}`);
  }
  if (normalizeHex32(again.stateRoot) !== capture.stateRoot) {
    differences.push(`stateRoot ${capture.stateRoot} -> ${normalizeHex32(again.stateRoot)}`);
  }
  if (again.timestamp !== capture.timestamp) {
    differences.push(`timestamp ${capture.timestamp} -> ${again.timestamp}`);
  }
  if (differences.length > 0) {
    return stageFail(
      "archive-self-disagreement",
      `The archive answered differently for block ${capture.blockNumber}: ${differences.join("; ")}.`,
    );
  }
  return stageOk(capture);
}
