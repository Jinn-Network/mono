/**
 * Persistent banner that appears across Overview and Operator
 * tabs after the operator saves a restart-required config change. Hosts
 * the call-to-action that triggers `/api/admin/restart`.
 *
 * Smoother auto-restart-and-reconnect UX is filed as a separate follow-up.
 */
export interface RestartBannerProps {
  restartPending: boolean;
  onRestart: () => void;
}

export function RestartBanner({ restartPending, onRestart }: RestartBannerProps): JSX.Element | null {
  if (!restartPending) return null;
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border-accent)',
        padding: '10px 24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '13px',
      }}
    >
      <span style={{ color: 'var(--fg)' }}>
        Operator settings saved. Restart the node to apply.
      </span>
      <button
        type="button"
        onClick={onRestart}
        style={{
          background: 'var(--accent-sky)',
          border: '1px solid var(--accent-sky)',
          color: 'var(--bg-sunken)',
          padding: '6px 14px',
          borderRadius: '6px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          cursor: 'pointer',
        }}
      >
        Restart node
      </button>
    </div>
  );
}
