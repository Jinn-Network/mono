// SPDX-License-Identifier: MIT

import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import {
  deriveAuthorityProjection,
  type AuthorityProjection,
} from "./authority-projection.js";
import type { CloseAnchorRef } from "./input-scope.js";

/**
 * Memoized authority projection shared by InputScope and settled cost.
 * Under coherent close, callers must supply a frozen resolver; standalone assembly
 * may derive one internally from `eventsThroughAnchor` exactly once.
 */
export interface AuthorityProjectionResolver {
  resolve(): Promise<AuthorityProjection>;
}

export class CoherentProjectionResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoherentProjectionResolverError";
  }
}

async function collectEvents(
  source:
    | Iterable<ObservationMarketplaceEvent>
    | AsyncIterable<ObservationMarketplaceEvent>,
): Promise<ObservationMarketplaceEvent[]> {
  const events: ObservationMarketplaceEvent[] = [];
  if (Symbol.asyncIterator in Object(source)) {
    for await (const event of source as AsyncIterable<ObservationMarketplaceEvent>) {
      events.push(event);
    }
    return events;
  }
  for (const event of source as Iterable<ObservationMarketplaceEvent>) {
    events.push(event);
  }
  return events;
}

/** Wraps an already-derived projection; `resolve()` never re-reads event sources. */
export function freezeAuthorityProjection(
  projection: AuthorityProjection,
): AuthorityProjectionResolver {
  return memoizeAuthorityProjectionResolver(async () => projection);
}

/** Memoizes derivation so input scope and cost share one projection instance. */
export function memoizeAuthorityProjectionResolver(
  source: () => Promise<AuthorityProjection>,
): AuthorityProjectionResolver {
  let cached: AuthorityProjection | undefined;
  let inflight: Promise<AuthorityProjection> | undefined;
  return {
    async resolve() {
      if (cached !== undefined) return cached;
      if (inflight === undefined) {
        inflight = source().then((value) => {
          cached = value;
          return value;
        });
      }
      return inflight;
    },
  };
}

/** Standalone helper: derive once from a fixed event snapshot. */
export function deriveAuthorityProjectionResolver(
  events: readonly ObservationMarketplaceEvent[],
  anchor: CloseAnchorRef,
  orphanedBlockHashes: ReadonlySet<string> = new Set(),
): AuthorityProjectionResolver {
  return freezeAuthorityProjection(
    deriveAuthorityProjection(events, anchor, orphanedBlockHashes),
  );
}

/** Standalone assembly: collect events once, then freeze the derived projection. */
export function deriveAuthorityProjectionResolverFromEvents(
  eventsThroughAnchor: () =>
    | Iterable<ObservationMarketplaceEvent>
    | AsyncIterable<ObservationMarketplaceEvent>,
  anchor: CloseAnchorRef,
  orphanedBlockHashes: ReadonlySet<string> = new Set(),
): AuthorityProjectionResolver {
  return memoizeAuthorityProjectionResolver(async () => {
    const events = await collectEvents(eventsThroughAnchor());
    return deriveAuthorityProjection(events, anchor, orphanedBlockHashes);
  });
}
