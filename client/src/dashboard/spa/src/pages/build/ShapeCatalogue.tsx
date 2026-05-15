import { PLUGIN_SHAPE_FIELDS, PLUGIN_MODES } from './shape-fields.js';

const headStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: 'var(--fg-muted)',
};

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontSize: '13px',
  color: 'var(--fg)',
  verticalAlign: 'top',
};

export function ShapeCatalogue(): JSX.Element {
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3, 10px)',
        padding: '24px',
        background: 'var(--surface)',
      }}
    >
      <h2 style={{ marginTop: 0 }}>Plug-in shape</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '24px' }}>
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
              <td style={{ ...cellStyle, fontFamily: "'JetBrains Mono', monospace" }}>{f.name}</td>
              <td style={{ ...cellStyle, fontFamily: "'JetBrains Mono', monospace", color: 'var(--fg-muted)' }}>
                {f.type}
              </td>
              <td style={cellStyle}>{f.required ? 'yes' : 'no'}</td>
              <td style={cellStyle}>{f.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Two modes</h3>
      <p style={{ color: 'var(--fg-muted)' }}>
        The validator enforces exactly two exclusive modes. Mixing is rejected.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {PLUGIN_MODES.map((m) => (
          <div
            key={m.id}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2, 6px)',
              padding: '12px',
            }}
          >
            <h4 style={{ marginTop: 0 }}>{m.label}</h4>
            <p style={{ color: 'var(--fg-muted)', fontSize: '13px' }}>{m.requires}</p>
            <pre style={{ background: 'var(--surface-sunken)', padding: '8px', fontSize: '12px' }}>
              <code>{m.example}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}
