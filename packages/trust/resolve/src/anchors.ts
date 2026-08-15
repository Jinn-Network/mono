// SPDX-License-Identifier: Apache-2.0

import type { AnchorObservation, AnchorResolver, Sha256Digest } from "@jinn-network/trust-core";

// ---------------------------------------------------------------------------
// §7.3's time anchoring: "Anchor surfaces are designated by the deployment
// profile, but MUST provide: append-only writes, tamper-evidence, and a
// consistent observable order for all consumers." This module is a thin,
// cached adapter over whatever anchor surface the deployment actually
// uses (a calldata anchor transaction, an anchored `setMetadata` write,
// or any other conforming surface) -- the surface itself is injected via
// `AnchorReadClient`, structurally identical to `chain-facts.ts`'s
// `RegistryReadClient` seam, so both real and hermetic-test wiring share
// the same shape.
// ---------------------------------------------------------------------------

/** Structural injection seam for hermetic tests; a real host wires this to
 * whichever anchor surface its deployment profile designates. */
export interface AnchorReadClient {
  lookupAnchor(digest: Sha256Digest): Promise<AnchorObservation | null>;
}

export interface CreateAnchorResolverOptions {
  readonly client: AnchorReadClient;
}

/**
 * Builds an `AnchorResolver` with immutable caching: once a digest's
 * anchor observation is found, it never changes (anchors are append-only),
 * so it is cached forever. A not-yet-observed digest is never cached --
 * the anchor surface may still receive it later.
 */
export function createAnchorResolver(options: CreateAnchorResolverOptions): AnchorResolver {
  const cache = new Map<Sha256Digest, AnchorObservation>();

  return {
    async lookupAnchor(digest: Sha256Digest): Promise<AnchorObservation | null> {
      const cached = cache.get(digest);
      if (cached !== undefined) return cached;
      const observation = await options.client.lookupAnchor(digest);
      if (observation !== null) cache.set(digest, observation);
      return observation;
    },
  };
}
