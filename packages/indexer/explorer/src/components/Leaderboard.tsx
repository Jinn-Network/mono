/**
 * Leaderboard — shared sortable leaderboard table.
 *
 * Used by:
 *   - OperatorsView (full columns including dominantMode + dominantHarness)
 *   - SolverNetView (compact, no dominantMode/dominantHarness columns since
 *     the SolverNet boards don't carry those per-row)
 *
 * Columns:
 *   # (rank) | Operator | Resolved rate | Attempts | Settled | Verdicts | Mode? | Harness?
 *
 * Sort lives in URL-state via useEnumParam('sort', ...) + useEnumParam('dir', ...).
 * Low-volume rows are visually separated below the ranked rows.
 *
 * TODO(ebu7.<later>): virtualize rows when operator counts grow
 */

import { useState } from 'react';
import { Link } from 'wouter';
import type { RankedLeaderboardRow, LeaderboardRow } from '../lib/api';
import { DataTable, cellStyle, cellNumStyle, cellMutedStyle } from './DataTable';
import { StatusChip } from './StatusChip';
import { useEnumParam } from '../lib/url-state';
import { pct, int, shortAddr } from '../lib/format';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LeaderboardRankedRow = RankedLeaderboardRow & {
  dominantMode?: string;
  dominantHarness?: string;
};

export type LeaderboardLowVolumeRow = LeaderboardRow & {
  dominantMode?: string;
  dominantHarness?: string;
};

