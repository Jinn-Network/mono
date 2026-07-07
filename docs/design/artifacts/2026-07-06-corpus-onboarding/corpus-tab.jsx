/* corpus-tab.jsx — 1406 · the Corpus tab: index + detail + empty + not-found */
const { useState: useTabState } = React;

// ---- tier → chip (shared mapping) ----
function TierChip({ tier }) { return <CorpusStatusChip kind={tier} />; }

// =====================================================================
// INDEX VIEW — /corpus
// =====================================================================
const CORPUS_COLUMNS = [
  { key: 'summary', label: 'Contribution', sortable: false },
  { key: 'cluster', label: 'Cluster', sortable: true },
  { key: 'tier', label: 'Tier', sortable: true },
  { key: 'contributor', label: 'Contributor', sortable: false },
  { key: 'steps', label: 'Steps', numeric: true, sortable: false },
  { key: 'createdAt', label: 'Age', numeric: true, sortable: true, active: true },
];

function IndexHead() {
  return (
    <thead>
      <tr style={{ background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-strong)' }}>
        {CORPUS_COLUMNS.map((col) =>
          <th key={col.key} style={{ padding: '10px 16px', textAlign: col.numeric ? 'right' : 'left', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: col.active ? 'var(--fg-muted)' : 'var(--fg-dim)', fontWeight: 500, cursor: col.sortable ? 'pointer' : 'default', whiteSpace: 'nowrap', userSelect: 'none' }}>
            {col.label}
            {col.sortable && <span aria-hidden="true" style={{ marginLeft: 4, opacity: col.active ? 1 : 0.3 }}>▾</span>}
          </th>
        )}
      </tr>
    </thead>);
}

function IndexRow({ item, i, hot }) {
  const first = i === 0;
  const bt = first ? 'none' : '1px solid var(--border)';
  return (
    <tr style={{ background: 'var(--bg-elevated)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-sunken)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}>
      <td style={{ ...corpusCellBase, borderTop: bt }}>
        <a href="#" style={{ color: 'var(--accent)', textDecoration: 'none', display: 'block', lineHeight: 1.3 }}>
          <span style={{ fontSize: 12.5 }}>{item.summary}</span>
          <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>{cShortCid(item.cid)}</span>
        </a>
      </td>
      <td style={{ ...corpusCellBase, borderTop: bt }}><CorpusChip>{item.cluster}</CorpusChip></td>
      <td style={{ ...corpusCellBase, borderTop: bt }}><TierChip tier={item.tier} /></td>
      <td style={{ ...corpusCellBase, borderTop: bt, color: 'var(--fg-muted)' }}>{cShortAddr(item.contributor)}</td>
      <td className="data" style={{ ...corpusCellNum, borderTop: bt, color: 'var(--fg-muted)' }}>{item.steps}</td>
      <td className="data" style={{ ...corpusCellNum, borderTop: bt, color: hot ? 'var(--fg)' : 'var(--fg-muted)' }}>{item.age}</td>
    </tr>);
}

function Pager() {
  const btn = (label, dis) => (
    <button disabled={dis} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase', padding: '5px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-1)', background: 'transparent', color: dis ? 'var(--fg-dim)' : 'var(--fg-muted)', opacity: dis ? 0.4 : 1, cursor: dis ? 'not-allowed' : 'pointer' }}>{label}</button>);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ ...corpusDimCaps, fontSize: 10 }}>1–10 of 1,268 · newest first</span>
      <div style={{ display: 'flex', gap: 8 }}>{btn('Prev', true)}{btn('Next', false)}</div>
    </div>);
}

function CorpusIndexView() {
  return (
    <>
      {/* Page header — the SolverNets / Operators roster idiom */}
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 48, lineHeight: 1.05, color: 'var(--fg)', margin: '0 0 4px', fontWeight: 400 }}>Corpus</h1>
        <div style={{ ...corpusDimCaps, fontSize: 11, letterSpacing: '0.14em' }}>
          <span style={{ color: 'var(--gold-400)' }}>1,268 contributed task traces</span>
          <span style={{ margin: '0 8px' }}>·</span>23 contributors<span style={{ margin: '0 8px' }}>·</span>6 clusters
        </div>
      </div>

      {/* Items table */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-3)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <IndexHead />
          <tbody>
            {CORPUS_ITEMS.map((item, i) => <IndexRow key={item.cid} item={item} i={i} hot={i === 0} />)}
          </tbody>
        </table>
      </div>
      <Pager />
    </>);
}

