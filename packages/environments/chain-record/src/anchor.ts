import { z } from "zod";

import { Bytes32, Caip2ChainId, Count, DigestPinnedDescriptorSchema } from "./primitives.js";

/** Finality observed at materialization time (§4.3). */
export const FINALITY_POLICIES = Object.freeze(["finalized", "safe", "latest"] as const);

/**
 * Where the state came from, when fidelity is not `local` (§4.3). Source-chain identity lives
 * here; sandbox execution identity lives in `runtime.evm.sandboxChainId`.
 */
export const ChainSourceAnchorSchema = z
  .strictObject({
    caip2ChainId: Caip2ChainId,
    nativeChainId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    genesisHash: Bytes32,
    blockNumber: Count,
    /** Mandatory: root-to-hash is falsifiable from this single header without any extension. */
    blockHash: Bytes32,
    stateRoot: Bytes32,
    /** Unix seconds at the anchor block. */
    timestamp: Count,
    finalityPolicy: z.union([
      z.enum(FINALITY_POLICIES),
      z.string().regex(/^confirmations:[1-9][0-9]*$/, "expected confirmations:<positive integer>"),
    ]),
    /**
     * Optional artifact binding root to block hash to an accepted view of chain history. Its
     * presence is what moves the anchor bound from `declared` to `header-proven` (E5); the
     * record never carries a field asserting the conclusion.
     */
    headerProof: DigestPinnedDescriptorSchema.optional(),
  })
  .superRefine((anchor, ctx) => {
    const [namespace, reference] = anchor.caip2ChainId.split(":");
    if (namespace === "eip155" && reference !== String(anchor.nativeChainId)) {
      ctx.addIssue({
        code: "custom",
        path: ["nativeChainId"],
        message:
          "caip2ChainId and nativeChainId name two different chains; for eip155 the CAIP-2 "
          + "reference is the native chain id (§4.3)",
      });
    }
  });

export type ChainSourceAnchor = z.infer<typeof ChainSourceAnchorSchema>;

/**
 * How far the record's own contents carry the anchor claim (E5).
 *
 * - `not-anchored` — no correspondence to any public chain is claimed.
 * - `declared` — subset proofs bind the committed slice to the *declared* root; that the
 *   declared root is the canonical chain's root at that block is a declaration.
 * - `header-proven` — the record commits a header-proof artifact for that step.
 *
 * This function reads the record; it checks nothing. Whether the committed proofs actually
 * verify is a question for the attestation layer, which states the resulting case in its own
 * predicate rather than letting "anchored" stand in for it.
 */
export type AnchorAuthenticityBound = "not-anchored" | "declared" | "header-proven";

export function anchorAuthenticityBoundOf(
  anchor: ChainSourceAnchor | undefined,
): AnchorAuthenticityBound {
  if (anchor === undefined) return "not-anchored";
  return anchor.headerProof === undefined ? "declared" : "header-proven";
}
