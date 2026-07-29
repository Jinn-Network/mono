// SPDX-License-Identifier: MIT

import type { CloseBoundary } from "@jinn-network/benchmarking-run";
import type { RunRecord } from "@jinn-network/benchmarking-records";
import {
  CloseBoundaryResolutionError,
  marketplaceCloseBoundary,
  type CloseBoundaryPorts,
} from "./close-boundary.js";
import type { CloseAnchorRef } from "./input-scope.js";

/** Resolved close boundary plus the single anchor shared by every assembly leg. */
export interface CoherentCloseAuthority {
  readonly boundary: CloseBoundary;
  readonly anchor: CloseAnchorRef;
}

export class CloseAuthorityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloseAuthorityMismatchError";
  }
}

function anchorsEqual(left: CloseAnchorRef, right: CloseAnchorRef): boolean {
  return left.chain === right.chain
    && left.blockNumber === right.blockNumber
    && left.blockHash.toLowerCase() === right.blockHash.toLowerCase();
}

/**
 * Resolve the marketplace close boundary once. Matrix `closeBoundary.at` is always the sealed
 * `Run.closeAt`; the anchor is separately derived and required (program §7.137).
 */
export async function resolveCoherentCloseAuthority(
  run: RunRecord,
  ports: CloseBoundaryPorts,
): Promise<CoherentCloseAuthority> {
  const boundary = await marketplaceCloseBoundary(ports).resolve(run);
  if (boundary.anchor === undefined) {
    throw new CloseBoundaryResolutionError(
      "coherent close authority requires a finalized anchor at or after Run.closeAt",
    );
  }
  if (boundary.at !== run.closeAt) {
    throw new CloseAuthorityMismatchError(
      "close boundary at must equal sealed Run.closeAt",
    );
  }
  return {
    boundary,
    anchor: {
      chain: boundary.anchor.chain,
      blockNumber: boundary.anchor.blockNumber,
      blockHash: boundary.anchor.blockHash,
    },
  };
}

/** Cached resolver so assembly never re-derives a different anchor mid-run. */
export function cachedCloseBoundaryResolver(
  resolved: CloseBoundary,
): { resolve(run: RunRecord): Promise<CloseBoundary> } {
  return {
    async resolve(run) {
      if (resolved.at !== run.closeAt) {
        throw new CloseAuthorityMismatchError(
          "cached close boundary at does not match the supplied Run.closeAt",
        );
      }
      return resolved;
    },
  };
}

/**
 * Package-enforced coherence: every leg must share the exact resolved anchor. Callers cannot
 * inject a mismatched `closeAnchor` into input scope or event sources.
 */
export function assertCoherentCloseAnchor(
  expected: CloseAnchorRef,
  supplied: CloseAnchorRef,
): void {
  if (!anchorsEqual(expected, supplied)) {
    throw new CloseAuthorityMismatchError(
      "supplied close anchor does not match the resolved coherent close authority",
    );
  }
}
