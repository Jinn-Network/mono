import {
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  prefixedDigest,
} from "@jinn-network/chain-environment-record";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type {
  FactsRecompute,
  RecordFactRecompute,
  RecordFactValue,
} from "@jinn-network/record-discovery-protocol";

import { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND } from "./identifiers.js";

/**
 * Recomputes the chain-environment card from the record's own sealed BYTES — never from a
 * supplied projection. `parseChainEnvironmentRecord` requires the exact canonical encoding, so
 * a card attached to re-serialized bytes recomputes to nothing and reads as inconsistent.
 *
 * Two fields are declared *reference-bearing* so discovery's `referrers` relation inverts them:
 * the runtime image (an OCI manifest, not an announceable record) and the state artifact (CF4).
 * Neither is a record, so there are no referenced bytes to retrieve and re-hash; both are
 * emitted directly. Reference-bearing labels an indexing relation and does not by itself imply
 * a retrievable record.
 *
 * The artifact digest is lifted from the in-toto DigestSet's bare-hex spelling into the
 * record-body `sha256:` spelling every other digest fact carries, so one card never mixes two
 * spellings of one kind of value. An `archive-dependent` record has no artifact yet, and the
 * fact is then absent rather than empty.
 */
export const chainEnvironmentRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const record = parseChainEnvironmentRecord(bytes);
    const facts: Record<string, RecordFactValue> = {
      chainEnvironmentRecordDigest: recordDigest(bytes),
      "runtime.family": record.runtime.family,
      "runtime.version": record.runtime.version,
      "runtime.image.manifestDigest": record.runtime.image.manifestDigest,
      "stateMaterialization.closureClass": record.stateMaterialization.closureClass,
      "stateMaterialization.fidelityClass": record.stateMaterialization.fidelityClass,
    };
    const artifactDigest = record.stateMaterialization.stateArtifact?.descriptor.digest?.sha256;
    if (artifactDigest !== undefined) {
      facts["stateMaterialization.stateArtifactDigest"] = prefixedDigest(artifactDigest);
    }
    return facts;
  } catch {
    return {};
  }
};

/**
 * The composite card. `chainWorld.digest` is a genuine record-to-record edge — the one that
 * makes "which composites use this chain world" answerable — and is emitted in the record-body
 * spelling for the same reason as above. `informationWorldCount` is the cheapest honest signal
 * of whether a composite has an information plane at all.
 */
export const cryptoEnvironmentRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const record = parseCryptoEnvironmentRecord(bytes);
    const chainWorldDigest = record.chainWorld.record.digest?.sha256;
    if (chainWorldDigest === undefined) return {};
    const facts: Record<string, RecordFactValue> = {
      cryptoEnvironmentRecordDigest: recordDigest(bytes),
      "chainWorld.digest": prefixedDigest(chainWorldDigest),
      informationWorldCount: record.informationWorlds.length,
      "composition.requestBudget.maxRequests": record.composition.requestBudget.maxRequests,
    };
    return facts;
  } catch {
    return {};
  }
};

/**
 * The leaf's `FactsRecompute` registry entry: the host assembles the tree-wide registry by
 * merging each leaf's export. Unknown kinds return `undefined`, preserving discovery's
 * unknown-kind skip behaviour — which is what lets a new record kind deploy with no protocol
 * change at all.
 */
export const CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    if (kind === CHAIN_ENVIRONMENT_KIND) return chainEnvironmentRecompute;
    if (kind === CRYPTO_ENVIRONMENT_KIND) return cryptoEnvironmentRecompute;
    return undefined;
  },
};
