import type { DraftWizardStep, DraftSolverNetRecord } from '../../api/types.js';

/**
 * Append `step` to `completedSteps` if not already present. The wizard
 * uses this to mark a step complete on Next without ever shrinking the
 * list — Back navigation preserves prior progress so the operator can
 * jump forward without re-entering everything.
 */
export function ensureCompletedStep(
  steps: DraftSolverNetRecord['completedSteps'] | undefined,
  step: DraftWizardStep,
): DraftSolverNetRecord['completedSteps'] {
  const list = steps ?? [];
  if (list.includes(step)) return list;
  return [...list, step];
}

/**
 * Format wei → ETH (decimal) for helper text. Non-numeric strings render
 * as `—`.
 */
export function formatEthFromWei(wei: string | undefined): string {
  if (!wei || !/^\d+$/.test(wei)) return '—';
  try {
    const n = BigInt(wei);
    const eth = Number(n) / 1e18;
    if (eth === 0) return '0 ETH';
    if (eth < 0.0001) return `${eth.toExponential(3)} ETH`;
    return `${eth.toFixed(eth < 1 ? 6 : 4)} ETH`;
  } catch {
    return '—';
  }
}

/**
 * Parse a numeric string to a BigInt for wei amounts. Returns `null` on
 * empty input, throws on a non-numeric string. The caller decides how to
 * surface invalid input.
 */
export function parseWei(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) throw new Error('not a non-negative integer');
  return BigInt(trimmed);
}
