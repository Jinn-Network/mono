/**
 * Policy-admission hook (issue #1824, corpus-supply-design §5, charter
 * Decision 4 amendment): the intended publish-time chokepoint marking
 * producers call before building distributionTags. Declared policies decide
 * from record facts (verdict, evidence tier, tags, freshness, provenance);
 * hand-marking (HAND_MARK_POLICY, 'hand.v0') is the day-one policy and
 * admits nothing — the mark is set iff the curator explicitly requested it.
 * Not yet wired into a producer: day-one hand-marking happens by the curated
 * seed lane carrying RETRIEVAL_VISIBLE_TAG in the episode's own tags
 * (seed-import/episode-execute.ts passes them through as distributionTags).
 * Producers adopt this chokepoint when the first fact-based policy lands
 * (B2+); enforcement (pickup ranking + post-fetch guard) needs no change.
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
