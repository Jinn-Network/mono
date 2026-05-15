/**
 * DataTable — generic sortable table primitive.
 *
 * Design:
 *   - Sticky TableHead: caps-mono 9px, letter-spacing 0.14em, hairline border-bottom
 *   - Sorted column shows ▾ / ▴ caret (fg-dim, no emphasis)
 *   - Hairline 1px dividers between rows
 *   - bg-elevated; hover row → slightly lighter bg shift
 *   - tabular-nums on numeric cells (caller responsibility via className="data")
 *   - No emoji, no gradients, linear motion
 */

import type { ReactNode } from 'react';

export interface DataTableColumn {
  key: string;
  label: string;
  numeric?: boolean;
  sortable?: boolean;
  width?: string | number;
}

export interface DataTableProps<T> {
  columns: DataTableColumn[];
  rows: T[];
  sortKey: string;
  sortDir: 'asc' | 'desc';
  onSort: (key: string) => void;
  renderRow: (row: T, i: number) => ReactNode;
  /** Optional: a secondary block of rows rendered below a divider */
  lowVolumeRows?: T[];
  lowVolumeLabel?: string;
  emptyState?: ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  sortKey,
  sortDir,
  onSort,
  renderRow,
  lowVolumeRows,
  lowVolumeLabel = 'New / Low-volume',
  emptyState,
}: DataTableProps<T>) {
  if (rows.length === 0 && (!lowVolumeRows || lowVolumeRows.length === 0)) {
    return (
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-sm)',
          color: 'var(--fg-dim)',
          padding: '24px 0',
          textAlign: 'center',
        }}
      >
        {emptyState ?? 'No data.'}
      </div>
    );
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        overflow: 'hidden',
      }}
    >
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
        >
          <thead>
            <tr
              style={{
                background: 'var(--bg-sunken)',
                borderBottom: '1px solid var(--border-strong)',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              {columns.map((col) => {
                const isActive = col.key === sortKey;
                const canSort = col.sortable !== false;
                return (
                  <th
                    key={col.key}
                    onClick={canSort ? () => onSort(col.key) : undefined}
                    style={{
                      padding: '10px 16px',
                      textAlign: col.numeric ? 'right' : 'left',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: isActive ? 'var(--fg-muted)' : 'var(--fg-dim)',
                      fontWeight: 500,
                      cursor: canSort ? 'pointer' : 'default',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                      transition: 'color var(--dur-fast) var(--ease-linear)',
                      width: col.width,
                    }}
                  >
                    {col.label}
                    {canSort && (
                      <span
                        aria-hidden="true"
                        style={{
                          marginLeft: 4,
                          opacity: isActive ? 1 : 0.3,
                          color: isActive
                            ? 'var(--fg-muted)'
                            : 'var(--fg-dim)',
                        }}
                      >
                        {isActive
                          ? sortDir === 'desc'
                            ? '▾'
                            : '▴'
                          : '▾'}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <DataRow key={i} index={i}>
                {renderRow(row, i)}
              </DataRow>
            ))}

            {/* Low-volume section */}
            {lowVolumeRows && lowVolumeRows.length > 0 && (
              <>
                <tr>
                  <td
                    colSpan={columns.length}
                    style={{
                      padding: '8px 16px 6px',
                      background: 'var(--bg-sunken)',
                      borderTop: '1px solid var(--border)',
                      borderBottom: '1px solid var(--border)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: 'var(--fg-dim)',
                      fontWeight: 500,
                    }}
                  >
                    {lowVolumeLabel}
                  </td>
                </tr>
                {lowVolumeRows.map((row, i) => (
                  <DataRow key={`lv-${i}`} index={i} dimmed>
                    {renderRow(row, rows.length + i)}
                  </DataRow>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DataRow({
  children,
  index,
  dimmed,
}: {
  children: ReactNode;
  index: number;
  dimmed?: boolean;
}) {
  return (
    <tr
      style={{
        borderTop: index === 0 ? 'none' : '1px solid var(--border)',
        background: 'var(--bg-elevated)',
        transition: 'background var(--dur-fast) var(--ease-linear)',
        opacity: dimmed ? 0.72 : 1,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background =
          'var(--bg-sunken)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background =
          'var(--bg-elevated)';
      }}
    >
      {children}
    </tr>
  );
}

// ── Cell helpers ──────────────────────────────────────────────────────────────

/** Standard cell padding/style — import and spread in renderRow */
export const cellStyle = {
  padding: '10px 16px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  verticalAlign: 'middle',
  color: 'var(--fg)',
} as const;

export const cellNumStyle = {
  ...cellStyle,
  textAlign: 'right' as const,
  fontVariantNumeric: 'tabular-nums' as const,
  fontFeatureSettings: '"tnum" 1',
} as const;

export const cellMutedStyle = {
  ...cellStyle,
  color: 'var(--fg-muted)',
} as const;
