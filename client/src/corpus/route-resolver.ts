/**
 * Default RouteResolver — uses the artifact's own access.endpoint directly.
 *
 * Phase A.1 doesn't ship a centralized resolver: every artifact descriptor in
 * the manifest envelope already carries its own `access.endpoint` and
 * `access.priceUsdc`. The default resolver simply returns null so the acquire
 * chain falls through to the origin x402 fetch using those fields.
 *
 * Future phases may introduce a real resolver (e.g. multi-mirror selection,
 * DHT lookup, peer routing) by implementing the `RouteResolver` interface from
 * `./types.js`.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §2.5.
 */

import type { RouteResolver } from './types.js';

export const noopRouteResolver: RouteResolver = {
  async resolve() {
    return null;
  },
};
