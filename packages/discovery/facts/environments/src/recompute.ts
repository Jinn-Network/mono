import { parseEnvironmentRecord } from "@jinn-network/environment-record";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type {
  FactsRecompute,
  RecordFactRecompute,
  RecordFactValue,
} from "@jinn-network/record-discovery-protocol";

import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";

/**
 * Recomputes the environment card from the record's own sealed BYTES — never from a supplied
 * projection. `parseEnvironmentRecord` requires the exact canonical encoding, so a card
 * attached to re-serialized bytes recomputes to nothing and reads as inconsistent.
 *
 * Every field here is native: it is read out of this record's own bytes. `image.manifestDigest`
 * is declared *reference-bearing* in the profile so discovery's `referrers` relation inverts
 * it — but an OCI image is not an announceable record, so there are no referenced bytes to
 * retrieve, re-hash, and parse. The fail-closed `ReferencedBytes` path that record-to-record
 * digests use (see `facts/benchmarking`) therefore does not apply, and the field is emitted
 * directly. Reference-bearing labels an indexing relation; it does not by itself imply a
 * retrievable record.
 */
export const environmentRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const record = parseEnvironmentRecord(bytes);
    const facts: Record<string, RecordFactValue> = {
      environmentRecordDigest: recordDigest(bytes),
      "source.repo": record.source.repo,
      "source.commit": record.source.commit,
      "image.manifestDigest": record.image.manifestDigest,
      "image.platform": record.image.platform,
      "build.reproducibilityTier": record.build.reproducibilityTier,
    };
    return facts;
  } catch {
    return {};
  }
};

/**
 * The v2 card: v1's fields plus the three further components the record pins by digest -- the
 * multi-arch index the platform manifest came from, the parser, and the build recipe. Same
 * posture as v1: each is a digest-pinned artifact rather than an announceable record, so there
 * are no referenced bytes to retrieve and re-hash, and the fields are emitted directly from the
 * record's own statement. An absent optional component is simply not announced.
 *
 * A recipe is a ResourceDescriptor, which §6.4 lets a uri or inline content satisfy; only a
 * digest-bearing one pins anything, so only that one is an edge.
 */
export const environmentRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await environmentRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return {};
  try {
    const record = parseEnvironmentRecord(bytes);
    const recipeDigest = record.build.recipe?.digest?.sha256;
    return {
      ...facts,
      ...(record.image.indexDigest === undefined ? {} : { "image.indexDigest": record.image.indexDigest }),
      "parser.digest": record.parser.digest,
      ...(recipeDigest === undefined ? {} : { "build.recipeDigest": `sha256:${recipeDigest}` }),
    };
  } catch {
    return {};
  }
};

/**
 * The leaf's `FactsRecompute` registry entry: the host assembles the tree-wide registry by
 * merging each leaf's export. Unknown kinds return `undefined`, preserving discovery's
 * unknown-kind skip behavior.
 */
export const ENVIRONMENTS_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    return kind === ENVIRONMENT_RECORD_KIND ? environmentRecompute : undefined;
  },
};

/** Explicit registry for the coexisting environment facts v2 profile. */
export const ENVIRONMENTS_FACTS_RECOMPUTE_V2: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    return kind === ENVIRONMENT_RECORD_KIND
      ? environmentRecomputeV2
      : ENVIRONMENTS_FACTS_RECOMPUTE.get(kind);
  },
};
