import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';

/**
 * Activity — the operator's view of their node's work. Replaces the prior
 * Network · counters / Solving on / In-flight / Recent / Harness Status
 * quintet with a single surface organised by §2.4 Memberships:
 *
 *   left:    Joined SolverNets list + "Join more" link → /operator/registry
 *   middle:  Selected SolverNet title + table of tasks this node has worked on
 *            (one row per task — fields from §2.6 Tasks)
 *   right:   Read-only environment for the selected membership
 *            (roles, harness, edit link → /operator/memberships)
 *
 * Aggregate counters (tasks/active/solutions/verdicts/...) intentionally
 * dropped — the operator cares about *what happened* on each task, not the
 * rolled-up scoreboard. The marketplace explorer is the right place for
 * the global counts.
 */

export interface ActivityTask {
  /** Stable identifier — request ID is the most operator-meaningful one. */
  requestId: string;
  manifestCid: string | null;
  taskRole: 'restoration' | 'evaluation' | null;
  /** Current state in the harness engine state machine (DISCOVERED .. COMPLETE / FAILED). */
  state: string;
  /** Harness/impl name the task ran under. */
  implName: string | null;
  /** Unix ms timestamp the run claimed (window-start). */
  windowStartTs: number;
  /** Unix ms timestamp of the last state update. */
  stateUpdatedAt: number;
  /** Optional on-chain delivery tx for explorer linking. */
  deliveryTxHash: string | null;
}

export interface ActivityJoinedNet {
  /** Display name; falls back to manifestCid if absent. */
  name: string;
  /** Manifest CID — the canonical identifier per spec §12. */
  manifestCid?: string;
  /** Roles the operator joined under (`solver`, `evaluator`, or legacy `solving`/`evaluating`). */
  roles: string[];
  /** Harness bound to this membership. */
  harness?: string;
}

export interface ActivityCardProps {
  joined: ActivityJoinedNet[];
  tasks: ActivityTask[];
}

const EYEBROW: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-xs)',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

const SECTION_LABEL: React.CSSProperties = {
  ...EYEBROW,
  color: 'var(--fg-dim)',
};

const COLUMN_BG: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  minWidth: 0,
};

