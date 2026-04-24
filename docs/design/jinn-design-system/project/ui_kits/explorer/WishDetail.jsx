// Explorer — wish detail panel (scrying view)

const WishDetail = ({ wish, onClose }) => {
  if (!wish) return (
    <div style={{ padding: 40, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      <div className="label" style={{ marginBottom: 14 }}>No wish selected</div>
      <div className="wish" style={{ color: 'var(--fg-dim)', fontSize: 22 }}>Pick a wish from the left to read its scrying.</div>
    </div>
  );

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>wish &middot; {wish.id}</div>
          <h2 style={{ margin: 0, fontSize: 32, lineHeight: 1.1 }}>{wish.title}</h2>
        </div>
        <StatusChip kind={wish.status}>{wish.statusLabel}</StatusChip>
      </div>

      <div style={{ display: 'flex', gap: 28, padding: '16px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', marginBottom: 24 }}>
        <MetaItem label="Binder" value={wish.binder} />
        <MetaItem label="Bond" value={wish.bond} />
        <MetaItem label="Seers" value={wish.seers} />
        <MetaItem label="Block" value={wish.block} />
        <MetaItem label="Age" value={wish.age} />
      </div>

      <div className="label" style={{ marginBottom: 10 }}>The wish</div>
      <div className="wish" style={{ marginBottom: 28, color: 'var(--fg)' }}>
        "{wish.body}"
      </div>

      <div className="label" style={{ marginBottom: 10 }}>The scrying</div>
      <div style={{
        border: '1px solid var(--border)', background: 'var(--bg-sunken)',
        padding: 14, fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.7,
        color: 'var(--fg-muted)', maxHeight: 200, overflow: 'auto', borderRadius: 6,
      }}>
        {wish.log.map((line, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 70px 1fr', gap: 12 }}>
            <span style={{ color: 'var(--fg-dim)' }}>{line.t}</span>
            <span style={{ color: line.level === 'smoke' ? 'var(--gold)' : line.level === 'vow' ? 'var(--vow-green)' : 'var(--fg-dim)' }}>{line.level}</span>
            <span style={{ color: 'var(--fg)' }}>{line.msg}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 24, display: 'flex', gap: 10 }}>
        <button className="btn-primary">Bind to wish</button>
        <button className="btn">Copy address</button>
        <button className="btn" style={{ marginLeft: 'auto' }}>View on chain ↗</button>
      </div>
    </div>
  );
};

const MetaItem = ({ label, value }) => (
  <div style={{ minWidth: 0 }}>
    <div className="label" style={{ fontSize: 9, marginBottom: 4 }}>{label}</div>
    <div className="data" style={{ fontSize: 13, color: 'var(--fg)' }}>{value}</div>
  </div>
);

Object.assign(window, { WishDetail, MetaItem });
