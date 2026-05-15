export type ArtifactTypeFilter = 'plugin';

export interface ArtifactTypeFilterChipProps {
  value: ArtifactTypeFilter;
  onChange: (v: ArtifactTypeFilter) => void;
}

const chipStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  borderRadius: 'var(--radius-pill, 999px)',
  border: `1px solid ${active ? 'var(--accent-sky)' : 'var(--border)'}`,
  background: active ? 'var(--accent-sky-tint, transparent)' : 'transparent',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: disabled ? 'var(--fg-dim)' : active ? 'var(--fg)' : 'var(--fg-muted)',
  cursor: disabled ? 'not-allowed' : 'pointer',
});

export function ArtifactTypeFilterChip({ value, onChange }: ArtifactTypeFilterChipProps): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <button
        aria-pressed={value === 'plugin' ? 'true' : 'false'}
        style={chipStyle(value === 'plugin', false)}
        onClick={() => {
          if (value !== 'plugin') onChange('plugin');
        }}
      >
        Plug-ins
      </button>
      <button
        disabled
        aria-pressed="false"
        style={chipStyle(false, true)}
      >
        Harnesses <span style={{ marginLeft: 6, fontSize: 9 }}>coming soon</span>
      </button>
    </div>
  );
}
