/**
 * OperatorView — per-operator detail.
 *
 * Gold element: the operator's overall resolved rate (ONE gold per surface rule).
 * All other KPIs are plain fg.
 *
 * Sections:
 *   - Header: full address + copy affordance + dominant mode/harness/type chips
 *   - KpiRow: totals (attempts, settled, verdicts pass/total, resolved rate GOLD,
 *             JINN earned — or "—" if jinnAttribution: 'pending')
 *   - Card: per-SolverNet table with mode-breakdown text
 *   - StatusBar
 *
 * Unknown address → empty perSolverNet + zeroed totals (not a 404).
 */

import { Link, useParams } from 'wouter';
import { useOperator } from '../lib/api';
import type { OperatorPerSolverNet } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { Card } from '../components/Card';
import { Kpi, KpiRow } from '../components/Kpi';
import { StatusChip } from '../components/StatusChip';
import { DataTable, cellStyle, cellNumStyle } from '../components/DataTable';
import { pct, int, jinn, shortAddr, shortCid } from '../lib/format';

// ── Copy-address affordance ───────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  function handleCopy() {
    navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy address"
      style={{
        background: 'none',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-1)',
        cursor: 'pointer',
        color: 'var(--fg-dim)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        padding: '2px 7px',
        letterSpacing: '0.06em',
        lineHeight: 1.4,
        transition: 'border-color var(--dur-fast) var(--ease-linear), color var(--dur-fast) var(--ease-linear)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)';
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--fg-muted)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--fg-dim)';
      }}
    >
      copy
    </button>
  );
}

// ── Mode breakdown text ───────────────────────────────────────────────────────

