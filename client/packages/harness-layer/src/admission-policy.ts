/**
 * Policy-admission hook (issue #1824, corpus-supply-design §5, charter
 * Decision 4 amendment): one publish-time chokepoint every marking producer
 * calls before building distributionTags. Declared policies decide from
 * record facts (verdict, evidence tier, tags, freshness, provenance);
 * hand-marking (HAND_MARK_POLICY, 'hand.v0') is the day-one policy and
 * admits nothing — the mark is set iff the curator explicitly requested it.
 * Future fact-based policies (e.g. verdict passed AND tier >= committed AND
 * fresh) swap in at this same chokepoint with no enforcement-side change.
 */
export interface AdmissionFacts {
  verdict?: 'passed' | 'failed' | 'unknown';
  evidenceTier?: string;
  tags?: readonly string[];
  capturedAt?: string;
  provenance?: 'imported' | 'contributed';
}

export interface AdmissionPolicy {
  name: string;
  admit(facts: AdmissionFacts): boolean;
}

/** Day-one policy (#1824): admits nothing automatically. Marking authority
 *  stays at publish time, by the curator's explicit request only. */
export const HAND_MARK_POLICY: AdmissionPolicy = {
  name: 'hand.v0',
  admit: () => false,
};

/**
 * The chokepoint: `explicit` is the curator's hand-mark request; `policy`
 * decides from `facts` when `explicit` is not itself true. Explicit wins
 * outright — a policy can only ADD admission, never withdraw a curator's
 * explicit request.
 */
export function resolveRetrievalMark(args: {
  explicit?: boolean;
  facts: AdmissionFacts;
  policy: AdmissionPolicy;
}): boolean {
  if (args.explicit === true) return true;
  return args.policy.admit(args.facts);
}