export interface LeaderboardProps {
  ranked: LeaderboardRankedRow[];
  lowVolume: LeaderboardLowVolumeRow[];
  minVerdicts?: number;
  /** compact — smaller padding, fewer optional columns (for SolverNet embedding) */
  compact?: boolean;
  /**
   * Optional click handler for operator cells. When present, the operator
   * cell body becomes a `<button>` that fires this handler with the operator
   * address; a trailing arrow cell renders a `<Link>` to /operator/<addr> as
   * the secondary navigation affordance. When absent (default), the operator
   * cell stays a single `<Link>` to /operator/<addr>.
   */
  onOperatorClick?: (operator: string) => void;
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

type SortKey =
  | 'rank'
  | 'resolvedRate'
  | 'attempts'
  | 'settledContribution'
  | 'verdicts'
  | 'operator';

const SORT_KEYS: SortKey[] = [
  'rank',
  'resolvedRate',
  'attempts',
  'settledContribution',
  'verdicts',
  'operator',
];

function sortRows<T extends LeaderboardRow & { rank?: number }>(
  rows: T[],
  sortKey: SortKey,
  dir: 'asc' | 'desc',
): T[] {
  const sorted = [...rows].sort((a, b) => {
    let av: number | string;
    let bv: number | string;

    switch (sortKey) {
      case 'rank':
        av = (a as LeaderboardRankedRow).rank ?? 9999;
        bv = (b as LeaderboardRankedRow).rank ?? 9999;
        break;
      case 'resolvedRate':
        // null resolvedRate = lowest (treat as -1 so it sinks to bottom)
        av = a.resolvedRate ?? -1;
        bv = b.resolvedRate ?? -1;
        break;
      case 'attempts':
        av = a.attempts;
        bv = b.attempts;
        break;
      case 'settledContribution':
        av = a.settledContribution;
        bv = b.settledContribution;
        break;
      case 'verdicts':
        av = a.verdictsTotal;
        bv = b.verdictsTotal;
        break;
      case 'operator':
        av = a.operator.toLowerCase();
        bv = b.operator.toLowerCase();
        break;
      default:
        return 0;
    }

    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

export function Leaderboard({
  ranked,
  lowVolume,
  minVerdicts,
  compact = false,
  onOperatorClick,
}: LeaderboardProps) {
  // Sort lives in URL-state so it's a permalink
  const [sortKey, setSortKey] = useEnumParam('sort', 'resolvedRate', SORT_KEYS);
  const [sortDir, setSortDir] = useEnumParam('dir', 'desc', ['asc', 'desc']);

  // Hover state — tracks which operator row is currently hovered so we can
  // surface the "→ filter to this" hint on the active row only. Pattern A
  // (inline state + opacity) keeps consistency with the rest of this file,
  // which uses no CSS rules.
  const [hoveredOperator, setHoveredOperator] = useState<string | null>(null);

  function handleSort(key: string) {
    if (key === sortKey) {
      // Toggle direction
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  // Determine whether to show optional columns from the data itself
  const hasMode = ranked.some((r) => r.dominantMode !== undefined) ||
    lowVolume.some((r) => r.dominantMode !== undefined);
  const hasHarness = ranked.some((r) => r.dominantHarness !== undefined) ||
    lowVolume.some((r) => r.dominantHarness !== undefined);

  // Sort ranked rows; keep lowVolume in server order (or sort the same way)
  const sortedRanked = sortRows(ranked, sortKey as SortKey, sortDir as 'asc' | 'desc');
  const sortedLowVolume = sortRows(lowVolume, sortKey as SortKey, sortDir as 'asc' | 'desc');

  // Build columns conditionally
  const columns = [
    { key: 'rank', label: '#', sortable: true, width: compact ? 32 : 40 },
    { key: 'operator', label: 'Operator' },
    { key: 'resolvedRate', label: 'Resolved', numeric: true },
    { key: 'attempts', label: 'Attempts', numeric: true },
    { key: 'settledContribution', label: 'Settled', numeric: true },
    { key: 'verdicts', label: 'Pass / Total', numeric: true },
    ...(hasMode && !compact ? [{ key: 'mode', label: 'Mode', sortable: false }] : []),
    ...(hasHarness && !compact ? [{ key: 'harness', label: 'Harness', sortable: false }] : []),
    ...(onOperatorClick ? [{ key: 'opLink', label: '', sortable: false, width: 24 }] : []),
  ];

  // Low-volume label includes the threshold when available
  const lvLabel = minVerdicts !== undefined
    ? `New / Low-volume (< ${minVerdicts} verdicts)`
    : 'New / Low-volume';

  const operatorTextStyle = {
    color: 'var(--accent)',
    fontFamily: 'var(--font-mono)',
    fontSize: compact ? 11 : 12,
  } as const;

  // Row renderer factory — handles both ranked and low-volume rows
  function renderRow(row: LeaderboardRankedRow | LeaderboardLowVolumeRow) {
    const ranked = row as LeaderboardRankedRow;
    const rankVal = 'rank' in ranked && ranked.rank !== undefined ? ranked.rank : null;

    const resolvedColor =
      row.resolvedRate !== null && row.resolvedRate >= 0.9
        ? 'var(--vow-green)'
        : row.resolvedRate !== null && row.resolvedRate < 0.5
          ? 'var(--wane)'
          : 'var(--fg)';

    return (
      <>
        {/* # rank */}
        <td
          style={{
            ...cellMutedStyle,
            width: compact ? 32 : 40,
            fontVariantNumeric: 'tabular-nums',
            padding: compact ? '8px 12px' : undefined,
          }}
        >
          {rankVal !== null ? rankVal : '—'}
        </td>

        {/* Operator */}
        <td style={{ ...cellStyle, padding: compact ? '8px 12px' : undefined }}>
          {onOperatorClick ? (
            <button
              type="button"
              onClick={() => onOperatorClick(row.operator)}
              onMouseEnter={() => setHoveredOperator(row.operator)}
              onMouseLeave={() =>
                setHoveredOperator((prev) =>
                  prev === row.operator ? null : prev,
                )
              }
              onFocus={() => setHoveredOperator(row.operator)}
              onBlur={() =>
                setHoveredOperator((prev) =>
                  prev === row.operator ? null : prev,
                )
              }
              style={{
                ...operatorTextStyle,
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              {shortAddr(row.operator)}
              <span
                data-hover-hint="true"
                className="leaderboard-row-hint"
                style={{
                  marginLeft: 6,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 8,
                  letterSpacing: '0.04em',
                  color: 'var(--fg-dim)',
                  opacity: hoveredOperator === row.operator ? 1 : 0,
                  transition: 'opacity 80ms linear',
                  pointerEvents: 'none',
                }}
              >
                → filter to this
              </span>
            </button>
          ) : (
            <Link
              href={`/operator/${encodeURIComponent(row.operator)}`}
              style={{ ...operatorTextStyle, textDecoration: 'none' }}
            >
              {shortAddr(row.operator)}
            </Link>
          )}
        </td>

        {/* Resolved rate — bold, quality headline */}
        <td
          className="data"
          style={{
            ...cellNumStyle,
            fontWeight: 600,
            color: resolvedColor,
            padding: compact ? '8px 12px' : undefined,
          }}
        >
          {pct(row.resolvedRate)}
        </td>

        {/* Attempts */}
        <td className="data" style={{ ...cellNumStyle, padding: compact ? '8px 12px' : undefined }}>
          {int(row.attempts)}
        </td>

        {/* Settled contribution */}
        <td className="data" style={{ ...cellNumStyle, padding: compact ? '8px 12px' : undefined }}>
          {int(row.settledContribution)}
        </td>

        {/* Verdicts pass / total */}
        <td className="data" style={{ ...cellNumStyle, padding: compact ? '8px 12px' : undefined }}>
          {int(row.verdictsPass)}&thinsp;/&thinsp;{int(row.verdictsTotal)}
        </td>

        {/* Mode (conditional) */}
        {hasMode && !compact && (
          <td style={{ ...cellStyle }}>
            {row.dominantMode ? (
              <StatusChip
                kind={row.dominantMode as 'train' | 'frozen' | 'unknown'}
                label={row.dominantMode}
              />
            ) : (
              <span style={{ color: 'var(--fg-dim)' }}>—</span>
            )}
          </td>
        )}

        {/* Harness (conditional) */}
        {hasHarness && !compact && (
          <td
            style={{
              ...cellStyle,
              color: 'var(--fg-muted)',
              fontSize: 11,
            }}
          >
            {row.dominantHarness ?? '—'}
          </td>
        )}

        {/* Trailing arrow link → operator detail.
            Rendered only when onOperatorClick re-purposes the body cell. */}
        {onOperatorClick && (
          <td
            style={{
              ...cellStyle,
              padding: compact ? '8px 8px' : undefined,
              textAlign: 'right',
            }}
          >
            <Link
              href={`/operator/${encodeURIComponent(row.operator)}`}
              aria-label="Open operator detail"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--fg-muted)',
                textDecoration: 'none',
              }}
            >
              ↗
            </Link>
          </td>
        )}
      </>
    );
  }

  return (
    <DataTable
      columns={columns}
      rows={sortedRanked}
      sortKey={sortKey}
      sortDir={sortDir as 'asc' | 'desc'}
      onSort={handleSort}
      renderRow={(row) => renderRow(row as LeaderboardRankedRow)}
      lowVolumeRows={sortedLowVolume}
      lowVolumeLabel={lvLabel}
      emptyState={
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--fg-dim)',
          }}
        >
          No ranked operators yet.
        </span>
      }
    />
  );
}
