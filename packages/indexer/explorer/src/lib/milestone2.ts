/**
 * Milestone 2 gate — the #647 acceptance condition, computed from the slice
 * engine's per-verdict rolling resolved-rate series.
 *
 * #647: on the swe-rebench-v2 SolverNet at harness=codex + model=gpt-5.4-mini,
 * the trailing-30 envelope verdict-success rate over the most recent 30
 * verdicts must be >= 10pp above its value over the 30 verdicts ending 99
 * verdicts earlier, with >= 130 envelope-enriched verdicts.
 *
 * `rolling[i]` is the trailing-window resolved-rate ending at verdict `i`
 * (see `rollingResolvedRate` in the indexer's metrics module). So the current
 * trailing-window rate is `rolling[n-1]` and the t-99 baseline is
 * `rolling[n-100]`. MILESTONE2_OFFSET mirrors SliceChrome's MILESTONE_OFFSET so
 * the chart hairline and this gate read the same index.
 *
 * This gate is a literal read of the #647 condition — distinct from the chart's
 * dashed reference line, which draws the *lifetime* resolved-rate, not the
 * trailing-window rate at t-99.
 */

export const MILESTONE2_FLOOR = 130;
export const MILESTONE2_OFFSET = 100;
export const MILESTONE2_GATE_PP = 10;
export const MILESTONE2_WINDOW = 30;

/**
 * The milestone is defined for one specific SolverNet + harness + model (#647).
 * The gate card only renders on this net; the slice it reads is pinned to this
 * harness/model/window so the user's exploration controls can't shift it.
 */
export const MILESTONE2_MANIFEST_CID =
  'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi';
export const MILESTONE2_HARNESS = 'codex';
export const MILESTONE2_MODEL = 'gpt-5.4-mini';

export type Milestone2Status = 'pass' | 'below' | 'ineligible';

export interface Milestone2Gate {
  status: Milestone2Status;
  /** Total envelope-enriched verdicts in the series (= rolling.length). */
  verdicts: number;
  /** Eligibility floor (MILESTONE2_FLOOR). */
  floor: number;
  /** verdicts >= floor. */
  eligible: boolean;
  /** Current trailing-window resolved-rate (rolling[n-1]); null when ineligible. */
  current: number | null;
  /** Trailing-window resolved-rate at t-99 (rolling[n-100]); null when ineligible. */
  baseline: number | null;
  /** (current - baseline) in percentage points; null when ineligible. */
  deltaPp: number | null;
  /** Gate the delta must clear (MILESTONE2_GATE_PP). */
  gatePp: number;
}

/**
 * Compute the Milestone 2 gate from a per-verdict trailing-window rolling
 * resolved-rate series (already filtered to the M2 harness+model+window slice).
 */
export function computeMilestone2Gate(rolling: number[]): Milestone2Gate {
  const verdicts = rolling.length;
  const eligible = verdicts >= MILESTONE2_FLOOR;
  const base = {
    verdicts,
    floor: MILESTONE2_FLOOR,
    eligible,
    gatePp: MILESTONE2_GATE_PP,
  };

  if (!eligible) {
    return { ...base, status: 'ineligible', current: null, baseline: null, deltaPp: null };
  }

  const current = rolling[verdicts - 1];
  const baseline = rolling[verdicts - MILESTONE2_OFFSET];
  const deltaPp = (current - baseline) * 100;
  // Epsilon guards the exact-gate boundary against float error.
  const status: Milestone2Status = deltaPp >= MILESTONE2_GATE_PP - 1e-9 ? 'pass' : 'below';

  return { ...base, status, current, baseline, deltaPp };
}
