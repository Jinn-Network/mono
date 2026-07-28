import type { DsseEnvelope } from "@jinn-network/trust-core";
import type { AnnouncementEntry } from "../entry.js";
import type { SourceHead } from "../head.js";
import type { FreshnessPolicy, HighWaterMarkStore, KeyResolver, SignatureVerifier } from "./ports.js";
import type { SourceChainOutcome } from "./outcomes.js";

// Named verification: `source-chain-verification` (design §10.3). Skeleton
// only -- the seven-step procedure is implemented at M4 (Task 12), driven
// red-then-green by the `discovery/testing` conformance kit (program §7.6
// kit-before-implementation discipline).

export async function verifySourceChain(opts: {
  head: SourceHead;
  headSignature: DsseEnvelope;
  entries: AsyncIterable<{ entry: AnnouncementEntry; signature: DsseEnvelope }>;
  ports: {
    keys: KeyResolver;
    sigs: SignatureVerifier;
    fresh: FreshnessPolicy;
    hwm: HighWaterMarkStore;
    now: Date;
    firstAdoption: boolean;
  };
}): Promise<SourceChainOutcome> {
  void opts;
  throw new Error("not implemented");
}
