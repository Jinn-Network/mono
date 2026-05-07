import { Link } from 'wouter';

export interface HeaderProps {
  network: 'testnet' | 'mainnet';
  rpcHealthy: boolean;
  masterAddress?: string;
}

function trunc(addr?: string): string {
  if (!addr || addr.length < 10) return addr ?? '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function Header({ network, rpcHealthy, masterAddress }: HeaderProps): JSX.Element {
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
        <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: rpcHealthy ? 'var(--vow-green)' : 'var(--break-red)',
            }}
          />
          {rpcHealthy ? 'rpc healthy' : 'rpc unreachable'}
        </span>
        <span style={{ color: 'var(--fg-dim)' }}>master {trunc(masterAddress)}</span>
      </div>
    </header>
  );
}