function trunc(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatRole(role: ActivityTask['taskRole']): string {
  if (role === 'restoration') return 'solver';
  if (role === 'evaluation') return 'evaluator';
  return '—';
}

function formatState(state: string): { label: string; tone: 'good' | 'bad' | 'neutral' } {
  switch (state) {
    case 'COMPLETE':
      return { label: 'Complete', tone: 'good' };
    case 'FAILED':
      return { label: 'Failed', tone: 'bad' };
    case 'DISCOVERED':
    case 'CLAIMED':
    case 'WAITING':
    case 'PRE_SNAPSHOT':
    case 'RUNNING':
    case 'POST_SNAPSHOT':
    case 'PACKAGING':
    case 'DELIVERING':
      return { label: state.toLowerCase().replace(/_/g, ' '), tone: 'neutral' };
    default:
      return { label: state.toLowerCase().replace(/_/g, ' '), tone: 'neutral' };
  }
}

function formatRelative(ts: number): string {
  if (!ts) return '—';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function normaliseRole(role: string): string {
  if (role === 'solving' || role === 'solver') return 'solver';
  if (role === 'evaluating' || role === 'evaluator') return 'evaluator';
  return role;
}

export function ActivityCard({ joined, tasks }: ActivityCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const [selectedCid, setSelectedCid] = useState<string | null>(
    joined[0]?.manifestCid ?? joined[0]?.name ?? null,
  );

  const selected = useMemo(
    () =>
      joined.find((n) => (n.manifestCid ?? n.name) === selectedCid) ?? joined[0] ?? null,
    [joined, selectedCid],
  );

  const filtered = useMemo(() => {
    if (!selected) return [];
    return tasks.filter((t) => {
      // Manifest CID is the canonical match; legacy rows without one
      // belong to whichever SolverNet they ran under. Today that's only
      // ever one (since multi-SolverNet operation isn't on yet), so we
      // include them; once tasks reliably carry manifestCid we can drop
      // this fallback.
      if (t.manifestCid && selected.manifestCid) return t.manifestCid === selected.manifestCid;
      return joined.length <= 1;
    }).slice(0, 50);
  }, [tasks, selected, joined.length, selectedCid]);

  return (
    <section
      role="region"
      aria-label="Activity"
      data-testid="activity-card"
      className="j-surface-secondary"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <span style={EYEBROW}>Activity</span>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(160px, 200px) minmax(0, 1fr) minmax(180px, 220px)',
          gap: 'var(--space-5)',
          alignItems: 'start',
        }}
      >
        {/* ── LEFT: JOINED SOLVERNETS ─────────────────────────────────── */}
        <div style={COLUMN_BG} data-testid="activity-joined">
          <span style={SECTION_LABEL}>Joined</span>
          {joined.length === 0 ? (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-sm)', color: 'var(--fg-dim)' }}>
              No SolverNets joined.
            </span>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              {joined.map((n) => {
                const key = n.manifestCid ?? n.name;
                const isActive = key === (selected?.manifestCid ?? selected?.name);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      data-testid={`activity-joined-row-${key}`}
                      onClick={() => setSelectedCid(key)}
                      aria-current={isActive ? 'true' : undefined}
                      style={{
                        background: isActive ? 'var(--bg-sunken)' : 'transparent',
                        border: 0,
                        borderLeft: `2px solid ${isActive ? 'var(--accent-sky)' : 'transparent'}`,
                        padding: '6px 10px',
                        fontFamily: 'var(--mono)',
                        fontSize: 'var(--text-sm)',
                        color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
                        textAlign: 'left',
                        width: '100%',
                        cursor: 'pointer',
                      }}
                    >
                      {n.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            data-testid="activity-join-more"
            onClick={() => navigate('/operator/registry')}
            style={{
              background: 'transparent',
              border: '1px solid var(--accent-sky)',
              borderRadius: 'var(--radius-2)',
              color: 'var(--accent-sky)',
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
              fontSize: 'var(--text-xs)',
              letterSpacing: '0.14em',
              padding: '6px 10px',
              textTransform: 'uppercase',
              alignSelf: 'flex-start',
              marginTop: 'var(--space-2)',
            }}
          >
            Join more SolverNets
          </button>
        </div>

        {/* ── MIDDLE: TASKS TABLE ────────────────────────────────────── */}
        <div style={COLUMN_BG} data-testid="activity-tasks">
          {selected && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 'var(--text-md)',
                color: 'var(--fg)',
                fontWeight: 500,
              }}
            >
              {selected.name}
            </span>
          )}
          {filtered.length === 0 ? (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-sm)', color: 'var(--fg-dim)' }}>
              No task runs recorded yet.
            </span>
          ) : (
            <div
              role="table"
              data-testid="activity-tasks-table"
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(110px, 1fr) 90px 110px 130px',
                rowGap: 'var(--space-2)',
                columnGap: 'var(--space-3)',
                fontFamily: 'var(--mono)',
                fontSize: 'var(--text-sm)',
                color: 'var(--fg)',
                alignItems: 'baseline',
              }}
            >
              {/* header */}
              {(['Task', 'Role', 'State', 'Started'] as const).map((label) => (
                <span key={label} role="columnheader" style={{ ...EYEBROW, color: 'var(--fg-dim)' }}>
                  {label}
                </span>
              ))}
              {/* rows */}
              {filtered.map((t) => {
                const stateInfo = formatState(t.state);
                const stateColor =
                  stateInfo.tone === 'good'
                    ? 'var(--vow-green)'
                    : stateInfo.tone === 'bad'
                      ? 'var(--break-red)'
                      : 'var(--fg-muted)';
                return (
                  <RowFragment key={t.requestId}>
                    <span role="cell" title={t.requestId}>{trunc(t.requestId)}</span>
                    <span role="cell" style={{ color: 'var(--fg-muted)' }}>{formatRole(t.taskRole)}</span>
                    <span role="cell" style={{ color: stateColor }}>{stateInfo.label}</span>
                    <span role="cell" style={{ color: 'var(--fg-muted)' }}>{formatRelative(t.windowStartTs || t.stateUpdatedAt)}</span>
                  </RowFragment>
                );
              })}
            </div>
          )}
        </div>

        {/* ── RIGHT: SETTINGS ────────────────────────────────────────── */}
        <div style={COLUMN_BG} data-testid="activity-settings">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={SECTION_LABEL}>Settings</span>
            <button
              type="button"
              data-testid="activity-settings-edit"
              onClick={() => navigate('/operator/memberships')}
              style={{
                background: 'transparent',
                border: 0,
                color: 'var(--accent-sky)',
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
                fontSize: 'var(--text-xs)',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                padding: 0,
              }}
            >
              Edit →
            </button>
          </div>

          {!selected ? (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-sm)', color: 'var(--fg-dim)' }}>
              No SolverNet selected.
            </span>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <span style={{ ...EYEBROW, color: 'var(--fg-dim)' }}>Roles</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  {selected.roles.length === 0 ? (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-sm)', color: 'var(--fg-dim)' }}>
                      None
                    </span>
                  ) : (
                    selected.roles.map((r) => (
                      <span
                        key={r}
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 'var(--text-2xs)',
                          letterSpacing: '0.14em',
                          textTransform: 'uppercase',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-1)',
                          padding: '2px 6px',
                          color: 'var(--fg)',
                        }}
                      >
                        {normaliseRole(r)}
                      </span>
                    ))
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <span style={{ ...EYEBROW, color: 'var(--fg-dim)' }}>Harness</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>
                  {selected.harness ?? '—'}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// React doesn't render fragments as direct grid children consistently across
// browsers (Safari has historically struggled). For grid rows, we need the
// children flat — this wrapper avoids a stray <div> per row that would
// break the columns.
function RowFragment({ children }: { children: React.ReactNode }): JSX.Element {
  return <>{children}</>;
}
