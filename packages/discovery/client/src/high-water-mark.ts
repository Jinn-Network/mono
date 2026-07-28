import type { SourceCursor, SourceIdentity } from "@jinn-network/record-discovery-protocol";

import type { HighWaterMarkStore } from "./ports.js";

// The source position cursor (design §5.3 rule 4): the tuple
// `(sequence, entry digest)` a consumer persists per source, advanced by
// `source-chain-verification` (§10.3 step 7) on every accepted head. This
// module provides the in-memory implementation; a persistent
// implementation (file, database) satisfies the exact same
// `HighWaterMarkStore` shape (re-exported from `protocol`, `ports.ts`) --
// injected by the host, never built into this package.

function sourceKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
}

/** An in-memory `HighWaterMarkStore`. Positions are lost on process exit -- suitable for tests and short-lived processes only. */
export function createInMemoryHighWaterMarkStore(): HighWaterMarkStore {
  const positions = new Map<string, SourceCursor>();
  return {
    async get(source: SourceIdentity): Promise<SourceCursor | undefined> {
      return positions.get(sourceKey(source));
    },
    async put(source: SourceIdentity, cursor: SourceCursor): Promise<void> {
      positions.set(sourceKey(source), cursor);
    },
  };
}
