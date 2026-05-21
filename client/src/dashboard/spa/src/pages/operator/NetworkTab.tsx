import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionCard } from '../../components/SectionCard.js';
import { ConfigField } from '../../components/ConfigField.js';
import { api } from '../../api/client.js';

/**
 * /operator/network — RPC + chain config (§2.11).
 * Code moved from pages/configuration/NetworkSection.tsx (Task 5.5).
 *
 * Network section: chain is read-only (changing chains is a state-reset
 * flow handled outside the dashboard); RPC URL is a free-text input that
 * can be reverted to the chain default by clearing it.
 */

interface BootstrapWithChain {
  chain?: 'base' | 'base-sepolia';
  rpcUrl?: string;
  defaultRpcUrl?: string;
}

export interface NetworkTabProps {
  onRestartPending?: () => void;
}

export function NetworkTab({
  onRestartPending = () => undefined,
}: NetworkTabProps = {}): JSX.Element {
  const { data } = useQuery<BootstrapWithChain>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithChain>,
    refetchInterval: 1500,
  });

  const chain = data?.chain ?? 'base-sepolia';
  const rpcUrl = data?.rpcUrl ?? '';
  const defaultRpcUrl =
    data?.defaultRpcUrl ??
    (chain === 'base'
      ? 'https://mainnet.base.org'
      : 'https://base-sepolia.gateway.tenderly.co/75tyLMQuD8EHpXxMwINIKu');

  return (
    <div data-testid="network-tab">
      <NetworkSectionContent
        chain={chain}
        rpcUrl={rpcUrl}
        defaultRpcUrl={defaultRpcUrl}
        rpcHealthy={true}
        onRestartPending={onRestartPending}
      />
    </div>
  );
}

interface NetworkSectionContentProps {
  chain: 'base' | 'base-sepolia';
  rpcUrl: string;
  defaultRpcUrl: string;
  rpcHealthy: boolean;
  onRestartPending: () => void;
}

function NetworkSectionContent({
  chain,
  rpcUrl,
  defaultRpcUrl,
  rpcHealthy,
  onRestartPending,
}: NetworkSectionContentProps): JSX.Element {
  const [draft, setDraft] = useState(rpcUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draft !== rpcUrl;
  // Surface a "shared RPC — bring your own" warning when the operator is
  // still on Jinn's shipped default. The default is a free public Tenderly
  // gateway shared with every default-config operator; reliable steady-state
  // operation requires the operator's own key. See contracts.ts comment.
  const onSharedDefault = rpcUrl === defaultRpcUrl;
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
      defaultExpanded={true}
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
          {onSharedDefault && (
            <div
              style={{
                marginTop: '12px',
                padding: '10px 12px',
                border: '1px solid var(--wane)',
                borderRadius: '6px',
                background: 'transparent',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
                lineHeight: 1.55,
                color: 'var(--fg)',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
              data-testid="network-shared-rpc-warning"
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '10px',
                  fontWeight: 500,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--wane)',
                }}
              >
                Shared RPC
              </span>
              <span>
                You're on the default RPC — a free public gateway shared with
                every operator on the default config. Fine for setup; not
                reliable under load. Get your own free key from{' '}
                <a
                  href="https://dashboard.tenderly.co/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-sky)' }}
                >
                  Tenderly
                </a>
                ,{' '}
                <a
                  href="https://www.alchemy.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-sky)' }}
                >
                  Alchemy
                </a>
                , or{' '}
                <a
                  href="https://www.quicknode.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-sky)' }}
                >
                  QuickNode
                </a>{' '}
                and paste it above.
              </span>
            </div>
          )}
        </ConfigField>
      </div>
    </SectionCard>
  );
}
