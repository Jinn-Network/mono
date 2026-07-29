// SPDX-License-Identifier: MIT

import type { CloseBoundaryResolver } from "@jinn-network/benchmarking-run";
import type { RunRecord } from "@jinn-network/benchmarking-records";

/** Host-injected finalized block reader (no ambient RPC in this package). */
export interface FinalizedAnchorPort {
  /**
   * Returns the first host-attested finalized block whose timestamp is at or after `closeAt`,
   * or `undefined` when no such anchor exists (fail closed).
   */
  firstFinalizedAtOrAfter(closeAt: string): Promise<{
    readonly chain: string;
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly timestamp: string;
  } | undefined>;
}

export interface CloseBoundaryPorts {
  readonly blocks: FinalizedAnchorPort;
}

export class CloseBoundaryResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloseBoundaryResolutionError";
  }
}

/**
 * Marketplace close boundary (design §8.1 / program §7.137).
 * `at` is always the exact sealed `Run.closeAt`; the anchor is separately derived and required.
 */
export function marketplaceCloseBoundary(ports: CloseBoundaryPorts): CloseBoundaryResolver {
  return {
    async resolve(run: RunRecord) {
      const at = run.closeAt;
      const anchorBlock = await ports.blocks.firstFinalizedAtOrAfter(at);
      if (anchorBlock === undefined) {
        throw new CloseBoundaryResolutionError(
          "no finalized anchor at or after Run.closeAt",
        );
      }
      return {
        at,
        anchor: {
          chain: anchorBlock.chain,
          blockNumber: anchorBlock.blockNumber,
          blockHash: anchorBlock.blockHash,
        },
      };
    },
  };
}
