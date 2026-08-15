import type {
  LaunchedStatus,
  LaunchedSolverNetRecord,
} from '../../../../../api/contract/index.js';

/**
 * Shared helpers for the post-launch dashboard panels (Task 19).
 *
 * Lifts the small formatting utilities the launcher-list page already uses
 * (`Launcher.tsx`) into a reusable module so the four panels can share the
 * truncation and timestamp rendering rules.
 */

export const STATUS_TONE: Record<
  LaunchedStatus,
  { fg: string; border: string; bg?: string; label: string }
> = {
  launching: {
    fg: 'var(--accent-sky)',
    border: 'var(--accent-sky)',
    label: 'Launching',
  },
  launched: {
    fg: 'var(--vow-green)',
    border: 'var(--vow-green)',
    label: 'Launched',
  },
  paused: { fg: 'var(--wane)', border: 'var(--wane)', label: 'Paused' },
  retired: { fg: 'var(--fg-dim)', border: 'var(--border)', label: 'Retired' },
  failed: { fg: 'var(--break-red)', border: 'var(--break-red)', label: 'Failed' },
};

export function truncateCid(cid: string): string {
  if (!cid) return '';
  if (cid.length <= 16) return cid;
  return `${cid.slice(0, 8)}…${cid.slice(-6)}`;
}

export function truncateAddress(addr: string): string {
  if (!addr) return '';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return iso;
  }
}

/**
 * Allowed lifecycle transitions per `LaunchedStatus`. Mirrors the daemon-side
 * transition table in `operator/src/solvernets/lifecycle.ts`. Used by
 * `StatusHeader` to decide which buttons to render.
 */
export const ALLOWED_TRANSITIONS: Partial<
  Record<LaunchedStatus, ReadonlyArray<'launched' | 'paused' | 'retired'>>
> = {
  launched: ['paused', 'retired'],
  paused: ['launched', 'retired'],
};

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

/** Wei → a human-readable token amount. Never uses scientific notation. */
export function formatWeiAmount(wei: string | undefined): string {
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

/**
 * Expected gas cost of an average Safe `execTransaction` claim tx, folded into
 * the per-Task runway so the projection is not wildly optimistic (#573).
 *
 * No live gas feed reaches the SPA, so these are deliberately conservative
 * SPA-side constants rather than a plumbed estimate — they err toward a SHORTER
 * runway. At submit-time the daemon estimates the real claim fee dynamically
 * (viem gas estimation in `operator/src/adapters/mech/safe.ts`, which holds no
 * such magnitudes); revisit these constants if that path's behaviour changes.
 *
 *   CLAIM_TX_GAS        — 175,000 gas, mid of the 150k–200k execTransaction range.
 *   CLAIM_GAS_PRICE_WEI — 0.0115 gwei, chosen so claim gas ≈ 2,000 gwei/claim
 *                         (175,000 × 11,500,000 = 2,012,500,000,000 wei).
 */
export const CLAIM_TX_GAS = 175000n;
export const CLAIM_GAS_PRICE_WEI = 11_500_000n;
export const DEFAULT_CLAIM_GAS_WEI = CLAIM_TX_GAS * CLAIM_GAS_PRICE_WEI;

/** Runway below this many Tasks surfaces a low-runway state message (#573). */
export const LOW_RUNWAY_TASKS = 100;

/**
 * Compute the projected number of Tasks the Safe can fund. Per-Task cost is
 * `solutionPriceWei + verdictPriceWei + claimGasWei`, where `claimGasWei`
 * defaults to the expected claim-tx gas (`DEFAULT_CLAIM_GAS_WEI`). Excluding
 * the gas term was the #573 bug. Returns `null` when inputs are missing or
 * non-numeric. `lowRunway` is true when `tasks < LOW_RUNWAY_TASKS`.
 */
export function projectRunwayTasks(
  safeBalanceWei: string | null | undefined,
  solutionPriceWei: string | undefined,
  verdictPriceWei: string | undefined,
  claimGasWei: bigint = DEFAULT_CLAIM_GAS_WEI,
): { tasks: number; perTaskWei: bigint; lowRunway: boolean } | null {
  if (
    !safeBalanceWei ||
    !/^\d+$/.test(safeBalanceWei) ||
    !solutionPriceWei ||
    !/^\d+$/.test(solutionPriceWei) ||
    !verdictPriceWei ||
    !/^\d+$/.test(verdictPriceWei)
  ) {
    return null;
  }
  let bal: bigint;
  try {
    bal = BigInt(safeBalanceWei);
  } catch {
    return null;
  }
  const perTaskWei =
    BigInt(solutionPriceWei) + BigInt(verdictPriceWei) + claimGasWei;
  if (perTaskWei <= 0n) return null;
  const tasks = Number(bal / perTaskWei);
  return { tasks, perTaskWei, lowRunway: tasks < LOW_RUNWAY_TASKS };
}

/**
 * Convenience: a `LaunchedSolverNetRecord` is "terminal" when no further
 * lifecycle action is meaningful. The dashboard renders read-only state in
 * this case.
 */
export function isTerminalStatus(status: LaunchedStatus): boolean {
  return status === 'retired' || status === 'failed';
}

export function statusOf(record: LaunchedSolverNetRecord | undefined): LaunchedStatus | undefined {
  return record?.status;
}
