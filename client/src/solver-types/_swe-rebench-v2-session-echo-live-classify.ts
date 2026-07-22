export type SessionEchoLiveMode = 'borrow-mismatch' | 'borrow-aligned';

export type SessionEchoLiveClassification =
  | 'admitted'
  | 'rejected:empirical-dead'
  | 'rejected:other'
  | 'infra-blocked';

export interface SessionEchoLiveClassifyInput {
  mode: SessionEchoLiveMode;
  admitted: string[];
  rejected: Array<{ instance_id: string; reason: string }>;
  /** Set when the attempt never reached a clean mint classification (prereq or runner infra). */
  infraError?: string;
}

export interface SessionEchoLiveClassifyResult {
  classification: SessionEchoLiveClassification;
  /** True when borrow-mismatch produced empirical-dead (hypothesis confirmed). Null when N/A. */
  hypothesisHolds: boolean | null;
  redFlag?: string;
}

const EMPIRICAL_DEAD_RE = /empirical-dead/i;

export function classifySessionEchoLiveResult(
  input: SessionEchoLiveClassifyInput,
): SessionEchoLiveClassifyResult {
  if (input.infraError) {
    return { classification: 'infra-blocked', hypothesisHolds: null };
  }
  if (input.admitted.length > 0) {
    if (input.mode === 'borrow-mismatch') {
      return {
        classification: 'admitted',
        hypothesisHolds: false,
        redFlag:
          'worse-than-hypothesized: admitted under borrow-mismatch (borrowed tests are not the session tests)',
      };
    }
    return { classification: 'admitted', hypothesisHolds: null };
  }
  const reason = input.rejected[0]?.reason ?? '';
  if (EMPIRICAL_DEAD_RE.test(reason)) {
    return {
      classification: 'rejected:empirical-dead',
      hypothesisHolds: input.mode === 'borrow-mismatch' ? true : false,
    };
  }
  return {
    classification: 'rejected:other',
    hypothesisHolds: input.mode === 'borrow-mismatch' ? false : null,
  };
}
