export type ArtifactTypeFilter = 'plugin';

export interface ArtifactTypeFilterChipProps {
  value: ArtifactTypeFilter;
  onChange: (v: ArtifactTypeFilter) => void;
}

const chipStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  borderRadius: 'var(--radius-pill)',
  border: `1px solid ${active ? 'var(--accent-sky)' : 'var(--border)'}`,
  background: 'transparent',
  fontFamily: 'var(--mono)',
  fontSize: '11px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: disabled ? 'var(--fg-dim)' : active ? 'var(--accent-sky)' : 'var(--fg-muted)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
});

const soonStyle: React.CSSProperties = {
  fontSize: '9px',
  letterSpacing: '0.14em',
  color: 'var(--fg-dim)',
  paddingLeft: '6px',
  borderLeft: '1px solid var(--border)',
  marginLeft: '2px',
};

export function ArtifactTypeFilterChip({ value, onChange }: ArtifactTypeFilterChipProps): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <button
        type="button"
        aria-pressed={value === 'plugin' ? 'true' : 'false'}
        style={chipStyle(value === 'plugin', false)}
        onClick={() => {
          if (value !== 'plugin') onChange('plugin');
        }}
      >
        Plug-ins
      </button>
      <button
        type="button"
        disabled
        aria-pressed="false"
        style={chipStyle(false, true)}
      >
        Harnesses
        <span style={soonStyle}>Coming soon</span>
      </button>
    </div>
  );
}
