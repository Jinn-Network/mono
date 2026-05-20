import type {
  LaunchedSolverNetRecord,
  LifecycleTarget,
  SolverNetManifestV1,
} from '../../api/types.js';
import {
  ALLOWED_TRANSITIONS,
  STATUS_TONE,
  truncateAddress,
  truncateCid,
} from './helpers.js';

/**
 * Top-of-page header for the post-launch dashboard.
 *
 * Surfaces the SolverNet name (from manifest), live status badge, launcher
 * identity (Safe + agentId), and the lifecycle action buttons. Pause/Resume
 * is a single-click confirm; Retire requires a typed-name confirmation
 * surfaced via `PauseRetireDialog` — this component just dispatches
 * `onAction(target)` and lets the parent show the dialog.
 *
 * Action buttons appear/disappear per `record.status`:
 *   - launched → [Pause] + [Retire]
 *   - paused   → [Resume] + [Retire]
 *   - retired  → no actions (terminal)
 *   - launching → no actions, "Launching…" pill
 *   - failed   → no actions, "Failed" pill (the launch state machine carries
 *     the actionable details — operator follows up via the create flow)
 */

export interface StatusHeaderProps {
  record: LaunchedSolverNetRecord;
  manifest?: SolverNetManifestV1;
  /**
   * Number of distinct operators with on-chain activity on this SolverNet
   * (issue #351). `undefined` while the discovery query is loading or after
   * a discovery outage — the Operators field is omitted rather than showing a
   * misleading 0. The count reflects operators who have *claimed a task*: an
   * operator "join" in the app is a local config write with no on-chain
   * footprint (see `spec/2026-05-05-solvernet-creation-and-launch.md` §12).
   */
  operatorCount?: number;
  /** Triggered when the operator clicks Pause / Resume / Retire. */
  onAction: (target: LifecycleTarget) => void;
  /** When a lifecycle transition is in flight, disable buttons + show pill. */
  pending?: LifecycleTarget | null;
}

const ACTION_LABELS: Record<LifecycleTarget, string> = {
  paused: 'Pause',
  launched: 'Resume',
  retired: 'Retire',
};

export function StatusHeader({
  record,
  manifest,
  operatorCount,
  onAction,
  pending,
}: StatusHeaderProps): JSX.Element {
  const tone = STATUS_TONE[record.status] ?? STATUS_TONE.launching;
  const allowed = ALLOWED_TRANSITIONS[record.status] ?? [];
  const name = manifest?.name ?? record.summary?.name ?? record.solverNetId;

  return (
    <header
      data-testid="launcher-launched-status-header"
      data-status={record.status}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        padding: '24px 26px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <h1
              data-testid="launcher-launched-name"
              style={{
                fontFamily: "'Instrument Serif', 'Times New Roman', serif",
                fontSize: '32px',
                margin: 0,
                color: 'var(--fg)',
                fontWeight: 400,
                letterSpacing: '-0.01em',
              }}
            >
              {name}
            </h1>
            <span
              data-testid="launcher-launched-status-badge"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
                color: tone.fg,
                border: `1px solid ${tone.border}`,
                borderRadius: 'var(--radius-1)',
                padding: '3px 10px',
                whiteSpace: 'nowrap',
              }}
            >
              {tone.label}
            </span>
          </div>
          {manifest?.description && (
            <p
              style={{
                margin: 0,
                color: 'var(--fg-muted)',
                fontSize: '13px',
                lineHeight: 1.5,
                maxWidth: '720px',
              }}
            >
              {manifest.description}
            </p>
          )}
        </div>
        <ActionButtons
          allowed={allowed}
          onAction={onAction}
          pending={pending ?? null}
          terminal={record.status === 'retired'}
          launching={record.status === 'launching'}
        />
      </div>

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '8px 18px',
          margin: 0,
          paddingTop: '12px',
          borderTop: '1px solid var(--border)',
        }}
      >
        <IdentityField
          label="SolverNet id"
          value={record.solverNetId}
          testid="launcher-launched-solvernet-id"
          mono
        />
        <IdentityField
          label="Manifest cid"
          value={truncateCid(record.manifestCid)}
          testid="launcher-launched-manifest-cid"
          additionalTestIds={['manifest-cid']}
          mono
          title={record.manifestCid}
        />
        <IdentityField
          label="Launcher Safe"
          value={truncateAddress(record.launcherSafeAddress)}
          testid="launcher-launched-safe"
          mono
          title={record.launcherSafeAddress}
        />
        <IdentityField
          label="Launcher agent"
          value={record.launcherAgentId}
          testid="launcher-launched-agent"
          mono
        />
        {operatorCount !== undefined && (
          <IdentityField
            label="Operators"
            value={String(operatorCount)}
            testid="launcher-launched-operator-count"
            additionalTestIds={['operator-count']}
            mono
            title="Distinct operators that have claimed a task on this SolverNet"
          />
        )}
      </dl>
    </header>
  );
}

