import { useState } from 'react';
import { api } from '../../api/client.js';

export interface ServiceIdentity {
  index: number;
  safeAddress: string;
  agentId: number | null;
  safeBoundToAgent: boolean;
}

export interface IdentityCardProps {
  agentId: number | null;
  chain: string;
  safeAddress: string | null;
  /** Per-service binding state. When any service has agentId set but
   *  safeBoundToAgent=false, the card surfaces a wane "binding pending"
   *  chip with an inline retry disclosure. See Issue #86 §6. */
  services?: ServiceIdentity[];
  bindingError?: string;
}

function trunc(addr: string | null | undefined): string {
  if (!addr || addr.length < 10) return addr ?? '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function IdentityCard({
  agentId,
  chain,
  safeAddress,
  services = [],
  bindingError,
}: IdentityCardProps): JSX.Element {
  const pendingBinding = services.find((s) => s.agentId !== null && !s.safeBoundToAgent);
  const [bindingOpen, setBindingOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<'success' | 'reverted' | null>(null);
  const [retryDetail, setRetryDetail] = useState<string | null>(bindingError ?? null);

  const retry = async (): Promise<void> => {
    if (!pendingBinding) return;
    setRetrying(true);
    setRetryResult(null);
    setRetryDetail(null);
    try {
      const res = await api.retryAgentBinding({ serviceIndex: pendingBinding.index });
      const attempt = res.attempts[0];
      if (attempt?.status === 'success') {
        setRetryResult('success');
        setBindingOpen(false);
      } else {
        setRetryResult('reverted');
        setRetryDetail(attempt?.detail ?? 'Bind reverted on chain.');
      }
    } catch (err) {
      setRetryResult('reverted');
      setRetryDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        fontFamily: "'JetBrains Mono', monospace",
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
        Identity
      </span>
      <div style={{ display: 'flex', gap: '32px', fontSize: '13px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)' }}>
            Agent
          </span>
          <span style={{ color: 'var(--fg)', display: 'flex', gap: '8px', alignItems: 'center' }}>
            {agentId !== null ? `#${agentId}` : '—'}
            {pendingBinding && (
              <button
                type="button"
                onClick={() => setBindingOpen((o) => !o)}
                style={{
                  fontSize: '9px',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  fontFamily: "'JetBrains Mono', monospace",
                  border: '1px solid var(--wane)',
                  color: 'var(--wane)',
                  background: 'transparent',
                  borderRadius: '999px',
                  padding: '1px 6px',
                  cursor: 'pointer',
                }}
              >
                binding pending
              </button>
            )}
            {retryResult === 'success' && (
              <span
                style={{
                  fontSize: '9px',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  border: '1px solid var(--vow-green)',
                  color: 'var(--vow-green)',
                  borderRadius: '999px',
                  padding: '1px 6px',
                }}
              >
                bound
              </span>
            )}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)' }}>
            Chain
          </span>
          <span style={{ color: 'var(--fg)' }}>{chain}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)' }}>
            Safe
          </span>
          <span style={{ color: 'var(--fg)' }}>{trunc(safeAddress)}</span>
        </div>
      </div>
      {bindingOpen && pendingBinding && (
        <div
          style={{
            marginTop: '8px',
            padding: '12px 14px',
            border: '1px solid var(--wane)',
            borderRadius: '6px',
            background: 'rgba(184, 128, 47, 0.07)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--fg)' }}>
            Service #{pendingBinding.index} Safe is not yet bound to agent #{pendingBinding.agentId}.
            The bootstrap left it unbound; retry to attempt the ERC-1271 bind again.
          </span>
          {retryDetail && (
            <span style={{ fontSize: '11px', color: 'var(--break-red)' }}>{retryDetail}</span>
          )}
          <button
            type="button"
            onClick={() => { void retry(); }}
            disabled={retrying}
            style={{
              alignSelf: 'flex-start',
              border: '1px solid var(--accent-sky)',
              background: 'var(--accent-sky)',
              color: 'var(--bg-sunken)',
              borderRadius: '6px',
              padding: '8px 14px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              cursor: retrying ? 'wait' : 'pointer',
            }}
          >
            {retrying ? 'Retrying…' : 'Retry binding'}
          </button>
        </div>
      )}
    </section>
  );
}
