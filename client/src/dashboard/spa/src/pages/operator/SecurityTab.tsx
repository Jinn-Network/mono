import { useState } from 'react';
import { SectionCard } from '../../components/SectionCard.js';
import { api } from '../../api/client.js';

/**
 * /operator/security — keystore password rotation (Funds-Password).
 * Code moved from pages/configuration/SecuritySection.tsx (Task 5.6).
 *
 * Danger-zone section that owns the keystore password rotation flow.
 * Wraps the existing /v1/setup/change-password endpoint.
 */
export function SecurityTab(): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<'idle' | 'rotating' | 'rotated' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setStatus('rotating');
    setError(null);
    try {
      await api.changeKeystorePassword(current, next);
      setStatus('rotated');
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('failed');
    }
  };

  return (
    <div data-testid="security-tab">
      <SectionCard
        title="Security"
        summary="Rotate keystore password · last rotated never"
        metaChip={{ label: 'Danger zone', tone: 'danger' }}
        variant="danger"
        defaultExpanded={true}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
              Current password
            </span>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '14px',
                color: 'var(--fg)',
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
              New password
            </span>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '14px',
                color: 'var(--fg)',
              }}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => { void submit(); }}
          disabled={status === 'rotating' || current.length === 0 || next.length < 8}
          style={{
            alignSelf: 'flex-start',
            background: 'var(--break-red)',
            border: '1px solid var(--break-red)',
            color: 'var(--fg)',
            borderRadius: '6px',
            padding: '10px 20px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '14px',
            cursor: status === 'rotating' ? 'wait' : 'pointer',
          }}
        >
          {status === 'rotating' ? 'Rotating…' : 'Rotate password'}
        </button>
        {status === 'rotated' && (
          <span style={{ color: 'var(--vow-green)', fontSize: '12px' }}>
            Password rotated. Re-run jinn run with the new password.
          </span>
        )}
        {status === 'failed' && (
          <span style={{ color: 'var(--break-red)', fontSize: '12px' }}>Rotation failed: {error}</span>
        )}
      </SectionCard>
    </div>
  );
}
