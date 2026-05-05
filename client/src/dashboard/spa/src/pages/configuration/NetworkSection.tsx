import { useState } from 'react';
import { SectionCard } from '../../components/SectionCard.js';
import { ConfigField } from '../../components/ConfigField.js';
import { api } from '../../api/client.js';

/**
 * Network section: chain is read-only (changing chains is a state-reset
 * flow handled outside the dashboard); RPC URL is a free-text input that
 * can be reverted to the chain default by clearing it.
 */
export interface NetworkSectionProps {
  chain: 'base' | 'base-sepolia';
  rpcUrl: string;
  defaultRpcUrl: string;
  rpcHealthy: boolean;
  onRestartPending: () => void;
  defaultExpanded?: boolean;
}

export function NetworkSection({
  chain,
  rpcUrl,
  defaultRpcUrl,
  rpcHealthy,
  onRestartPending,
  defaultExpanded = false,
}: NetworkSectionProps): JSX.Element {
  const [draft, setDraft] = useState(rpcUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draft !== rpcUrl;
  const chainLabel = chain === 'base' ? 'Base mainnet (chain id 8453)' : 'Base Sepolia (chain id 84532)';

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const next = draft.length === 0 ? null : draft;
      const res = await api.updateNetwork({ rpcUrl: next });
      if (res.restartRequired) onRestartPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Network"
      summary={`${chainLabel.split(' (')[0]} · ${rpcUrl}`}
      metaChip={{
        label: rpcHealthy ? 'Healthy' : 'Unreachable',
        tone: rpcHealthy ? 'live' : 'danger',
      }}
      defaultExpanded={defaultExpanded}
      dirty={
        dirty
          ? {
              pendingSummary: 'RPC URL changed · save to apply',
              saving,
              error: error ?? undefined,
              onSave: () => { void save(); },
              onCancel: () => { setDraft(rpcUrl); setError(null); },
            }
          : undefined
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <ConfigField
          label="Chain"
          helperText="Switching chains resets fleet state — that's a separate flow."
        >
          <div
            style={{
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              color: 'var(--fg-muted)',
            }}
          >
            {chainLabel}
          </div>
          <span
            style={{
              alignSelf: 'flex-start',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '9px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
              border: '1px solid var(--border)',
              borderRadius: '999px',
              padding: '1px 6px',
              marginTop: '6px',
            }}
          >
            locked
          </span>
        </ConfigField>
        <ConfigField
          label="RPC URL"
          restartRequired
          helperText={`Default: ${defaultRpcUrl}`}
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={defaultRpcUrl}
            style={{
              background: 'var(--bg)',
              border: `1px solid ${dirty ? 'var(--accent-sky)' : 'var(--border)'}`,
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              color: 'var(--fg)',
            }}
          />
          <button
            type="button"
            onClick={() => setDraft('')}
            style={{
              alignSelf: 'flex-start',
              background: 'transparent',
              border: 'none',
              color: 'var(--accent-sky)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              cursor: 'pointer',
              marginTop: '4px',
              padding: 0,
            }}
          >
            Use default
          </button>
        </ConfigField>
      </div>
    </SectionCard>
  );
}
