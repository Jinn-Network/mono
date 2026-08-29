import { validateAuthorization, validateKeyBinding, validateTrustPolicy } from "@jinn-network/trust-core";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import type { FactsRecompute, RecordFactRecompute } from "@jinn-network/record-discovery-protocol";

// Record-fact recompute (design §5.4, §10.4 step 2, program §7.13): each
// function recomputes its kind's record facts from the record's own sealed
// DSSE envelope BYTES via trust-core's structural `validate*` functions --
// never from a supplied projection. None of the three trust-layer kinds
// reference a *different* record's bytes for a labeled field (the
// reference-bearing fields below -- `supersedes`, `revocation`,
// `predecessor` -- are themselves digests embedded in the record's own
// statement, not values that require fetching another record to read), so
// `refs` (the second recompute parameter) is unused here.
//
// A non-conforming record (malformed bytes, or any unexpected validation
// failure) recomputes to no facts at all (`{}`), which `factsConsistency`
// (protocol) turns into `indeterminate` for every announced field -- never
// silently `consistent` (plan Task 13 Step 2).

function noFacts(): Record<string, never> {
  return {};
}

export const keyBindingRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const report = validateKeyBinding(bytes);
    if (!report.conforms || report.value === undefined) return noFacts();
    const { value } = report;
    return {
      agent: value.agent,
      keyid: value.key.keyid,
      algorithm: value.key.algorithm,
      relationship: value.relationship,
      strength: value.strength,
      validFrom: value.validFrom,
      ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
      ...(value.supersedes !== undefined ? { supersedes: value.supersedes } : {}),
    };
  } catch {
    return noFacts();
  }
};

export const authorizationRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const report = validateAuthorization(bytes);
    if (!report.conforms || report.value === undefined) return noFacts();
    const { predicate } = report.value;
    return {
      issuer: predicate.issuer,
      ...(predicate.audience !== undefined ? { audience: predicate.audience } : {}),
      expiry: predicate.expiry,
      ...(predicate.revocation !== undefined ? { revocation: predicate.revocation } : {}),
    };
  } catch {
    return noFacts();
  }
};

export const trustPolicyRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const report = validateTrustPolicy(bytes);
    if (!report.conforms || report.value === undefined) return noFacts();
    const { value } = report;
    return {
      version: value.version,
      refreshBy: value.refreshBy,
      ...(value.predecessor !== undefined ? { predecessor: value.predecessor } : {}),
    };
  } catch {
    return noFacts();
  }
};

// --- v2 revisions (join-edge completeness, protocol design §12 amendment 2026-08-28) --------
//
// Every added field is a digest the record states in its own sealed bytes, read through the same
// structural `validate*` path v1 uses, so `refs` stays unused. A subject descriptor and a
// ceremony reference carry bare-hex `digest.sha256`; they are lifted into the `sha256:` spelling
// every other digest fact on these cards already carries, so one card never mixes two spellings.
// Reference-bearing labels the indexing relation; it does not by itself promise the target is a
// retrievable announceable record (ceremony evidence and time anchors are artifacts, not records).

/** v1's card plus the ceremony evidence the binding rests on and the anchors it cites. */
export const keyBindingRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await keyBindingRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  try {
    const report = validateKeyBinding(bytes);
    if (!report.conforms || report.value === undefined) return noFacts();
    const { value } = report;
    return {
      ...facts,
      "ceremony.digest": value.ceremony.digest,
      anchorDigests: value.anchors.map((anchor) => anchor.digest),
    };
  } catch {
    return noFacts();
  }
};

/** v1's card plus the delegation chain it attenuates and the subjects it authorizes over. */
export const authorizationRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await authorizationRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  try {
    const report = validateAuthorization(bytes);
    if (!report.conforms || report.value === undefined) return noFacts();
    const { subject, predicate } = report.value;
    return {
      ...facts,
      subjectDigests: subject.map((descriptor) => `sha256:${descriptor.digest.sha256}` as const),
      ...(predicate.proofs !== undefined ? { proofs: predicate.proofs } : {}),
    };
  } catch {
    return noFacts();
  }
};

/** The leaf's `FactsRecompute` registry entry (program §7.13): the host
 * assembles the tree-wide registry by merging each leaf's export. */
export const TRUST_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    switch (kind) {
      case RECORD_KINDS.keyBinding:
        return keyBindingRecompute;
      case RECORD_KINDS.authorization:
        return authorizationRecompute;
      case RECORD_KINDS.trustPolicy:
        return trustPolicyRecompute;
      default:
        return undefined;
    }
  },
};

/**
 * Explicit registry for the coexisting Trust facts v2 profiles. `trust-policy` has no v2 — its
 * v1 outbound set was already complete — so it falls through to the v1 recompute.
 */
export const TRUST_FACTS_RECOMPUTE_V2: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    switch (kind) {
      case RECORD_KINDS.keyBinding:
        return keyBindingRecomputeV2;
      case RECORD_KINDS.authorization:
        return authorizationRecomputeV2;
      default:
        return TRUST_FACTS_RECOMPUTE.get(kind);
    }
  },
};
