// Explorer components — Jinn
// All components are globally available for the index.html

const Sigil = ({ src, size = 16 }) => (
  <img src={src} style={{ width: size, height: size, filter: 'brightness(0) invert(1) opacity(0.95)' }} alt="" />
);

const Logo = () => (
  <a href="#" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--fg)' }}>
    <img src="../../assets/logo-sigil.svg" style={{ width: 22, height: 22, filter: 'brightness(0) invert(1) opacity(0.95)' }} alt="" />
    <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 26, lineHeight: 1 }}>jinn</span>
    <span className="label" style={{ marginLeft: 10, borderLeft: '1px solid var(--border)', paddingLeft: 10, color: 'var(--fg-muted)' }}>explorer</span>
  </a>
);

const TopNav = ({ route, onNav }) => {
  const items = [
    { k: 'wishes', label: 'Wishes' },
    { k: 'vessels', label: 'Vessels' },
    { k: 'seers', label: 'Seers' },
    { k: 'ether', label: 'Ether' },
  ];
  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 28px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
        <Logo />
        <nav style={{ display: 'flex', gap: 4 }}>
          {items.map(i => (
            <button key={i.k} onClick={() => onNav(i.k)} style={{
              fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.08em',
              padding: '6px 12px', background: 'transparent', border: 0, cursor: 'pointer',
              color: route === i.k ? 'var(--fg)' : 'var(--fg-muted)',
              borderBottom: route === i.k ? '1px solid var(--accent)' : '1px solid transparent',
              textTransform: 'uppercase',
            }}>{i.label}</button>
          ))}
        </nav>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <SearchBox />
        <button className="btn-primary">Summon outcome →</button>
      </div>
    </header>
  );
};

const SearchBox = () => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    border: '1px solid var(--border)', padding: '6px 10px',
    width: 260, background: 'var(--bg-sunken)', borderRadius: 6,
  }}>
    <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>⌕</span>
    <input placeholder="Search wish, vessel, block…" style={{
      background: 'transparent', border: 0, color: 'var(--fg)', width: '100%',
      fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
    }} />
    <span className="label" style={{ fontSize: 9, border: '1px solid var(--border)', padding: '1px 5px', color: 'var(--fg-muted)' }}>⌘K</span>
  </div>
);

const StatusBar = ({ blockHeight, vessels, smoke }) => (
  <div style={{
    position: 'fixed', bottom: 0, left: 0, right: 0,
    borderTop: '1px solid var(--border)', background: 'var(--bg-sunken)',
    padding: '6px 28px', display: 'flex', justifyContent: 'space-between',
    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
    color: 'var(--fg-muted)', textTransform: 'uppercase', zIndex: 10,
  }}>
    <div style={{ display: 'flex', gap: 24 }}>
      <span>ether &middot; <span style={{ color: 'var(--vow-green)' }}>●</span> stable</span>
      <span>block <span style={{ color: 'var(--fg)' }} className="data">{blockHeight.toLocaleString()}</span></span>
      <span>vessels <span style={{ color: 'var(--fg)' }} className="data">{vessels.toLocaleString()}</span></span>
      <span>in smoke <span style={{ color: 'var(--gold)' }} className="data">{smoke}</span></span>
    </div>
    <div>last vow &middot; 00:00:08 ago</div>
  </div>
);

Object.assign(window, { Sigil, Logo, TopNav, SearchBox, StatusBar });
