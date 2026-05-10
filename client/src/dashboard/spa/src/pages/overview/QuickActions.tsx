import { useState } from 'react';

/** Four quick-action cards on Overview: Claim, Top up gas, Manage wallet,
 *  Restart node. Ghost buttons (transparent + hairline + mono). */

export interface QuickActionResult {
  message?: string;
}

export interface QuickActionsProps {
  claimableJinn: string;
  gasEth: string;
  onClaim: () => void | QuickActionResult | Promise<void | QuickActionResult>;
  onTopUp: () => void | QuickActionResult | Promise<void | QuickActionResult>;
  onManage: () => void | QuickActionResult | Promise<void | QuickActionResult>;
  onRestart: () => void | QuickActionResult | Promise<void | QuickActionResult>;
}

interface ActionProps {
  label: string;
  sub: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
}

function Action({ label, sub, onClick, busy, disabled }: ActionProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '14px 16px',
        textAlign: 'left',
        color: 'var(--fg)',
        fontFamily: "'JetBrains Mono', monospace",
        cursor: busy ? 'wait' : disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        opacity: disabled ? 0.66 : 1,
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
      <span style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>{busy ? 'Working...' : sub}</span>
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
  const [active, setActive] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const run = (label: string, action: QuickActionsProps['onClaim']): void => {
    setActive(label);
    setNotice(null);
    Promise.resolve()
      .then(action)
      .then((result) => {
        setNotice({
          tone: 'success',
          text: result?.message ?? `${label} requested.`,
        });
      })
      .catch((err) => {
        setNotice({
          tone: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setActive(null));
  };

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
        <Action
          label="Claim JINN"
          sub={`${claimableJinn} claimable`}
          onClick={() => run('Claim JINN', onClaim)}
          busy={active === 'Claim JINN'}
          disabled={active !== null}
        />
        <Action
          label="Top up gas"
          sub={`${gasEth} ETH`}
          onClick={() => run('Top up gas', onTopUp)}
          busy={active === 'Top up gas'}
          disabled={active !== null}
        />
        <Action
          label="Manage wallet"
          sub="Change keystore password"
          onClick={() => run('Manage wallet', onManage)}
          busy={active === 'Manage wallet'}
          disabled={active !== null}
        />
        <Action
          label="Restart node"
          sub="Graceful"
          onClick={() => run('Restart node', onRestart)}
          busy={active === 'Restart node'}
          disabled={active !== null}
        />
      </div>
      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          data-testid="quick-actions-notice"
          style={{
            border: `1px solid ${notice.tone === 'error' ? 'var(--break-red)' : 'var(--vow-green)'}`,
            color: notice.tone === 'error' ? 'var(--break-red)' : 'var(--vow-green)',
            borderRadius: '6px',
            padding: '10px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
          }}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
