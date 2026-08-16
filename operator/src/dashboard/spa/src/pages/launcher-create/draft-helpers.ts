import type { DraftWizardStep, DraftSolverNetRecord } from '../../../../../api/contract/index.js';

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
 * as `—`. Never use scientific notation for user-facing amounts.
 */
export function formatEthFromWei(wei: string | undefined): string {
  if (!wei || !/^\d+$/.test(wei)) return '—';
  try {
    const n = BigInt(wei);
    if (n === 0n) return '0 ETH';
    const oneEth = 1_000_000_000_000_000_000n;
    const oneTenThousandthEth = 100_000_000_000_000n;
    const oneGwei = 1_000_000_000n;

    if (n >= oneTenThousandthEth) {
      return `${formatDecimalUnits(n, 18, n >= oneEth ? 4 : 6)} ETH`;
    }
    if (n >= oneGwei) {
      return `${formatDecimalUnits(n, 9, 4)} gwei`;
    }
    return `${n.toLocaleString()} wei`;
  } catch {
    return '—';
  }
}

function formatDecimalUnits(
  value: bigint,
  decimals: number,
  maxFractionDigits: number,
): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n || maxFractionDigits === 0) return whole.toString();

  const rawFraction = fraction.toString().padStart(decimals, '0');
  const trimmed = rawFraction
    .slice(0, maxFractionDigits)
    .replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
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