function ModeBreakdownText({ entries }: { entries: OperatorPerSolverNet['modeBreakdown'] }) {
  if (!entries || entries.length === 0) return <span style={{ color: 'var(--fg-dim)' }}>—</span>;
  return (
    <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>
      {entries
        .filter((e) => e.count > 0)
        .map((e, i, arr) => (
          <span key={e.value}>
            <span style={{ color: 'var(--fg-dim)' }}>{e.value}</span>
            <span style={{ color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}>
              :{int(e.count)}
            </span>
            {i < arr.length - 1 && (
              <span style={{ color: 'var(--fg-dim)', padding: '0 4px' }}>·</span>
            )}
          </span>
        ))}
    </span>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function HeaderSkeleton() {
  return (
    <div
      style={{
        height: 120,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          width: 320,
          height: 14,
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--radius-1)',
        }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        {[80, 100, 120].map((w, i) => (
          <div
            key={i}
            style={{
              width: w,
              height: 22,
              background: 'var(--bg-sunken)',
              borderRadius: 'var(--radius-pill)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        background: 'var(--bg-elevated)',
        height: 88,
      }}
    />
  );
}

// ── Per-SolverNet table columns ───────────────────────────────────────────────

const SOLVERNET_COLUMNS = [
  { key: 'cid', label: 'SolverNet', sortable: false },
  { key: 'status', label: 'Status', sortable: false },
  { key: 'attempts', label: 'Attempts', numeric: true },
  { key: 'settledContribution', label: 'Settled', numeric: true },
  { key: 'verdicts', label: 'Pass / Total', numeric: true },
  { key: 'resolvedRate', label: 'Resolved', numeric: true },
  { key: 'modeBreakdown', label: 'Modes', sortable: false },
];

// ── OperatorView ──────────────────────────────────────────────────────────────

export function OperatorView() {
  const params = useParams<{ addr: string }>();
  const addr = decodeURIComponent(params?.addr ?? '');
  const { data, isLoading, isError } = useOperator(addr);

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}
    >
      {/* ── Breadcrumb ── */}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          letterSpacing: '0.08em',
          color: 'var(--fg-dim)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Link
          href="/operators"
          style={{ color: 'var(--fg-dim)', textDecoration: 'none' }}
        >
          Operators
        </Link>
        <span aria-hidden="true">/</span>
        <span
          style={{
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {addr ? shortAddr(addr) : '…'}
        </span>
      </div>

      {/* ── Loading ── */}
      {isLoading && (
        <>
          <HeaderSkeleton />
          <KpiSkeleton />
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-3)',
              background: 'var(--bg-elevated)',
              height: 220,
            }}
          />
        </>
      )}

      {/* ── Error ── */}
      {isError && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--break-red)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div>Failed to load operator.</div>
          <Link
            href="/operators"
            style={{
              color: 'var(--accent)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            Back to operators
          </Link>
        </div>
      )}

      {/* ── Data ── */}
      {data && (
        <>
          {/* ── Header ── */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              padding: '24px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-3)',
            }}
          >
            {/* Full address + copy button */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 14,
                  color: 'var(--fg)',
                  fontVariantNumeric: 'tabular-nums',
                  wordBreak: 'break-all',
                }}
              >
                {data.operator}
              </span>
              <CopyButton text={data.operator} />
            </div>

            {/* Dominant mode / harness / type chips */}
            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <StatusChip
                kind={data.dominantMode as 'train' | 'frozen' | 'unknown'}
                label={`mode: ${data.dominantMode}`}
              />
              <StatusChip
                kind="unknown"
                label={`harness: ${data.dominantHarness}`}
              />
              <StatusChip
                kind="unknown"
                label={`type: ${data.dominantSolverType}`}
              />
            </div>
          </div>

          {/* ── KPI totals ── */}
          <KpiRow>
            <Kpi
              label="Attempts"
              value={int(data.totals.attempts)}
            />
            <Kpi
              label="Settled contrib."
              value={int(data.totals.settledContribution)}
            />
            <Kpi
              label="Verdicts"
              value={
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {int(data.totals.verdictsPass)}
                  <span style={{ color: 'var(--fg-dim)', fontSize: 18 }}>/</span>
                  {int(data.totals.verdictsTotal)}
                </span>
              }
            />
            <Kpi
              label="Resolved rate"
              value={pct(data.totals.resolvedRate)}
              accent
            />
            <Kpi
              label="JINN earned"
              value={
                data.meta.jinnAttribution === 'pending' ? (
                  <span
                    title="operator JINN attribution pending — see jinn-mono-ebu7.9"
                    style={{ color: 'var(--fg-dim)' }}
                  >
                    —
                  </span>
                ) : (
                  jinn(data.totals.jinnEarned)
                )
              }
            />
          </KpiRow>

          {/* ── Per-SolverNet table ── */}
          <Card title="By SolverNet">
            {data.perSolverNet.length === 0 ? (
              <p
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--fg-dim)',
                  margin: 0,
                }}
              >
                No activity recorded for this address.
              </p>
            ) : (
              <DataTable
                columns={SOLVERNET_COLUMNS}
                rows={data.perSolverNet}
                sortKey="resolvedRate"
                sortDir="desc"
                onSort={() => {
                  /* client-side sort is stateless for this table — server order is fine */
                }}
                renderRow={(row) => (
                  <>
                    {/* SolverNet CID */}
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

                    {/* Status */}
                    <td style={cellStyle}>
                      <StatusChip
                        kind={row.status as 'launched' | 'paused' | 'retired' | 'unknown'}
                        label={row.status}
                      />
                    </td>

                    {/* Attempts */}
                    <td className="data" style={cellNumStyle}>
                      {int(row.attempts)}
                    </td>

                    {/* Settled */}
                    <td className="data" style={cellNumStyle}>
                      {int(row.settledContribution)}
                    </td>

                    {/* Verdicts pass / total */}
                    <td className="data" style={cellNumStyle}>
                      {int(row.verdictsPass)}&thinsp;/&thinsp;{int(row.verdictsTotal)}
                    </td>

                    {/* Resolved rate */}
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

                    {/* Mode breakdown */}
                    <td style={cellStyle}>
                      <ModeBreakdownText entries={row.modeBreakdown} />
                    </td>
                  </>
                )}
              />
            )}
          </Card>
        </>
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        degraded={isError}
      />
    </div>
  );
}
