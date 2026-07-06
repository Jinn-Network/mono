/* corpus-shared.jsx — explorer primitives (mirrored from spa/src) + the shared corpus dataset.
   Used by 1406 (Corpus tab) and 1407 (Corpus card). All exports land on window. */
const { useState, useRef, useEffect, useLayoutEffect } = React;

// ---- format helpers (mirror explorer/src/lib/format.ts) ----
const corpusIntFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const cInt = (n) => n == null ? '—' : corpusIntFmt.format(Math.round(n));
const cPct = (n, d = 1) => n == null ? '—' : `${(n * 100).toFixed(d)}%`;
const cShortCid = (cid, head = 8, tail = 6) => !cid ? '—' : cid.length <= head + tail + 1 ? cid : `${cid.slice(0, head)}…${cid.slice(-tail)}`;
const cShortAddr = (hex) => !hex ? '—' : `${hex.slice(0, 6)}…${hex.slice(-4)}`;

// ---- shared style atoms ----
const corpusEyebrow = { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)' };
const corpusDimCaps = { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-dim)' };
const corpusCellBase = { padding: '11px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, verticalAlign: 'middle', color: 'var(--fg)', borderTop: '1px solid var(--border)' };
const corpusCellNum = { ...corpusCellBase, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

// =====================================================================
// DATA — one plausible-future corpus, shared by the card and the tab
// =====================================================================

// Clusters. env = envelope-only count; seed = seeded/imported (excluded by default).
const CORPUS_CLUSTERS = [
  { name: 'jinn-agent',   env: 741, seed: 0,  contrib: 17, tags: ['cli', 'swe'] },
  { name: 'jinn-hermes',  env: 214, seed: 0,  contrib: 6,  tags: ['cli', 'gateway'] },
  { name: 'codex-swe',    env: 186, seed: 0,  contrib: 9,  tags: ['swe', 'tests'] },
  { name: 'web-research', env: 87,  seed: 0,  contrib: 4,  tags: ['browser'] },
  { name: 'datagen',      env: 38,  seed: 0,  contrib: 2,  tags: ['batch'] },
  { name: 'acp-adapter',  env: 2,   seed: 0,  contrib: 1,  tags: ['acp'] },
  // seed-import exists only when seeds are folded back in:
  { name: 'seed-import',  env: 0,   seed: 84, contrib: 1,  tags: ['skills', 'azure-skills', 'cli'], seededOnly: true },
];
const CORPUS_DISTINCT_CONTRIB = 23;
const CORPUS_SEED_TOTAL = 84;

function corpusTotals(includeSeed) {
  const rows = CORPUS_CLUSTERS
    .map((c) => ({ ...c, value: includeSeed ? c.env + c.seed : c.env }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
  const sum = rows.reduce((a, c) => a + c.value, 0);
  return { rows, sum };
}

// The seam item — the envelope the 1405 CLI flow publishes and deep-links to.
const SEAM_CID = 'bafkreid6qvteh3z4mci4xk3yjkfhslq2y5nqz7uu6zj5j5rghslknshxv4';

// Corpus items — index rows, newest first. tier: user-accepted | tests-passed | evaluator-verified
const CORPUS_ITEMS = [
  { cid: SEAM_CID, summary: 'fix flaky retry in http client', cluster: 'jinn-agent', tier: 'tests-passed', contributor: '0x91be44f0aa10e2c1b34c92e5f7d80337a90244a2', model: 'gpt-5.4-mini', steps: 6, age: '2m ago' },
  { cid: 'bafkreihx2c0d9a4qmz7ee1u8vv3jj6yy2pp0qq5rr8ss1tt4uu7vv0wq', summary: 'null-deref in markdown table parser', cluster: 'jinn-agent', tier: 'evaluator-verified', contributor: '0x3fA79bb210cD3a4E88c05B12aF0e6D97c441Be09', model: 'gpt-5.4-mini', steps: 9, age: '11m ago' },
  { cid: 'bafkreig7m1n4p8q2r5s9t3u6v0w4x8y1z5a9b2c6d0e4f8g1h5i9j3kd', summary: 'add pagination to results endpoint', cluster: 'codex-swe', tier: 'tests-passed', contributor: '0xB20cE47d19fA83C6b5D2E90a1F4c7803Db56Ea11', model: 'codex-52', steps: 7, age: '38m ago' },
  { cid: 'bafkreie2f6g0h4i8j1k5l9m3n7o0p4q8r2s6t9u3v7w0x4y8z2a6b0cu', summary: 'summarise weekly RFC changes across repos', cluster: 'web-research', tier: 'user-accepted', contributor: '0x91be44f0aa10e2c1b34c92e5f7d80337a90244a2', model: 'gpt-5.4-mini', steps: 12, age: '1h ago' },
  { cid: 'bafkreia9b3c7d1e5f9g2h6i0j4k8l1m5n9o3p7q0r4s8t2u6v9w3x7yg', summary: 'harden json schema validation on intake', cluster: 'jinn-agent', tier: 'tests-passed', contributor: '0x77De09aB44c1F2E6a8B0d35C9f1E4807bA23Cd58', model: 'hermes-4-405b', steps: 5, age: '2h ago' },
  { cid: 'bafkreif4g8h2i6j0k4l7m1n5o9p2q6r0s4t8u1v5w9x3y7z0a4b8c2dm', summary: 'route gateway retries through backoff budget', cluster: 'jinn-hermes', tier: 'evaluator-verified', contributor: '0x1Cc4807bA23Cd58e91F0a6B2d47E3905fA81Be72', model: 'hermes-4-405b', steps: 8, age: '3h ago' },
  { cid: 'bafkreib1c5d9e3f7g0h4i8j2k6l9m3n7o1p5q8r2s6t0u4v8w1x5y9zi', summary: 'migrate cron blueprints to toml config', cluster: 'jinn-agent', tier: 'user-accepted', contributor: '0x3fA79bb210cD3a4E88c05B12aF0e6D97c441Be09', model: 'gpt-5.4-mini', steps: 4, age: '5h ago' },
  { cid: 'bafkreih8i2j6k0l4m7n1o5p9q2r6s0t4u8v1w5x9y3z7a0b4c8d2e6fa', summary: 'batch-generate browser task fixtures', cluster: 'datagen', tier: 'user-accepted', contributor: '0xE47d19fA83C6b5D2E90a1F4c7803Db56Ea11B20c', model: 'codex-52', steps: 15, age: '7h ago' },
  { cid: 'bafkreic3d7e1f5g9h2i6j0k4l8m1n5o9p3q7r0s4t8u2v6w9x3y7z1ao', summary: 'fix off-by-one in results paginator', cluster: 'codex-swe', tier: 'tests-passed', contributor: '0xB20cE47d19fA83C6b5D2E90a1F4c7803Db56Ea11', model: 'codex-52', steps: 6, age: '9h ago' },
  { cid: 'bafkreid0e4f8g2h6i9j3k7l1m5n8o2p6q0r4s8t1u5v9w3x7y0z4a8bw', summary: 'wire structured logging into acp adapter', cluster: 'acp-adapter', tier: 'user-accepted', contributor: '0x77De09aB44c1F2E6a8B0d35C9f1E4807bA23Cd58', model: 'gpt-5.4-mini', steps: 7, age: '12h ago' },
];

// The seam item's full detail.
const CORPUS_DETAIL = {
  cid: SEAM_CID,
  summary: 'fix flaky retry in http client',
  cluster: 'jinn-agent',
  harness: 'jinn-agent v0.4.2',
  model: 'gpt-5.4-mini',
  tier: 'tests-passed',
  tags: ['cli', 'swe', 'retry'],
  contributor: '0x91be44f0aa10e2c1b34c92e5f7d80337a90244a2',
  createdAt: '2m ago',
  anchorTx: '0x7a2f9e01d44b8c3a6f5e2d90b1a4c7e8f3d6a9b2c5e8f1a4d7b0c3e6c019',
  scrub: '12 secrets removed · 3 paths anonymised',
  toolSteps: [
    { tool: 'read',  line: 'http/client.py', payload: { args: 'path: http/client.py · lines 1–240', result: '240 lines · retry loop at 118–146' } },
    { tool: 'bash',  line: 'pytest -k retry — 1 failed', fail: true, payload: { args: 'pytest tests/ -k retry -x', result: 'FAILED test_retry_backoff — 429 backoff dropped on second attempt' } },
    { tool: 'edit',  line: 'http/client.py · +14 −6', payload: { args: 'replace retry loop 118–146', result: 'backoff carried across attempts; jitter clamped to budget' } },
    { tool: 'bash',  line: 'pytest -k retry — 4 passed', payload: { args: 'pytest tests/ -k retry', result: '4 passed in 2.1s' } },
    { tool: 'write', line: 'tests/test_retry_budget.py · +38', payload: { args: 'new file, 38 lines', result: '3 tests added — budget exhaustion, jitter bounds, 429 carry' } },
    { tool: 'bash',  line: 'pytest — suite green', payload: { args: 'pytest tests/', result: '212 passed in 41s' } },
  ],
};

// =====================================================================
// PRIMITIVES — mirrored from spa/src/components
// =====================================================================

function CorpusInfoTooltip({ children, label = 'More info' }) {
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

function CorpusCardShell({ title, children, style }) {
  return (
    <section style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-3)', padding: 24, ...style }}>
      {title && <>
        <div style={{ ...corpusEyebrow, marginBottom: 16 }}>{title}</div>
        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '0 0 20px 0' }} />
      </>}
      {children}
    </section>);
}

// StatusChip — verbatim visual rules from spa StatusChip.tsx; corpus tiers added.
// evaluator-verified uses --gold-600 (the muted lamplight the spa already uses for
// 'frozen') so table chips never compete with the surface's one gold hero.
const CORPUS_TIER_COLOR = {
  'user-accepted': 'var(--accent)',
  'tests-passed': 'var(--vow-green)',
  'evaluator-verified': 'var(--gold-600)',
};
function CorpusStatusChip({ kind, label }) {
  const color = CORPUS_TIER_COLOR[kind] || 'var(--fg-dim)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color, border: '1px solid currentColor', borderRadius: 'var(--radius-pill)', padding: '2px 9px', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', fontWeight: 500, whiteSpace: 'nowrap' }}>
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: 'currentColor', flexShrink: 0 }}></span>
      {label || kind}
    </span>);
}

