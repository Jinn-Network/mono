import { useLocation } from 'wouter';

/**
 * Node Health card — the right-rail summary of this operator's daemon and
 * RPC connection. Renders two rows:
 *
 *   1. Daemon — running/stopped, with a state-message slot. Stop + Start
 *      buttons are rendered as forward-looking controls; until the daemon
 *      ships POST /v1/daemon/stop and POST /v1/daemon/start, both are
 *      disabled with a tooltip pointing the operator at the terminal. The
 *      shape is what we want; the wiring catches up.
 *
 *   2. RPC — healthy/unreachable, moved out of the page header so health
 *      state lives next to the action that resolves it. The Manage RPC
 *      button jumps to /operator/network.
 *
 * Eviction and re-stake recovery used to live inline in the old Status
 * tile. They now belong to the `service_evicted` notification (severity
 * blocking) and to a dedicated banner on /overview when applicable —
 * Node Health stays focused on the two health rows the operator asked
 * for.
 */
export type DaemonStatus = 'running' | 'stopped';
export type RpcStatus = 'healthy' | 'unreachable';

export interface NodeHealthCardProps {
  daemonStatus: DaemonStatus;
  /** One-line reason for the current daemon state (e.g. "waiting for next task"). */
  daemonStateMessage?: string;
  rpcStatus: RpcStatus;
}

const ROW_LABEL_STYLE: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-xs)',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

const ROW_VALUE_STYLE: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-md)',
  fontWeight: 500,
  color: 'var(--fg)',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
};

const STATE_MESSAGE_STYLE: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-sm)',
  color: 'var(--fg-muted)',
  lineHeight: 1.4,
};

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: 'var(--space-2)',
  marginTop: 'var(--space-2)',
};

function GhostButton({
  children,
  disabled,
  title,
  onClick,
  tone = 'sky',
  testId,
}: {
  children: string;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  tone?: 'sky' | 'red';
  testId?: string;
}): JSX.Element {
  const color = tone === 'red' ? 'var(--break-red)' : 'var(--accent-sky)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      style={{
        background: 'transparent',
        border: `1px solid ${color}`,
        borderRadius: 'var(--radius-2)',
        color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--mono)',
        fontSize: 'var(--text-xs)',
        letterSpacing: '0.14em',
        opacity: disabled ? 0.4 : 1,
        padding: '6px 10px',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </button>
  );
}

function StatusDot({ tone }: { tone: 'good' | 'bad' | 'neutral' }): JSX.Element {
  const color =
    tone === 'good' ? 'var(--vow-green)' : tone === 'bad' ? 'var(--break-red)' : 'var(--fg-muted)';
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: color,
      }}
    />
  );
}

export function NodeHealthCard({
  daemonStatus,
  daemonStateMessage,
  rpcStatus,
}: NodeHealthCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const daemonRunning = daemonStatus === 'running';
  const rpcHealthy = rpcStatus === 'healthy';

  return (
    <section
      data-testid="node-health-card"
      className="j-surface-secondary"
      aria-labelledby="node-health-heading"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <h2
        id="node-health-heading"
        style={{
          ...ROW_LABEL_STYLE,
          margin: 0,
          color: 'var(--fg-dim)',
        }}
      >
        Node health
      </h2>

      {/* ── DAEMON ─────────────────────────────────────────────────────── */}
      <div
        data-testid="node-health-daemon-row"
        data-status={daemonStatus}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
      >
        <span style={ROW_LABEL_STYLE}>Daemon</span>
        <span style={ROW_VALUE_STYLE}>
          <StatusDot tone={daemonRunning ? 'good' : 'bad'} />
          {daemonRunning ? 'Running' : 'Stopped'}
        </span>
        {daemonStateMessage && (
          <span data-testid="node-health-daemon-state" style={STATE_MESSAGE_STYLE}>
            {daemonStateMessage}
          </span>
        )}
        <div style={BUTTON_ROW_STYLE}>
          <GhostButton
            tone="red"
            disabled={!daemonRunning}
            title={
              daemonRunning
                ? 'Daemon stop control will land with daemon-side POST /v1/daemon/stop. Use Ctrl-C in your terminal for now.'
                : 'Daemon is already stopped.'
            }
            testId="node-health-stop"
          >
            Stop
          </GhostButton>
          <GhostButton
            disabled={daemonRunning}
            title={
              daemonRunning
                ? 'Daemon is currently running. Start activates once the daemon is stopped.'
                : 'Daemon start control will land with daemon-side POST /v1/daemon/start. Re-run jinn from your terminal for now.'
            }
            testId="node-health-start"
          >
            Start
          </GhostButton>
        </div>
      </div>

      {/* ── RPC ────────────────────────────────────────────────────────── */}
      <div
        data-testid="node-health-rpc-row"
        data-status={rpcStatus}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
      >
        <span style={ROW_LABEL_STYLE}>RPC</span>
        <span style={ROW_VALUE_STYLE}>
          <StatusDot tone={rpcHealthy ? 'good' : 'bad'} />
          {rpcHealthy ? 'Healthy' : 'Unreachable'}
        </span>
        <div style={BUTTON_ROW_STYLE}>
          <GhostButton
            onClick={() => navigate('/operator/network')}
            testId="node-health-rpc-settings"
          >
            Manage RPC
          </GhostButton>
        </div>
      </div>
    </section>
  );
}
