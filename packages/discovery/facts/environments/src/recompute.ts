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
 * fetch, re-hash, and parse. The fail-closed `ReferencedBytes` path that record-to-record
 * digests use (see `facts/benchmarking`) therefore does not apply, and the field is emitted
 * directly. Reference-bearing labels an indexing relation; it does not by itself imply a
 * fetchable record.
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
 * The leaf's `FactsRecompute` registry entry: the host assembles the tree-wide registry by
 * merging each leaf's export. Unknown kinds return `undefined`, preserving discovery's
 * unknown-kind skip behaviour.
 */
export const ENVIRONMENTS_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    return kind === ENVIRONMENT_RECORD_KIND ? environmentRecompute : undefined;
  },
};