function CorpusChip({ children }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 'var(--radius-1)', padding: '2px 7px', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{children}</span>;
}

function CorpusSegmented({ value, options, onChange }) {
  return (
    <div role="group" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-1)', overflow: 'hidden' }}>
      {options.map((opt) => {
        const on = opt.key === value;
        return (
          <button key={opt.key} type="button" aria-pressed={on} onClick={() => onChange(opt.key)}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase', padding: '5px 12px', border: 'none', borderRight: '1px solid var(--border)', cursor: 'pointer', background: on ? 'var(--bg-sunken)' : 'transparent', color: on ? 'var(--fg)' : 'var(--fg-dim)', transition: 'background var(--dur-fast) var(--ease-linear), color var(--dur-fast) var(--ease-linear)' }}>
            {opt.label}
          </button>);
      })}
    </div>);
}

function CorpusHBars({ rows, sum, includeSeed, title }) {
  return (
    <div>
      {title && <div style={{ ...corpusEyebrow, fontSize: 'var(--text-xs)', marginBottom: 10 }}>{title}</div>}
      {rows.map((entry, i) => {
        const isFirst = i === 0;
        const share = entry.value / sum;
        return (
          <div key={entry.name} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)', padding: '8px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5, gap: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: isFirst ? 'var(--fg)' : 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{entry.name}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {cInt(entry.value)}<span style={{ color: 'var(--fg-dim)', marginLeft: 6 }}>{cPct(share)}</span>
                {includeSeed && entry.seed > 0 && <span style={{ color: 'var(--wane)', marginLeft: 8 }}>seeded</span>}
              </span>
            </div>
            <div style={{ height: 6, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 'var(--radius-1)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.max(share * 100, 1)}%`, background: isFirst ? 'rgba(122,167,220,0.18)' : 'rgba(125,139,163,0.10)', border: `1px solid ${isFirst ? 'rgba(122,167,220,0.55)' : 'rgba(125,139,163,0.30)'}`, borderRadius: 'var(--radius-1)', transition: 'width var(--dur-slow) var(--ease-linear)' }}></div>
            </div>
          </div>);
      })}
    </div>);
}

function CorpusStatusBar({ degraded }) {
  return (
    <footer style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-sunken)', padding: '6px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--fg-dim)', textTransform: 'uppercase', fontVariantNumeric: 'tabular-nums' }}>
      <span>Indexed<span style={{ margin: '0 6px' }}>·</span>Block <span style={{ color: 'var(--fg)' }}>43,611,254</span><span style={{ margin: '0 6px' }}>·</span><span style={{ color: 'var(--fg)' }}>just now</span><span style={{ margin: '0 6px' }}>·</span><span style={{ color: 'var(--fg)' }}>41%</span> enriched</span>
      {degraded && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--wane)', borderRadius: 'var(--radius-pill)', padding: '1px 8px', color: 'var(--wane)', fontSize: 9, letterSpacing: '0.12em' }}>Discovery: Degraded</span>}
    </footer>);
}

