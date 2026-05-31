/**
 * OperatorsView — roster of operators participating across SolverNets.
 *
 * Per spec §5.4 and #610, this view no longer ranks operators across
 * SolverNets (a cross-net leaderboard mixes regimes and is not a coherent
 * score). It renders a flat roster: operator (short-address link) /
 * attempts / JINN earned. SolverNet detail views host the train+frozen
 * boards where ranking is meaningful (single regime, single task pool).
 */

import { Link } from 'wouter';
import { useOperators, type ActiveWindow } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { Kpi, KpiRow } from '../components/Kpi';
import { InfoTooltip } from '../components/InfoTooltip';
import {
  ActiveOperatorTooltipBody,
  formatBlockWindow,
} from '../components/ActiveOperatorTooltip';
import { shortAddr, int, jinn } from '../lib/format';

// Canonical encoding note for the ACTIVITY BLOCKS column header tooltip.
// Mirrored verbatim from the acceptance criteria so the header tooltip stays in
// sync if the criteria are tightened.
const ACTIVITY_BLOCKS_ENCODING_NOTE =
  'Each cell is one of the last 8 completed UTC 6-hour blocks (oldest left). Y = operator earned ≥3 tJINN in that block; N = did not.';

// ── Activity-blocks cell ──────────────────────────────────────────────────────

/**
 * Per-row "Activity blocks" rendering — 8 Y/N glyphs joined by ` | `, each glyph
 * carrying a native `title` describing the block's UTC window.
 *
 * `recentBlocks` may be absent when the server omits it (older response, or
 * a code path that does not populate it); fall back to all-false so the row
 * still renders 8 cells.
 */
function ActivityBlocksCell({
  recentBlocks,
  window,
}: {
  recentBlocks: boolean[] | undefined;
  window: ActiveWindow;
}) {
  const blocks =
    recentBlocks && recentBlocks.length === window.blockCount
      ? recentBlocks
      : new Array<boolean>(window.blockCount).fill(false);

  return (
    <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
      {blocks.map((qualified, i) => (
        <span key={i}>
          <span
            data-testid={`activity-block-cell-${i}`}
            title={formatBlockWindow(window, i)}
            style={{
              color: qualified ? 'var(--vow-green)' : 'var(--break-red)',
            }}
          >
            {qualified ? 'Y' : 'N'}
          </span>
          {i < blocks.length - 1 && (
            <span style={{ color: 'var(--fg-dim)' }}> | </span>
          )}
        </span>
      ))}
    </span>
  );
}

// ── Inline table styling ──────────────────────────────────────────────────────

const th: React.CSSProperties = {
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  padding: '12px 16px',
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-sunken)',
};

const td: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--fg)',
  padding: '12px 16px',
  fontVariantNumeric: 'tabular-nums',
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function RosterSkeleton() {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        background: 'var(--bg-elevated)',
        height: 240,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 36,
          background: 'var(--bg-sunken)',
          borderBottom: '1px solid var(--border)',
        }}
      />
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: 44,
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            gap: 16,
          }}
        >
          <div
            style={{
              width: 30,
              height: 12,
              background: 'var(--bg-sunken)',
              borderRadius: 'var(--radius-1)',
            }}
          />
          <div
            style={{
              flex: 1,
              height: 12,
              background: 'var(--bg-sunken)',
              borderRadius: 'var(--radius-1)',
            }}
          />
        </div>
      ))}
    </div>
  );
}

// ── OperatorsView ─────────────────────────────────────────────────────────────

export function OperatorsView() {
  // Decision 4 (#610): with the filter UI removed, useOperators is called
  // with no params. The backend still honours ?mode / ?harness / ?minVerdicts
  // for ad-hoc URL use; this view simply doesn't pass them.
  const { data, isLoading, isError } = useOperators();

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}
    >
      {/* ── Page heading ── */}
      <div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            fontSize: 'var(--text-3xl)',
            lineHeight: 1.05,
            color: 'var(--fg)',
            margin: 0,
            marginBottom: 6,
            fontWeight: 400,
          }}
        >
          Operators
        </h1>
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--fg-dim)',
            margin: 0,
            letterSpacing: '0.04em',
          }}
        >
          Roster of operators participating across SolverNets.
        </p>
      </div>

      {/* ── Loading state ── */}
      {isLoading && <RosterSkeleton />}

      {/* ── Error state ── */}
      {isError && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--break-red)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '20px 24px',
          }}
        >
          Failed to load operators.
        </div>
      )}

      {/* ── Active-operator stat ── */}
      {data && (
        <KpiRow>
          <Kpi
            label={
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                Active operators
                <InfoTooltip label="Active operators definition">
                  <ActiveOperatorTooltipBody window={data.activeWindow} />
                </InfoTooltip>
              </span>
            }
            value={int(data.activeOperators)}
            accent
          />
        </KpiRow>
      )}

      {/* ── Roster table ── */}
      {data && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-3)',
            background: 'var(--bg-elevated)',
            overflow: 'hidden',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Operator</th>
                <th style={th}>
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    Active?
                    <InfoTooltip label="Active column definition">
                      <ActiveOperatorTooltipBody window={data.activeWindow} />
                    </InfoTooltip>
                  </span>
                </th>
                <th style={th}>
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    Activity blocks
                    <InfoTooltip label="Activity blocks definition">
                      <div>{ACTIVITY_BLOCKS_ENCODING_NOTE}</div>
                    </InfoTooltip>
                  </span>
                </th>
                <th style={th}>Attempts</th>
                <th style={th}>JINN earned</th>
              </tr>
            </thead>
            <tbody>
              {[...data.ranked, ...data.lowVolume].map((op) => (
                <tr
                  key={op.operator}
                  style={{ borderTop: '1px solid var(--border)' }}
                >
                  <td style={td}>
                    <Link
                      href={`/operator/${op.operator}`}
                      style={{
                        color: 'var(--accent)',
                        textDecoration: 'none',
                      }}
                    >
                      {shortAddr(op.operator)}
                    </Link>
                  </td>
                  <td
                    style={{
                      ...td,
                      color: op.active ? 'var(--vow-green)' : 'var(--break-red)',
                    }}
                  >
                    {op.active ? 'Yes' : 'No'}
                  </td>
                  <td style={td}>
                    <ActivityBlocksCell
                      recentBlocks={op.recentBlocks}
                      window={data.activeWindow}
                    />
                  </td>
                  <td style={td}>{int(op.attempts)}</td>
                  <td style={td}>{jinn(op.jinnEarned)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        degraded={isError}
      />
    </div>
  );
}
