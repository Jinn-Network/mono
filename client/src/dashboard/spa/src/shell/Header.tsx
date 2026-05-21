import { Link } from 'wouter';

export interface HeaderProps {
  network: 'testnet' | 'mainnet';
}

/**
 * Top-of-page chrome. The RPC health pill that used to live here moved into
 * the Node Health card on /overview where the operator can act on a degraded
 * RPC. The master-address pill moved into the Wallet Identity row alongside
 * Agent and Safe — it belongs with the rest of the operator's on-chain
 * identity, not next to the network indicator.
 */
export function Header({ network }: HeaderProps): JSX.Element {
  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 24px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <Link href="/overview" style={{ textDecoration: 'none', color: 'var(--fg)' }}>
          <span
            style={{
              fontFamily: "'Instrument Serif', 'Times New Roman', serif",
              fontSize: '26px',
              color: 'var(--fg)',
            }}
          >
            jinn operator
          </span>
        </Link>
      </div>
      <div
        style={{
          display: 'flex',
          gap: '16px',
          alignItems: 'center',
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        <span
          style={{
            border: '1px solid var(--border)',
            borderRadius: '4px',
            padding: '2px 8px',
          }}
        >
          {network}
        </span>
      </div>
    </header>
  );
}