// Chrome — with Corpus as the fourth primary nav item (#1406; spec §4 open question, resolved here).
function CorpusChrome({ active }) {
  const nav = ['Network', 'SolverNets', 'Operators', 'Corpus'];
  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 28px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
        <a href="#" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--fg)' }}>
          <svg width="22" height="22" viewBox="0 0 120 120" fill="none" style={{ opacity: .95 }}>
            <circle cx="60" cy="60" r="44" stroke="currentColor" strokeWidth="4" fill="none"></circle>
            <path d="M60 22 L97 86 L23 86 Z" stroke="currentColor" strokeWidth="4" fill="none"></path>
            <line x1="16" y1="60" x2="104" y2="60" stroke="currentColor" strokeWidth="4"></line>
            <circle cx="60" cy="60" r="5" fill="currentColor"></circle>
          </svg>
          <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 26, lineHeight: 1 }}>jinn</span>
          <span style={{ marginLeft: 8, borderLeft: '1px solid var(--border)', paddingLeft: 10, color: 'var(--fg-muted)', letterSpacing: '0.14em', textTransform: 'uppercase', fontSize: 11 }}>explorer</span>
        </a>
        <nav style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {nav.map((label) =>
            <a key={label} href="#" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 12px', textDecoration: 'none', color: label === active ? 'var(--fg)' : 'var(--fg-muted)', borderBottom: label === active ? '1px solid var(--accent)' : '1px solid transparent', paddingBottom: label === active ? 5 : 6 }}>{label}</a>
          )}
        </nav>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', padding: '6px 10px', width: 260, background: 'var(--bg-sunken)', borderRadius: 'var(--radius-2)' }}>
        <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>⌕</span>
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '-0.01em' }}>Search SolverNet, operator…</span>
      </div>
    </header>);
}

function CorpusShell({ children, active, degraded }) {
  return (
    <div style={{ background: 'var(--bg)' }}>
      <CorpusChrome active={active} />
      <main style={{ maxWidth: 1280, width: '100%', margin: '0 auto' }}>
        <div style={{ padding: '36px 28px 40px', display: 'flex', flexDirection: 'column', gap: 24 }}>{children}</div>
      </main>
      <CorpusStatusBar degraded={degraded} />
    </div>);
}

Object.assign(window, {
  cInt, cPct, cShortCid, cShortAddr,
  corpusEyebrow, corpusDimCaps, corpusCellBase, corpusCellNum,
  CORPUS_CLUSTERS, CORPUS_DISTINCT_CONTRIB, CORPUS_SEED_TOTAL, corpusTotals,
  SEAM_CID, CORPUS_ITEMS, CORPUS_DETAIL,
  CorpusInfoTooltip, CorpusCardShell, CorpusStatusChip, CORPUS_TIER_COLOR,
  CorpusChip, CorpusSegmented, CorpusHBars, CorpusStatusBar, CorpusChrome, CorpusShell,
});
