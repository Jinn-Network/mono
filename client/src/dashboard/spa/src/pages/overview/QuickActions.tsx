/** Four quick-action cards on Overview: Claim, Top up gas, Manage wallet,
 *  Restart node. Ghost buttons (transparent + hairline + mono). */

export interface QuickActionsProps {
  claimableJinn: string;
  gasEth: string;
  onClaim: () => void;
  onTopUp: () => void;
  onManage: () => void;
  onRestart: () => void;
}

interface ActionProps {
  label: string;
  sub: string;
  onClick: () => void;
}

function Action({ label, sub, onClick }: ActionProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '14px 16px',
        textAlign: 'left',
        color: 'var(--fg)',
        fontFamily: "'JetBrains Mono', monospace",
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>{sub}</span>
    </button>
  );
}

export function QuickActions({
  claimableJinn,
  gasEth,
  onClaim,
  onTopUp,
  onManage,
  onRestart,
}: QuickActionsProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        Quick actions
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
        <Action label="Claim JINN" sub={`${claimableJinn} claimable`} onClick={onClaim} />
        <Action label="Top up gas" sub={`${gasEth} ETH`} onClick={onTopUp} />
        <Action label="Manage wallet" sub="Change keystore password" onClick={onManage} />
        <Action label="Restart node" sub="Graceful" onClick={onRestart} />
      </div>
    </div>
  );
}
