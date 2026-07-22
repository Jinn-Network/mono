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

/**
 * Operator-environment failures that may appear as thrown `infraError` *or*
 * as `mineSessionEchoes` rejection reasons (admission catches
 * `EvalCouldNotGradeError` / disk errors into `ungradeable:` / `error:` /
 * `transient:` buckets rather than always throwing).
 *
 * Deliberately excludes patch/product reasons (`patch_does_not_apply`,
 * `pytest_missing`, `gold-patch-not-resolved`, …) — those stay
 * `rejected:other`.
 */
const INFRA_REASON_RE =
  /(?:^|[\s(:])(?:ungradeable:|transient:|error:)?(?:docker_(?:unavailable|credentials_error|storage_io_error|run_failed)|image_pull_failed|image_arch_mismatch|venv_(?:missing|collision))(?:\b|$)|insufficient disk/i;

function looksLikeInfra(text: string | undefined): boolean {
  if (!text) return false;
  return INFRA_REASON_RE.test(text);
}

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
  if (looksLikeInfra(reason)) {
    return { classification: 'infra-blocked', hypothesisHolds: null };
  }
  if (EMPIRICAL_DEAD_RE.test(reason)) {
    return {
      classification: 'rejected:empirical-dead',
      hypothesisHolds: input.mode === 'borrow-mismatch' ? true : false,
    };
  }
  return {
    classification: 'rejected:other',
    // Zero-yield that is not empirical-dead: hypothesis neither confirmed nor
    // disproven (disproven only by admit-under-mismatch).
    hypothesisHolds: null,
  };
}
