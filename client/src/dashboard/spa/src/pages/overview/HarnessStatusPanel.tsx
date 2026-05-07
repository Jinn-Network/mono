import { useEffect, useState } from 'react';

interface HarnessStatus {
  mode: string;
  codeDigest: string;
  lastModeSwitchAt?: number;
}

/**
 * Displays the current harness mode, code digest, and time since mode switch.
 * Operators see at a glance whether they're contributing to the substrate (train)
 * or producing a benchmark snapshot (frozen).
 */
export function HarnessStatusPanel(): JSX.Element {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async (): Promise<void> => {
      try {
        const res = await fetch('/api/harness/status', { credentials: 'same-origin' });
        if (res.ok) {
          const data = (await res.json()) as HarnessStatus;
          setStatus(data);
        }
      } catch {
        // Silent fail; endpoint may not exist yet
      } finally {
        setLoading(false);
      }
    };

    void fetchStatus();
  }, []);

  if (loading || !status) {
    return (
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <span style={{ fontSize: '13px', color: 'var(--fg-muted)' }}>Harness status unavailable</span>
      </div>
    );
  }

  const toneBg = status.mode === 'train' ? 'var(--vow-green)' : 'var(--wane)';
  const toneText = status.mode === 'train' ? 'var(--vow-green)' : 'var(--wane)';
  const lastSwitchDate = status.lastModeSwitchAt
    ? new Date(status.lastModeSwitchAt).toLocaleString()
    : 'Never';

  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
        <span
          style={{
            fontSize: '13px',
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
            color: 'var(--fg)',
          }}
        >
          Harness Status
        </span>
        <span
          style={{
            display: 'inline-block',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: toneBg,
          }}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <div>
          <span style={{ fontSize: '11px', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
            Mode
          </span>
          <div style={{ fontSize: '14px', fontWeight: 500, color: toneText, marginTop: '4px' }}>
            {status.mode.toUpperCase()}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '6px', display: 'block' }}>
            {status.mode === 'train'
              ? 'Contributing to substrate'
              : 'Benchmarking only'}
          </span>
        </div>
        <div>
          <span style={{ fontSize: '11px', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
            Code Digest
          </span>
          <div
            style={{
              fontSize: '12px',
              fontFamily: "'JetBrains Mono', monospace",
              color: 'var(--fg)',
              marginTop: '4px',
              wordBreak: 'break-all',
            }}
          >
            {status.codeDigest.slice(0, 16)}…
          </div>
        </div>
      </div>
      {status.lastModeSwitchAt && (
        <div
          style={{
            fontSize: '11px',
            color: 'var(--fg-muted)',
            paddingTop: '8px',
            borderTop: '1px solid var(--border)',
            marginTop: '8px',
          }}
        >
          Mode switched: {lastSwitchDate}
        </div>
      )}
    </div>
  );
}
