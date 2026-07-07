import type {
  LaunchedStatus,
  LaunchedSolverNetRecord,
} from '../../api/types.js';

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
 * transition table in `client/src/solvernets/lifecycle.ts`. Used by
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
 * Compute the projected number of Tasks the Safe can fund given
 * `solutionPriceWei + verdictPriceWei` per Task. Returns `null` when inputs
 * are missing or non-numeric. SpendPanel uses this to render runway.
 */
export function projectRunwayTasks(
  safeBalanceWei: string | null | undefined,
  solutionPriceWei: string | undefined,
  verdictPriceWei: string | undefined,
): { tasks: number; perTaskWei: bigint } | null {
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
  const perTaskWei = BigInt(solutionPriceWei) + BigInt(verdictPriceWei);
  if (perTaskWei <= 0n) return null;
  const tasks = Number(bal / perTaskWei);
  return { tasks, perTaskWei };
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
