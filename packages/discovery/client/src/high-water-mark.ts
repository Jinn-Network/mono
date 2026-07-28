import type { HighWaterMark, SourceIdentity } from "@jinn-network/record-discovery-protocol";

import type { HighWaterMarkStore } from "./ports.js";

// The high-water mark (design §5.3 rule 4 chain-position cursor, plus
// §5.2/§10.3 step 3's persisted `issuedAt` for monotonicity) a consumer
// persists per source, advanced by `source-chain-verification` (§10.3 step
// 7) on every accepted head. This module provides the in-memory
// implementation; a persistent implementation (file, database) satisfies
// the exact same `HighWaterMarkStore` shape (re-exported from `protocol`,
// `ports.ts`) -- injected by the host, never built into this package.

function sourceKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
}

/** An in-memory `HighWaterMarkStore`. Positions are lost on process exit -- suitable for tests and short-lived processes only. */
export function createInMemoryHighWaterMarkStore(): HighWaterMarkStore {
  const positions = new Map<string, HighWaterMark>();
  return {
    async get(source: SourceIdentity): Promise<HighWaterMark | undefined> {
      return positions.get(sourceKey(source));
    },
    async put(source: SourceIdentity, mark: HighWaterMark): Promise<void> {
      positions.set(sourceKey(source), mark);
    },
  };
}
