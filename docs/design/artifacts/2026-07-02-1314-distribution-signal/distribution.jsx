/* 1314 — Distribution signal · attached to the Network explorer view */
const { useState, useRef, useEffect, useLayoutEffect } = React;

// ---- format helpers (mirror explorer/src/lib/format.ts) ----
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const int = (n) => n == null ? '—' : intFmt.format(Math.round(n));
const pct = (n, d = 1) => n == null ? '—' : `${(n * 100).toFixed(d)}%`;

// ---- shared style atoms ----
const eyebrow = { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)' };
const dimCaps = { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-dim)' };

// ---- InfoTooltip (mirrors explorer/src/components/InfoTooltip.tsx) ----
function InfoTooltip({ children, label = 'More info' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const bodyRef = useRef(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const t = triggerRef.current; if (!t) return;
    const r = t.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 332) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function h(e) { const t = e.target; if (triggerRef.current && triggerRef.current.contains(t)) return; if (bodyRef.current && bodyRef.current.contains(t)) return; setOpen(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <span style={{ display: 'inline-flex', marginLeft: 6, verticalAlign: 'middle' }}>
      <button ref={triggerRef} type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen((p) => !p)}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, padding: 0, fontFamily: 'var(--font-mono)', fontSize: 9, lineHeight: 1, color: 'var(--fg-dim)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)', cursor: 'pointer' }}>?</button>
      {open && pos && ReactDOM.createPortal(
        <span ref={bodyRef} role="tooltip" style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000, minWidth: 260, maxWidth: 320, padding: '11px 13px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-2)', boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.55, color: 'var(--fg-muted)', letterSpacing: '0.01em', textTransform: 'none', fontWeight: 400 }}>{children}</span>,
        document.body)}
    </span>);
}

// ---- data: task-distribution clusters (env = envelope-only; seed = seeded/imported, excluded by default) ----
const CLUSTERS = [
{ name: 'Flaky test stabilisation', env: 4812, seed: 1560, contrib: 214, tags: ['testing', 'ci', 'retry'] },
{ name: 'Null-safety & crash fixes', env: 3190, seed: 980, contrib: 178, tags: ['null-deref', 'panics'] },
{ name: 'API pagination & limits', env: 2044, seed: 610, contrib: 133, tags: ['pagination', 'http'] },
{ name: 'Auth & middleware', env: 1102, seed: 240, contrib: 88, tags: ['auth', 'jwt'] },
{ name: 'Schema & validation', env: 870, seed: 150, contrib: 61, tags: ['json-schema'] },
{ name: 'Config & env migration', env: 540, seed: 90, contrib: 44, tags: ['toml', 'config'] },
{ name: 'Logging & observability', env: 388, seed: 70, contrib: 39, tags: ['logging', 'tracing'] },
{ name: 'Dependency hygiene', env: 205, seed: 40, contrib: 27, tags: ['deps', 'lint'] },
{ name: 'Docs & readme', env: 96, seed: 22, contrib: 18, tags: ['docs'] }];

const DISTINCT_CONTRIB = 512;

function totals(includeSeed) {
  const val = (c) => includeSeed ? c.env + c.seed : c.env;
  const rows = CLUSTERS.map((c) => ({ ...c, value: val(c) })).sort((a, b) => b.value - a.value);
  const sum = rows.reduce((a, c) => a + c.value, 0);
  const seedSum = CLUSTERS.reduce((a, c) => a + c.seed, 0);
  return { rows, sum, seedSum, top3: rows.slice(0, 3).reduce((a, c) => a + c.value, 0) };
}

// ================= explorer primitives (mirrored) =================
function Card({ title, children, style }) {
  return (
    <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-3)', padding: 24, ...style }}>
      {title && <>
        <div style={{ ...eyebrow, marginBottom: 16 }}>{title}</div>
        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '0 0 20px 0' }} />
      </>}
      {children}
    </section>);

}

