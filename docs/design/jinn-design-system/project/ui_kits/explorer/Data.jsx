// Explorer — data components

const StatusChip = ({ kind, children }) => {
  const map = {
    bound:   { color: 'var(--vow-green)', dashed: false },
    smoke:   { color: 'var(--slate-400)', dashed: true },
    wane:    { color: 'var(--wane)', dashed: false },
    broken:  { color: 'var(--break-red)', dashed: false },
    reading: { color: 'var(--seer-violet)', dashed: false },
  };
  const s = map[kind] || map.bound;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      color: s.color, border: `1px ${s.dashed ? 'dashed' : 'solid'} currentColor`,
      borderRadius: 999, padding: '2px 9px', fontSize: 10,
      letterSpacing: '0.14em', textTransform: 'uppercase',
      fontFamily: 'var(--font-mono)',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 999, background: 'currentColor' }}/>
      {children}
    </span>
  );
};

const KPI = ({ label, value, unit, delta }) => (
  <div style={{ padding: '18px 20px', borderRight: '1px solid var(--border)', flex: 1 }}>
    <div className="label" style={{ marginBottom: 10 }}>{label}</div>
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 38, lineHeight: 1 }}>
      <span className="data">{value}</span>
      {unit && <span style={{ fontSize: 14, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', marginLeft: 6, letterSpacing: '0.1em' }}>{unit}</span>}
    </div>
    {delta && (
      <div style={{ marginTop: 8, fontSize: 11, color: delta.startsWith('+') ? 'var(--vow-green)' : 'var(--break-red)', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>
        {delta} vs last epoch
      </div>
    )}
  </div>
);

const KPIRow = ({ children }) => (
  <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated)' }}>
    {children}
  </div>
);

// Wish table row
const WishRow = ({ wish, onClick, selected }) => (
  <tr
    onClick={onClick}
    style={{
      cursor: 'pointer',
      background: selected ? 'var(--bg-elevated)' : 'transparent',
      borderBottom: '1px solid var(--border)',
    }}
  >
    <td style={cell}><span className="data" style={{ color: 'var(--accent)' }}>{wish.id}</span></td>
    <td style={cell}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, lineHeight: 1.2, marginBottom: 2 }}>{wish.title}</div>
      <div style={{ fontSize: 10, color: 'var(--fg-muted)', letterSpacing: '0.05em' }}>{wish.binder}</div>
    </td>
    <td style={cell}><StatusChip kind={wish.status}>{wish.statusLabel}</StatusChip></td>
    <td style={{ ...cell, textAlign: 'right' }} className="data">{wish.seers}</td>
    <td style={{ ...cell, textAlign: 'right' }} className="data">{wish.bond}</td>
    <td style={{ ...cell, textAlign: 'right', color: 'var(--fg-muted)' }} className="data">{wish.age}</td>
  </tr>
);

const cell = {
  padding: '12px 16px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  verticalAlign: 'middle',
};

const TableHead = ({ cols }) => (
  <thead>
    <tr style={{ borderBottom: '1px solid var(--border-strong)' }}>
      {cols.map((c, i) => (
        <th key={i} style={{
          textAlign: c.right ? 'right' : 'left',
          padding: '10px 16px',
          fontFamily: 'var(--font-mono)', fontSize: 9,
          letterSpacing: '0.14em', textTransform: 'uppercase',
          color: 'var(--fg-muted)', fontWeight: 500,
        }}>{c.label}</th>
      ))}
    </tr>
  </thead>
);

Object.assign(window, { StatusChip, KPI, KPIRow, WishRow, TableHead });
