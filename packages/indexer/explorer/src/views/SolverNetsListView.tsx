/**
 * SolverNetsListView — list of all indexed SolverNets.
 *
 * No gold accent on this surface (rule: one per surface; none needed here).
 * Sort via URL state (sort + dir params).
 * Each row links to /solvernet/:cid.
 */

import { Link } from 'wouter';
import { useSolverNets } from '../lib/api';
import type { SolverNetRow } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { StatusChip } from '../components/StatusChip';
import { DataTable } from '../components/DataTable';
import { cellStyle, cellNumStyle, cellMutedStyle } from '../components/DataTable';
import { Sparkline } from '../components/Sparkline';
import { useEnumParam } from '../lib/url-state';
import { pct, int, shortCid, relTime } from '../lib/format';

// ── Sort ──────────────────────────────────────────────────────────────────────

type SortKey = 'resolvedRate' | 'tasksPosted' | 'attempts' | 'verdicts' | 'cid';

function sortRows(
  rows: SolverNetRow[],
  key: SortKey,
  dir: 'asc' | 'desc',
): SolverNetRow[] {
  const factor = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    let av: number | string | null;
    let bv: number | string | null;

    switch (key) {
      case 'resolvedRate':
        av = a.resolvedRate;
        bv = b.resolvedRate;
        // nulls last
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av - bv) * factor;
      case 'tasksPosted':
        return (a.tasksPosted - b.tasksPosted) * factor;
      case 'attempts':
        return (a.attempts - b.attempts) * factor;
      case 'verdicts':
        return (a.verdicts - b.verdicts) * factor;
      case 'cid':
        return a.cid.localeCompare(b.cid) * factor;
      default:
        return 0;
    }
  });
}

// ── Columns ───────────────────────────────────────────────────────────────────

const COLUMNS = [
  { key: 'cid', label: 'SolverNet', sortable: true },
  { key: 'status', label: 'Status', sortable: false },
  { key: 'launcherAgentId', label: 'Launcher', sortable: false },
  { key: 'statusUpdatedAt', label: 'Updated', sortable: false },
  { key: 'tasksPosted', label: 'Tasks', numeric: true, sortable: true },
  { key: 'tasksSettled', label: 'Settled', numeric: true, sortable: false },
  { key: 'attempts', label: 'Attempts', numeric: true, sortable: true },
  { key: 'verdicts', label: 'Verdicts', numeric: true, sortable: true },
  { key: 'resolvedRate', label: 'Resolved', numeric: true, sortable: true },
  // Trend sparkline — not sortable (visual only)
  { key: 'trend', label: 'Trend', sortable: false },
];

// ── Row renderer ──────────────────────────────────────────────────────────────

function renderRow(row: SolverNetRow) {
  return (
    <>
      <td style={cellStyle}>
        <Link
          href={`/solvernet/${encodeURIComponent(row.cid)}`}
          style={{
            color: 'var(--accent)',
            textDecoration: 'none',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
        >
          {shortCid(row.cid)}
        </Link>
      </td>
      <td style={cellStyle}>
        <StatusChip
          kind={row.status as 'launched' | 'paused' | 'retired'}
          label={row.status}
        />
      </td>
      <td
        style={{
          ...cellMutedStyle,
          maxWidth: 120,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.launcherAgentId
          ? row.launcherAgentId.slice(0, 10) + '…'
          : '—'}
      </td>
      <td style={cellMutedStyle}>{relTime(row.statusUpdatedAt)}</td>
      <td className="data" style={cellNumStyle}>{int(row.tasksPosted)}</td>
      <td className="data" style={cellNumStyle}>{int(row.tasksSettled)}</td>
      <td className="data" style={cellNumStyle}>{int(row.attempts)}</td>
      <td className="data" style={cellNumStyle}>{int(row.verdicts)}</td>
      <td
        className="data"
        style={{
          ...cellNumStyle,
          color:
            row.resolvedRate !== null && row.resolvedRate >= 0.9
              ? 'var(--vow-green)'
              : row.resolvedRate !== null && row.resolvedRate < 0.5
                ? 'var(--wane)'
                : 'var(--fg)',
        }}
      >
        {pct(row.resolvedRate)}
      </td>
      {/* Trend sparkline — visual only, not sortable */}
      <td
        style={{
          ...cellStyle,
          width: 72,
          paddingTop: 0,
          paddingBottom: 0,
          verticalAlign: 'middle',
        }}
      >
        <Sparkline data={row.recentResolvedRateSeries} />
      </td>
    </>
  );
}

// ── SolverNetsListView ────────────────────────────────────────────────────────

export function SolverNetsListView() {
  const { data, isLoading, isError, refetch } = useSolverNets();

  const [sort, setSort] = useEnumParam('sort', 'resolvedRate', [
    'resolvedRate',
    'tasksPosted',
    'attempts',
    'verdicts',
    'cid',
  ]);
  const [dir, setDir] = useEnumParam('dir', 'desc', ['asc', 'desc']);

  function handleSort(key: string) {
    if (key === sort) {
      setDir(dir === 'desc' ? 'asc' : 'desc');
    } else {
      setSort(key);
      setDir('desc');
    }
  }

  const sorted = data
    ? sortRows(data.solvernets, sort as SortKey, dir as 'asc' | 'desc')
    : [];

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      {/* Page header */}
      <div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            fontSize: 'var(--text-4xl)',
            lineHeight: 1.05,
            color: 'var(--fg)',
            margin: 0,
            marginBottom: 4,
            fontWeight: 400,
          }}
        >
          SolverNets
        </h1>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-dim)',
          }}
        >
          {data ? `${data.solvernets.length} indexed` : 'loading…'}
        </div>
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-3)',
            overflow: 'hidden',
          }}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              style={{
                padding: '14px 16px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                display: 'flex',
                gap: 16,
                background: 'var(--bg-elevated)',
              }}
            >
              {Array.from({ length: 10 }).map((__, j) => (
                <div
                  key={j}
                  style={{
                    height: 14,
                    flex: j === 0 ? 2 : 1,
                    background: 'var(--bg-sunken)',
                    borderRadius: 'var(--radius-1)',
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--break-red)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <span>Failed to load SolverNets.</span>
          <button
            onClick={() => void refetch()}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--break-red)',
              border: '1px solid currentColor',
              borderRadius: 'var(--radius-1)',
              padding: '4px 10px',
              cursor: 'pointer',
              background: 'transparent',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Data table */}
      {data && (
        <DataTable
          columns={COLUMNS}
          rows={sorted}
          sortKey={sort}
          sortDir={dir as 'asc' | 'desc'}
          onSort={handleSort}
          renderRow={(row) => renderRow(row as SolverNetRow)}
          emptyState="No SolverNets indexed yet."
        />
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        degraded={isError}
      />
    </div>
  );
}
