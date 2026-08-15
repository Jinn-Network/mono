/**
 * R2 task-complexity-weighted escrow for swe-rebench-v2 Tasks.
 *
 * escrowWei = base × clamp(1 + α × normLoc + β × normFiles + γ × normTests, [1, MAX])
 *
 * normalisers turn raw counts into [0, 1]-ish ranges; α, β, γ are weights
 * declared in the launched-instance manifest.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §8
 * DR: log/decisions/2026-05-06-reward-function-complexity-weighted.md (R2)
 */

export interface EscrowParams {
  base_escrow_wei: bigint;
  alpha: number;
  beta: number;
  gamma: number;
  loc_normalizer: number;
  files_normalizer: number;
  tests_normalizer: number;
}

export interface EscrowInputs {
  loc: number;
  files: number;
  tests: number;
  params: EscrowParams;
}

const MAX_MULTIPLIER = 5n;

export function computeEscrowWei(input: EscrowInputs): bigint {
  const { loc, files, tests, params } = input;
  const normLoc = loc / params.loc_normalizer;
  const normFiles = files / params.files_normalizer;
  const normTests = tests / params.tests_normalizer;
  const multiplier = 1 + params.alpha * normLoc + params.beta * normFiles + params.gamma * normTests;
  // 18-decimal scaled multiplier
  const scaled = BigInt(Math.round(multiplier * 1e6));
  const result = (params.base_escrow_wei * scaled) / 1_000_000n;
  // Cap at MAX_MULTIPLIER × base
  const cap = MAX_MULTIPLIER * params.base_escrow_wei;
  return result > cap ? cap : result;
}

/** D1: minted tasks use complexity-weighted escrow when eligibility requests it. */
export function resolveMintedTaskDeliveryRate(
  defaultRate: bigint,
  eligibility: Record<string, unknown> | undefined,
): bigint {
  if (!eligibility?.['syntheticEscrow']) return defaultRate;
  const inputs = eligibility['syntheticEscrowInputs'] as
    | { loc: number; files: number; tests: number }
    | undefined;
  const weights = eligibility['syntheticEscrowParams'] as
    | Omit<EscrowParams, 'base_escrow_wei'>
    | undefined;
  if (!inputs || !weights) return defaultRate;
  return computeEscrowWei({
    ...inputs,
    params: { base_escrow_wei: defaultRate, ...weights },
  });
}