// =====================================================================
// DETAIL VIEW — /corpus/:cid
// =====================================================================
function MetaCell({ k, v, first }) {
  return (
    <div style={{ padding: '14px 20px', borderLeft: first ? 'none' : '1px solid var(--border)', flex: '1 1 150px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ ...corpusEyebrow, fontSize: 10 }}>{k}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg)', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{v}</div>
    </div>);
}

function ToolStep({ step, i, open, onToggle }) {
  const marker = step.fail ? 'var(--wane)' : 'var(--accent)';
  return (
    <div style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
      <button onClick={onToggle} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '10px 16px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)' }}>
        <span className="data" style={{ fontSize: 10, color: 'var(--fg-dim)', width: 18, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{i + 1}</span>
        <span style={{ width: 5, height: 5, borderRadius: 999, background: marker, flexShrink: 0 }}></span>
        <span style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)', width: 46, flexShrink: 0 }}>{step.tool}</span>
        <span style={{ fontSize: 12, color: step.fail ? 'var(--wane)' : 'var(--fg)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.line}</span>
        <span aria-hidden="true" style={{ fontSize: 9, color: 'var(--fg-dim)' }}>{open ? '▴' : '▾'}</span>
      </button>
      {open &&
        <div style={{ margin: '0 16px 12px 51px', border: '1px solid var(--border)', borderRadius: 'var(--radius-2)', background: 'var(--bg-sunken)', padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.7 }}>
          <div><span style={{ color: 'var(--fg-dim)' }}>args &nbsp;&nbsp;</span><span style={{ color: 'var(--fg-muted)' }}>{step.payload.args}</span></div>
          <div><span style={{ color: 'var(--fg-dim)' }}>result </span><span style={{ color: 'var(--fg-muted)' }}>{step.payload.result}</span></div>
          <div style={{ ...corpusDimCaps, fontSize: 9, marginTop: 6 }}>scrubbed before publish — secrets and paths redacted at source</div>
        </div>}
    </div>);
}

function OutboundLink({ label, value, href }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>
      <span style={{ ...corpusEyebrow, fontSize: 10, width: 130, flexShrink: 0 }}>{label}</span>
      <a href={href || '#'} style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value} →</a>
    </div>);
}

function CorpusDetailView() {
  const [openStep, setOpenStep] = useTabState(2);
  const d = CORPUS_DETAIL;
  return (
    <>
      {/* Back + breadcrumb */}
      <a href="#" style={{ ...corpusDimCaps, fontSize: 10, textDecoration: 'none', color: 'var(--fg-dim)' }}>← Corpus</a>

      {/* Header — summary is the headline; tier is the surface's single gold-adjacent emphasis */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
          <TierChip tier={d.tier} />
          <span style={{ ...corpusDimCaps, fontSize: 10 }}>{d.createdAt}</span>
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 40, fontStyle: 'italic', lineHeight: 1.08, color: 'var(--fg)', margin: '0 0 10px', fontWeight: 400 }}>{d.summary}</h1>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>{cShortCid(d.cid, 14, 8)}</div>
      </div>

      {/* Meta row — the KpiRow idiom */}
      <div style={{ display: 'flex', flexWrap: 'wrap', border: '1px solid var(--border)', borderRadius: 'var(--radius-3)', background: 'var(--bg-elevated)', overflow: 'hidden' }}>
        <MetaCell first k="Cluster" v={d.cluster} />
        <MetaCell k="Harness" v={d.harness} />
        <MetaCell k="Model" v={d.model} />
        <MetaCell k="Contributor" v={<a href="#" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{cShortAddr(d.contributor)}</a>} />
        <MetaCell k="Provenance" v="contributed" />
        <MetaCell k="Scrub" v={d.scrub} />
      </div>

      {/* Tags */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {d.tags.map((t) => <CorpusChip key={t}>{t}</CorpusChip>)}
      </div>

      {/* Tool steps */}
      <CorpusCardShell title={`Tool sequence · ${d.toolSteps.length} steps`}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-3)', overflow: 'hidden', background: 'var(--bg-elevated)' }}>
          {d.toolSteps.map((s, i) =>
            <ToolStep key={i} step={s} i={i} open={openStep === i} onToggle={() => setOpenStep(openStep === i ? -1 : i)} />)}
        </div>
        <div style={{ ...corpusDimCaps, fontSize: 10, marginTop: 12, textTransform: 'none', letterSpacing: '0.02em' }}>
          Summarised sequence — full scrubbed payloads live in the envelope content below.
        </div>
      </CorpusCardShell>

      {/* Provenance — outbound links */}
      <CorpusCardShell title="Provenance">
        <div style={{ marginTop: -10 }}>
          <OutboundLink label="IPFS content" value={cShortCid(d.cid, 14, 8)} />
          <OutboundLink label="On-chain anchor" value={`${d.anchorTx.slice(0, 10)}… · basescan`} />
        </div>
        <div style={{ ...corpusDimCaps, fontSize: 10, marginTop: 12, textTransform: 'none', letterSpacing: '0.02em' }}>
          Both links leave the explorer. The anchor is the ERC-8004 registration on Base Sepolia; the content ref resolves the envelope itself.
        </div>
      </CorpusCardShell>
    </>);
}

// =====================================================================
// EMPTY + NOT-FOUND
// =====================================================================
function CorpusEmptyView() {
  return (
    <>
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 48, lineHeight: 1.05, color: 'var(--fg)', margin: '0 0 4px', fontWeight: 400 }}>Corpus</h1>
        <div style={{ ...corpusDimCaps, fontSize: 11, letterSpacing: '0.14em' }}>0 contributed task traces</div>
      </div>
      <div style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius-3)', padding: '48px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--fg)' }}>No contributions yet — the corpus grows as operators publish task traces.</div>
      </div>
    </>);
}

function CorpusNotFoundView() {
  return (
    <>
      <a href="#" style={{ ...corpusDimCaps, fontSize: 10, textDecoration: 'none', color: 'var(--fg-dim)' }}>← Corpus</a>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--wane)', border: '1px solid var(--wane)', borderRadius: 'var(--radius-2)', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <span>No corpus item at this CID. It may not be indexed yet, or the link is wrong.</span>
        <a href="#" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--wane)', border: '1px solid currentColor', borderRadius: 'var(--radius-1)', padding: '4px 10px', textDecoration: 'none' }}>Back to Corpus</a>
      </div>
    </>);
}

// ---- mount ----
ReactDOM.createRoot(document.getElementById('view-index')).render(<CorpusShell active="Corpus"><CorpusIndexView /></CorpusShell>);
ReactDOM.createRoot(document.getElementById('view-detail')).render(<CorpusShell active="Corpus"><CorpusDetailView /></CorpusShell>);
ReactDOM.createRoot(document.getElementById('view-empty')).render(<CorpusShell active="Corpus"><CorpusEmptyView /></CorpusShell>);
ReactDOM.createRoot(document.getElementById('view-notfound')).render(<CorpusShell active="Corpus"><CorpusNotFoundView /></CorpusShell>);
