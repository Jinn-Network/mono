/** Cheap eligibility candidate-verdict (architecture §5). Pure over the
 *  SessionOutcome facts the core already holds. Authoritative validation
 *  (Docker F2P/P2P, resolvable repo@commit) stays sidecar-side. */
import type { EligibilityVerdict } from './schemas/eligibility-verdict.js';

export interface EligibilityInputs {
  status: 'completed' | 'failed' | 'abandoned';
  verifiabilityTier: 'user-accepted' | 'tests-passed' | 'evaluator-verified';
  retentionPolicy: 'local-private' | 'contribution-eligible';
  publicRepo?: boolean;
  acceptedDiff?: boolean;
}

export function deriveEligibility(input: EligibilityInputs, checkedAt: string): EligibilityVerdict {
  if (input.status !== 'completed') {
    return { eligible: false, reason: 'outcome not completed', checkedAt };
  }
  if (input.retentionPolicy !== 'contribution-eligible') {
    return { eligible: false, reason: 'retention is local-private', checkedAt };
  }
  if (!input.acceptedDiff && !input.publicRepo) {
    return { eligible: false, reason: 'no accepted diff signal', checkedAt };
  }
  return { eligible: true, reason: 'completed with accepted-diff/public-repo signal', checkedAt };
}
