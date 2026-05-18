import { PLUGIN_SHAPE_FIELDS, PLUGIN_MODES } from './shape-fields.js';
import { PanelCard } from '../../components/PanelCard.js';

const headStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--mono)',
  fontSize: '11px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: 'var(--fg-dim)',
};

const cellStyle: React.CSSProperties = {
  padding: '12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--mono)',
  fontSize: '13px',
  lineHeight: 1.6,
  color: 'var(--fg)',
  verticalAlign: 'top',
};

const cellMuted: React.CSSProperties = {
  ...cellStyle,
  color: 'var(--fg-muted)',
};

const requiredChip = (required: boolean): React.CSSProperties => ({
  display: 'inline-block',
  fontFamily: 'var(--mono)',
  fontSize: '10px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  padding: '2px 8px',
  borderRadius: 'var(--radius-1)',
  border: `1px solid ${required ? 'var(--accent-sky)' : 'var(--border)'}`,
  color: required ? 'var(--accent-sky)' : 'var(--fg-dim)',
});

export function ShapeCatalogue(): JSX.Element {
  return (
    <PanelCard>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '20px' }}>
        <span className="j-label">Reference</span>
        <h2
          className="j-display"
          style={{
            fontSize: '28px',
            lineHeight: 1.2,
            color: 'var(--fg)',
            margin: 0,
          }}
        >
          Plug-in shape
        </h2>
      </div>

      <div style={{ overflowX: 'auto', marginBottom: '32px' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            borderTop: '1px solid var(--border)',
          }}
        >
          <thead>
            <tr>
              <th style={headStyle}>Field</th>
              <th style={headStyle}>Type</th>
              <th style={headStyle}>Required</th>
              <th style={headStyle}>Description</th>
            </tr>
          </thead>
          <tbody>
            {PLUGIN_SHAPE_FIELDS.map((f) => (
              <tr key={f.name} data-field-required={f.required ? 'true' : 'false'}>
                <td style={{ ...cellStyle, color: 'var(--accent-sky)' }}>{f.name}</td>
                <td style={cellMuted}>{f.type}</td>
                <td style={cellStyle}>
                  <span style={requiredChip(f.required)}>{f.required ? 'yes' : 'no'}</span>
                </td>
                <td style={cellMuted}>{f.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px' }}>
        <span className="j-label">Modes</span>
        <h3
          className="j-display"
          style={{ fontSize: '22px', lineHeight: 1.25, color: 'var(--fg)', margin: 0 }}
        >
          Two modes
        </h3>
        <p
          className="j-mono"
          style={{
            color: 'var(--fg-muted)',
            fontSize: '13px',
            lineHeight: 1.7,
            margin: '4px 0 0',
            maxWidth: '72ch',
          }}
        >
          The validator enforces exactly two exclusive modes. Mixing is rejected.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {PLUGIN_MODES.map((m) => (
          <div
            key={m.id}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2)',
              padding: '16px',
              background: 'var(--bg-sunken)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <span className="j-label">{m.id === 'runtime' ? 'Mode · 01' : 'Mode · 02'}</span>
            <h4
              className="j-mono"
              style={{
                fontSize: '15px',
                fontWeight: 500,
                color: 'var(--fg)',
                margin: 0,
                letterSpacing: '-0.01em',
              }}
            >
              {m.label}
            </h4>
            <p
              className="j-mono"
              style={{
                color: 'var(--fg-muted)',
                fontSize: '12px',
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              {m.requires}
            </p>
            <pre
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-1)',
                padding: '10px 12px',
                fontFamily: 'var(--mono)',
                fontSize: '12px',
                lineHeight: 1.5,
                color: 'var(--accent-sky)',
                margin: 0,
                overflowX: 'auto',
              }}
            >
              <code>{m.example}</code>
            </pre>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}
