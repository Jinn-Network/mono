import { useState } from 'react';
import { SectionCard } from '../../components/SectionCard.js';
import { ConfigField } from '../../components/ConfigField.js';
import { api } from '../../api/client.js';

/**
 * Harness configuration section: allows toggling between train and frozen modes.
 * Train mode contributes to the substrate (learning); frozen mode produces benchmark snapshots.
 */
export interface HarnessSectionProps {
  mode: 'train' | 'frozen';
  onRestartPending: () => void;
  defaultExpanded?: boolean;
}

export function HarnessSection({
  mode,
  onRestartPending,
  defaultExpanded = false,
}: HarnessSectionProps): JSX.Element {
  const [draft, setDraft] = useState(mode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draft !== mode;
  const modeDescription = draft === 'train'
    ? 'Learning mode: harness contributes training signal to the substrate'
    : 'Frozen mode: harness produces benchmark snapshots without contributing';

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateHarnessMode(draft);
      if (res.restartRequired) onRestartPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Harness"
      summary={`Mode: ${mode} · ${modeDescription.slice(0, 40)}…`}
      metaChip={{
        label: mode === 'train' ? 'Contributing' : 'Benchmarking',
        tone: mode === 'train' ? 'live' : 'attention',
      }}
      defaultExpanded={defaultExpanded}
      dirty={
        dirty
          ? {
              pendingSummary: 'Mode changed · save to apply',
              saving,
              error: error ?? undefined,
              onSave: () => { void save(); },
              onCancel: () => { setDraft(mode); setError(null); },
            }
          : undefined
      }
    >
      <ConfigField label="Execution mode" restartRequired>
        <div style={{ display: 'flex', gap: '16px', flexDirection: 'column' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input
              type="radio"
              name="harness-mode"
              value="train"
              checked={draft === 'train'}
              onChange={() => setDraft('train')}
              style={{ cursor: 'pointer' }}
            />
            <span>
              <span style={{ display: 'block', fontWeight: 500 }}>Train</span>
              <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>
                Contribute learning signal to improve the substrate
              </span>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input
              type="radio"
              name="harness-mode"
              value="frozen"
              checked={draft === 'frozen'}
              onChange={() => setDraft('frozen')}
              style={{ cursor: 'pointer' }}
            />
            <span>
              <span style={{ display: 'block', fontWeight: 500 }}>Frozen</span>
              <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>
                Benchmark harness without feeding training signal
              </span>
            </span>
          </label>
        </div>
      </ConfigField>
    </SectionCard>
  );
}