function ActivityCell({ k, v, sub, first, serif = true, info }) {
  return (
    <div style={{ padding: first ? '0 24px 0 0' : '0 24px', borderLeft: first ? 'none' : '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ ...eyebrow, display: 'inline-flex', alignItems: 'center' }}>{k}{info && <InfoTooltip label={typeof k === 'string' ? k : 'info'}>{info}</InfoTooltip>}</div>
      <div style={{ fontFamily: serif ? 'var(--font-display)' : 'var(--font-mono)', fontSize: serif ? 40 : 26, lineHeight: 1, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{v}</div>
      {sub && <div style={{ ...dimCaps, fontSize: 11 }}>{sub}</div>}
    </div>);

}

function HBars({ rows, sum, includeSeed }) {
  return (
    <div>
      {rows.map((entry, i) => {
        const isFirst = i === 0;
        const share = entry.value / sum;
        const barColor = isFirst ? 'rgba(122,167,220,0.18)' : 'rgba(125,139,163,0.10)';
        const barBorder = isFirst ? 'rgba(122,167,220,0.55)' : 'rgba(125,139,163,0.30)';
        return (
          <div key={entry.name} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)', padding: '9px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5, gap: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: isFirst ? 'var(--fg)' : 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{entry.name}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {int(entry.value)}<span style={{ color: 'var(--fg-dim)', marginLeft: 6 }}>{pct(share)}</span>
                {includeSeed && entry.seed > 0 && <span style={{ color: 'var(--wane)', marginLeft: 8 }}>+{int(entry.seed)} seeded</span>}
              </span>
            </div>
            <div style={{ height: 6, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 'var(--radius-1)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.max(share * 100, 1)}%`, background: barColor, border: `1px solid ${barBorder}`, borderRadius: 'var(--radius-1)', transition: 'width var(--dur-slow) var(--ease-linear)' }} />
            </div>
          </div>);

      })}
    </div>);

}

function Chip({ children }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 'var(--radius-1)', padding: '2px 7px', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{children}</span>;
}

function Segmented({ value, options, onChange }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-2)', overflow: 'hidden' }}>
      {options.map((opt, i) => {
        const on = opt.key === value;
        return (
          <button key={opt.key} onClick={() => onChange(opt.key)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 13px', cursor: 'pointer',
            background: on ? 'var(--fg)' : 'transparent', color: on ? 'var(--bg)' : 'var(--fg-muted)',
            border: 'none', borderLeft: i === 0 ? 'none' : '1px solid var(--border)', transition: 'all var(--dur-fast) var(--ease-linear)' }}>
            {opt.label}
          </button>);

      })}
    </div>);

}

// ================= distribution section =================
function ActivityStrip() {
  return (
    <Card title="Activity">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <ActivityCell first k="Active operators" v="512" />
        <ActivityCell k="SolverNets running" v="7" sub="launched · accepting tasks" />
        <ActivityCell k="Last settlement" v="42,017,293" sub="block" serif={false} />
      </div>
    </Card>);

}

function DistributionSection() {
  const [mode, setMode] = useState('envelope'); // envelope | raw
  const includeSeed = mode === 'raw';
  const { rows, sum, seedSum, top3 } = totals(includeSeed);
  const lead = rows[0];

  const mainRows = rows.slice(0, 6);
  const tailRows = rows.slice(6);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* control row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ ...eyebrow, marginBottom: 6 }}>Where usage concentrates</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-muted)', maxWidth: '56ch', lineHeight: 1.5, letterSpacing: '-0.01em' }}>
            Tasks grouped by shape, sorted by volume — the network's read on where incentives should flow.
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <Segmented value={mode} onChange={setMode}
            options={[{ key: 'envelope', label: 'Envelope-only' }, { key: 'raw', label: 'Include seeded' }]} />
            <InfoTooltip label="Envelope-only vs include seeded">
              <strong style={{ color: 'var(--fg)', fontWeight: 600 }}>Envelope-only</strong> (default) counts only the runs operators produced on this network — the real signal.<br /><br />
              <strong style={{ color: 'var(--fg)', fontWeight: 600 }}>Include seeded</strong> also counts imported envelopes: prior task runs loaded from elsewhere to seed the corpus before real usage existed.<br /><br />
              Both are the same kind of thing — an <em>envelope</em> is one recorded past run. Seeded ones just weren't produced here, so they're held out of real-usage numbers by default.
            </InfoTooltip>
          </div>
          <div style={{ ...dimCaps, fontSize: 10, color: includeSeed ? 'var(--wane)' : 'var(--fg-dim)' }}>
            {includeSeed ? `+${int(seedSum)} seeded / imported now counted` : `${int(seedSum)} seeded / imported excluded`}
          </div>
        </div>
      </div>

      {/* headline stats */}
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <ActivityCell first k={includeSeed ? 'Envelopes · with seeded' : 'Envelopes · envelope-only'} v={int(sum)} sub={includeSeed ? 'seeded included' : 'seeded excluded'} data-comment-anchor="c2a8401444-div-51-7" info="An envelope is one recorded task run — its prompt, tool calls, diff, and outcome." />
          <ActivityCell k="Task groups" v={rows.length} sub="sorted by volume" />
          <ActivityCell k="Distinct contributors" v={int(DISTINCT_CONTRIB)} sub="not a sum of groups" />
          <ActivityCell k="Top-3 share" v={pct(top3 / sum, 0)} sub="of all signal" />
        </div>
      </Card>

      {/* single ranked view — the table IS the chart (per-row share bars) */}
      <Card title="Task groups · by volume" data-comment-anchor="adefc51733-div-40-9">
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-3)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-strong)' }}>
                {[['#', { w: 36 }], ['Task group', {}], ['Envelopes', { n: 1 }], includeSeed ? ['Seeded', { n: 1 }] : null, ['Contributors', { n: 1 }], ['Share', { n: 1, w: 88 }], ['Top tags', { pl: 24 }]].filter(Boolean).map(([label, o]) =>
                <th key={label} style={{ padding: '10px 16px', textAlign: o.n ? 'right' : 'left', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)', fontWeight: 500, whiteSpace: 'nowrap', width: o.w, paddingLeft: o.pl }}>{label}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {mainRows.map((c, i) => <Row key={c.name} c={c} i={i} sum={sum} includeSeed={includeSeed} />)}
              {tailRows.length > 0 && <>
                <tr><td colSpan={includeSeed ? 7 : 6} style={{ padding: '8px 16px 6px', background: 'var(--bg-sunken)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)', fontWeight: 500 }}>Long tail · low volume</td></tr>
                {tailRows.map((c, i) => <Row key={c.name} c={c} i={mainRows.length + i} sum={sum} includeSeed={includeSeed} dimmed />)}
              </>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>);

}

const cellBase = { padding: '11px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, verticalAlign: 'middle', color: 'var(--fg)', borderTop: '1px solid var(--border)' };
const cellNum = { ...cellBase, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function Row({ c, i, sum, includeSeed, dimmed }) {
  const share = c.value / sum;
  const rel = share / (CLUSTERS[0].env / CLUSTERS.reduce((a, x) => a + x.env, 0));
  return (
    <tr style={{ background: 'var(--bg-elevated)', opacity: dimmed ? 0.72 : 1, borderTop: i === 0 ? 'none' : undefined }}
    onMouseEnter={(e) => {e.currentTarget.style.background = 'var(--bg-sunken)';}}
    onMouseLeave={(e) => {e.currentTarget.style.background = 'var(--bg-elevated)';}}>
      <td style={{ ...cellBase, color: 'var(--fg-dim)', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>{i + 1}</td>
      <td style={{ ...cellBase, color: i === 0 ? 'var(--fg)' : 'var(--fg)', fontWeight: i === 0 ? 600 : 400, borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>{c.name}</td>
      <td style={{ ...cellNum, borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>{int(c.value)}</td>
      {includeSeed && <td style={{ ...cellNum, color: 'var(--wane)', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>{int(c.seed)}</td>}
      <td style={{ ...cellNum, borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>{int(c.contrib)}</td>
      <td style={{ ...cellNum, borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <span style={{ width: 52, height: 5, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 999, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.max(rel * 100, 3)}%`, background: i === 0 ? 'rgba(122,167,220,0.55)' : 'rgba(125,139,163,0.4)' }} />
          </span>
          <span style={{ color: 'var(--fg-dim)', minWidth: 38, textAlign: 'right' }}>{pct(share)}</span>
        </span>
      </td>
      <td style={{ ...cellBase, paddingLeft: 24, borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>{c.tags.map((t) => <Chip key={t}>{t}</Chip>)}</span>
      </td>
    </tr>);

}

// ---- status bar ----
function StatusBar({ degraded }) {
  return (
    <footer style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-sunken)', padding: '6px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--fg-dim)', textTransform: 'uppercase', fontVariantNumeric: 'tabular-nums' }}>
      <span>Indexed<span style={{ margin: '0 6px' }}>·</span>Block <span style={{ color: 'var(--fg)' }}>42,017,293</span><span style={{ margin: '0 6px' }}>·</span><span style={{ color: 'var(--fg)' }}>just now ago</span></span>
      {degraded && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--wane)', borderRadius: 'var(--radius-pill)', padding: '1px 8px', color: 'var(--wane)', fontSize: 9, letterSpacing: '0.12em' }}>Discovery: Degraded</span>}
    </footer>);

}

// ---- shell ----
function Chrome() {
  const nav = [['Network', true], ['SolverNets', false], ['Operators', false]];
  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 28px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
        <a href="#" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--fg)' }}>
          <svg width="22" height="22" viewBox="0 0 120 120" fill="none" style={{ opacity: .95 }}>
            <circle cx="60" cy="60" r="44" stroke="currentColor" strokeWidth="4" fill="none" />
            <path d="M60 22 L97 86 L23 86 Z" stroke="currentColor" strokeWidth="4" fill="none" />
            <line x1="16" y1="60" x2="104" y2="60" stroke="currentColor" strokeWidth="4" />
            <circle cx="60" cy="60" r="5" fill="currentColor" />
          </svg>
          <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 26, lineHeight: 1 }}>jinn</span>
          <span style={{ marginLeft: 8, borderLeft: '1px solid var(--border)', paddingLeft: 10, color: 'var(--fg-muted)', letterSpacing: '0.14em', textTransform: 'uppercase', fontSize: 11 }}>explorer</span>
        </a>
        <nav style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {nav.map(([label, active]) =>
          <a key={label} href="#" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 12px', textDecoration: 'none',
            color: active ? 'var(--fg)' : 'var(--fg-muted)', borderBottom: active ? '1px solid var(--accent)' : '1px solid transparent', paddingBottom: active ? 5 : 6 }}>{label}</a>
          )}
        </nav>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', padding: '6px 10px', width: 260, background: 'var(--bg-sunken)', borderRadius: 'var(--radius-2)' }}>
        <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>⌕</span>
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '-0.01em' }}>Search SolverNet, operator…</span>
      </div>
    </header>);

}

function Shell({ children, degraded }) {
  return (
    <div style={{ background: 'var(--bg)' }}>
      <Chrome />
      <main style={{ maxWidth: 1280, width: '100%', margin: '0 auto' }}>
        <div style={{ padding: '36px 28px 40px', display: 'flex', flexDirection: 'column', gap: 28 }}>{children}</div>
      </main>
      <StatusBar degraded={degraded} />
    </div>);

}

// ---- state views ----
function LoadedView() {
  return <div><ActivityStrip /><div style={{ height: 28 }} /><DistributionSection /></div>;
}
function LoadingView() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="skel" style={{ height: 100 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="skel" style={{ height: 16, width: 280, border: 'none' }} />
        <div className="skel" style={{ height: 30, width: 220 }} />
      </div>
      <div className="skel" style={{ height: 118 }} />
      <div className="skel" style={{ height: 250 }} />
      <div className="skel" style={{ height: 260 }} />
    </div>);

}
function ErrorView() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ActivityStrip />
      <div>
        <div style={{ ...eyebrow, marginBottom: 12 }}>Where usage concentrates</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--break-red)', border: '1px solid var(--break-red)', borderRadius: 'var(--radius-2)', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span>Failed to load distribution — the indexer is catching up.</span>
          <button style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--break-red)', border: '1px solid currentColor', borderRadius: 'var(--radius-1)', padding: '4px 10px', cursor: 'pointer', background: 'transparent' }}>Retry</button>
        </div>
      </div>
    </div>);

}
function EmptyView() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ActivityStrip />
      <Card title="Where usage concentrates">
        <div style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius-3)', padding: '44px 24px', textAlign: 'center', background: 'radial-gradient(rgba(220,184,102,0.10) 1px, transparent 1px)', backgroundSize: '16px 16px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--fg)', letterSpacing: '-0.01em' }}>No contributions yet — signal appears as the corpus grows.</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)', marginTop: 8 }}>Seeded and imported entries never count toward signal.</div>
        </div>
      </Card>
    </div>);

}

ReactDOM.createRoot(document.getElementById('app-root')).render(<Shell><LoadedView /></Shell>);
ReactDOM.createRoot(document.getElementById('state-loading')).render(<Shell><LoadingView /></Shell>);
ReactDOM.createRoot(document.getElementById('state-error')).render(<Shell degraded><ErrorView /></Shell>);
ReactDOM.createRoot(document.getElementById('state-empty')).render(<Shell><EmptyView /></Shell>);