interface IdentityFieldProps {
  label: string;
  value: string;
  testid?: string;
  /** Extra test-ids to alias this field's value — rendered as hidden spans. */
  additionalTestIds?: string[];
  mono?: boolean;
  title?: string;
}

function IdentityField({
  label,
  value,
  testid,
  additionalTestIds,
  mono = false,
  title,
}: IdentityFieldProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
      <dt
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '10px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
        }}
      >
        {label}
      </dt>
      <dd
        data-testid={testid}
        title={title}
        style={{
          margin: 0,
          fontFamily: mono ? "'JetBrains Mono', monospace" : undefined,
          fontSize: '13px',
          color: 'var(--fg)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
        {additionalTestIds?.map((id) => (
          <span key={id} data-testid={id} style={{ display: 'none' }} aria-hidden="true">
            {value}
          </span>
        ))}
      </dd>
    </div>
  );
}

interface ActionButtonsProps {
  allowed: ReadonlyArray<LifecycleTarget>;
  onAction: (target: LifecycleTarget) => void;
  pending: LifecycleTarget | null;
  terminal: boolean;
  launching: boolean;
}

function ActionButtons({
  allowed,
  onAction,
  pending,
  terminal,
  launching,
}: ActionButtonsProps): JSX.Element | null {
  if (terminal) {
    return (
      <span
        data-testid="launcher-launched-terminal-pill"
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-1)',
          padding: '6px 12px',
          alignSelf: 'flex-start',
          whiteSpace: 'nowrap',
        }}
      >
        Retired — no further actions
      </span>
    );
  }
  if (launching) {
    return (
      <span
        data-testid="launcher-launched-launching-pill"
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-sky)',
          border: '1px solid var(--accent-sky)',
          borderRadius: 'var(--radius-1)',
          padding: '6px 12px',
          alignSelf: 'flex-start',
          whiteSpace: 'nowrap',
        }}
      >
        Launching…
      </span>
    );
  }
  if (allowed.length === 0) return null;
  return (
    <div
      data-testid="launcher-launched-actions"
      style={{ display: 'flex', gap: '8px', alignSelf: 'flex-start', flexWrap: 'wrap' }}
    >
      {allowed.map((target) => {
        const label = ACTION_LABELS[target];
        const isPending = pending === target;
        const isDanger = target === 'retired';
        return (
          <button
            key={target}
            type="button"
            data-testid={`launcher-launched-action-${target}`}
            onClick={() => onAction(target)}
            disabled={pending !== null}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              padding: '10px 16px',
              background: isDanger ? 'transparent' : 'var(--accent-sky)',
              color: isDanger ? 'var(--break-red)' : 'var(--bg-sunken)',
              border: `1px solid ${isDanger ? 'var(--break-red)' : 'var(--accent-sky)'}`,
              borderRadius: 'var(--radius-2)',
              cursor: pending !== null ? 'not-allowed' : 'pointer',
              opacity: pending !== null && !isPending ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {isPending ? `${label}…` : label}
          </button>
        );
      })}
    </div>
  );
}
