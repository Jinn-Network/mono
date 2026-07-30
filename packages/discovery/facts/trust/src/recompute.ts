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
