import {
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  prefixedDigest,
} from "@jinn-network/chain-environment-record";
import { parseInformationWorldRecord } from "@jinn-network/information-world";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type {
  FactsRecompute,
  RecordFactRecompute,
  RecordFactValue,
} from "@jinn-network/record-discovery-protocol";

import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  INFORMATION_WORLD_KIND,
} from "./identifiers.js";

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
 * Recomputes the information-world card from the record's own sealed BYTES — never from a
 * supplied projection. `parseInformationWorldRecord` requires the exact canonical encoding, so
 * a card attached to re-serialized bytes recomputes to nothing and reads as inconsistent.
 *
 * No field is declared reference-bearing: a corpus body is a digest-pinned artifact, not an
 * announceable record, so inverting on it would produce referrers that resolve to nothing.
 * `capture.fidelity` is projected as the record declares it — the card repeats a declaration
 * and adds no assessment of its own.
 */
export const informationWorldRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const record = parseInformationWorldRecord(bytes);
    return {
      informationWorldRecordDigest: recordDigest(bytes),
      "capture.fidelity": record.capture.fidelity,
      "requestKeyPolicy.version": record.requestKeyPolicy.version,
      "corpus.entryCount": record.corpus.entries.length,
      "corpus.originCount": record.corpus.origins.length,
    } satisfies Record<string, RecordFactValue>;
  } catch {
    return {};
  }
};

/**
 * Lifts a digest-pinned descriptor's bare-hex `digest.sha256` into the `sha256:` spelling every
 * digest fact on these cards carries. An absent descriptor yields `undefined`, and the field is
 * then simply not announced.
 */
function descriptorDigest(
  descriptor: { digest?: Record<string, string> } | undefined,
): `sha256:${string}` | undefined {
  const bare = descriptor?.digest?.sha256;
  return bare === undefined ? undefined : prefixedDigest(bare);
}

/** Drops the fields whose component this record does not carry, so nothing is announced empty. */
function present(
  fields: Record<string, RecordFactValue | undefined>,
): Record<string, RecordFactValue> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Record<string, RecordFactValue>;
}

// --- v2 revisions (join-edge completeness, protocol design §12 amendment 2026-08-28) --------
//
// Every added field is a component the record pins by digest in its own bytes, so all three
// recompute directly, with the same posture v1 documents: reference-bearing labels the indexing
// relation and does not by itself imply the target is a retrievable announceable record.
//
// The non-null assertions below are sound by schema: `DigestPinnedDescriptorSchema` refines every
// one of these descriptors to carry `digest.sha256`, so `parseChainEnvironmentRecord` has already
// rejected a record where one is missing. Writing a runtime branch for it would be unreachable.

/** v1's card plus every remaining component a chain world pins, and its lineage pointer. */
export const chainEnvironmentRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await chainEnvironmentRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return {};
  try {
    const record = parseChainEnvironmentRecord(bytes);
    const state = record.stateMaterialization;
    const contract = record.verificationContract;
    return {
      ...facts,
      ...present({
        "runtime.image.indexDigest": record.runtime.image.indexDigest,
        "sourceAnchor.headerProofDigest": descriptorDigest(record.sourceAnchor?.headerProof),
        "stateMaterialization.materializerDigest": state.materializer.digest,
        "stateMaterialization.sourceProofsDigest": descriptorDigest(state.sourceProofManifest?.proofs),
        "stateMaterialization.fixtureCoverageManifestDigest": descriptorDigest(state.fixtureCoverage?.manifest),
        supersedesDigest: descriptorDigest(record.supersedes),
      }),
      fixtureModuleDigests: record.fixtures.modules.map((module) => descriptorDigest(module.module)!),
      "capabilityEnvelope.toolInterfaceSchemaDigests": record.capabilityEnvelope.toolInterfaces.map(
        (tool) => descriptorDigest(tool.schema)!,
      ),
      "verificationContract.probeSuiteDigest": descriptorDigest(contract.probeSuite.descriptor)!,
      "verificationContract.observationSchemaDigest": descriptorDigest(contract.observationSchema)!,
      "verificationContract.baselineObservationDigest": contract.baselineObservationDigest,
      "verificationContract.comparatorDigest": contract.comparator.digest,
    };
  } catch {
    return {};
  }
};

/** v1's card plus the information worlds, the pinned images and miss body, and the lineage edge. */
export const cryptoEnvironmentRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await cryptoEnvironmentRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return {};
  try {
    const record = parseCryptoEnvironmentRecord(bytes);
    return {
      ...facts,
      informationWorldDigests: record.informationWorlds.map((world) => descriptorDigest(world.record)!),
      serviceRuntimeImageDigests: record.serviceRuntimes.map((runtime) => runtime.image.manifestDigest),
      ...present({
        "composition.missPolicy.bodyDigest": descriptorDigest(record.composition.missPolicy.body),
        supersedesDigest: descriptorDigest(record.supersedes),
      }),
    };
  } catch {
    return {};
  }
};

/**
 * v1's card plus the two components this record pins by digest: the world it re-captures and the
 * capturer that produced it. Its descriptors already carry the `sha256:` spelling.
 *
 * The corpus entries' response bodies are deliberately not edges. They are this record's own
 * content, enumerated inside its bytes and unbounded in number; putting them on the card would
 * defeat what a card is for -- filtering before retrieval -- and the record digest covers them.
 */
export const informationWorldRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await informationWorldRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return {};
  try {
    const record = parseInformationWorldRecord(bytes);
    return {
      ...facts,
      ...present({
        supersedesDigest: record.supersedes?.digest,
        "capture.capturerDigest": record.capture.capturer?.digest,
      }),
    };
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
    if (kind === INFORMATION_WORLD_KIND) return informationWorldRecompute;
    return undefined;
  },
};

/** Explicit registry for the coexisting v2 profiles. */
export const CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE_V2: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    if (kind === CHAIN_ENVIRONMENT_KIND) return chainEnvironmentRecomputeV2;
    if (kind === CRYPTO_ENVIRONMENT_KIND) return cryptoEnvironmentRecomputeV2;
    if (kind === INFORMATION_WORLD_KIND) return informationWorldRecomputeV2;
    return CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get(kind);
  },
};
