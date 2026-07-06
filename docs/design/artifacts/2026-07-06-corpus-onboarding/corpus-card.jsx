/* corpus-card.jsx — 1407 · the "Corpus" card on the Network view
   (rename + restructure of the shipped "Distribution signal" card). */

// ---- Activity strip above the card (Network view context) ----
function NetActivityCell({ k, v, sub, first, serif = true }) {
  return (
    <div style={{ padding: first ? '0 24px 0 0' : '0 24px', borderLeft: first ? 'none' : '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ ...corpusEyebrow }}>{k}</div>
      <div style={{ fontFamily: serif ? 'var(--font-display)' : 'var(--font-mono)', fontSize: serif ? 40 : 26, lineHeight: 1, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{v}</div>
      {sub && <div style={{ ...corpusDimCaps, fontSize: 11 }}>{sub}</div>}
    </div>);
}
function NetActivityStrip() {
  return (
    <CorpusCardShell title="Activity">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <NetActivityCell first k="Active operators" v="23" />
        <NetActivityCell k="SolverNets running" v="7" sub="launched · accepting tasks" />
        <NetActivityCell k="Last settlement" v="43,611,254" sub="block" serif={false} />
      </div>
    </CorpusCardShell>);
}

// ---- Corpus card ----
function ClusterRow({ c, i }) {
  const bt = i === 0 ? 'none' : '1px solid var(--border)';
  return (
    <tr style={{ background: 'var(--bg-elevated)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-sunken)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}>
      <td style={{ ...corpusCellBase, borderTop: bt }}>
        <a href="#" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{c.name}</a>
      </td>
      <td className="data" style={{ ...corpusCellNum, borderTop: bt }}>{cInt(c.value)}</td>
      <td className="data" style={{ ...corpusCellNum, borderTop: bt, color: 'var(--fg-muted)' }}>{cInt(c.contrib)}</td>
      <td style={{ ...corpusCellBase, borderTop: bt, paddingLeft: 24 }}>
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>{c.tags.map((t) => <CorpusChip key={t}>{t}</CorpusChip>)}</span>
      </td>
    </tr>);
}

function CorpusCard() {
  const { rows, sum } = corpusTotals(false);
  const clusterCount = rows.length;
  const LOW = 2;
  const mainRows = rows.filter((r) => r.value > LOW);
  const tailRows = rows.filter((r) => r.value <= LOW);

  return (
    <CorpusCardShell title="Corpus">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Plain-language summary — the card's one job */}
        <div style={{ maxWidth: '62ch' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, lineHeight: 1.6, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
            <span className="data" style={{ color: 'var(--gold-400)', fontVariantNumeric: 'tabular-nums' }}>{cInt(sum)}</span> task traces contributed by <span className="data">{cInt(CORPUS_DISTINCT_CONTRIB)}</span> operators, in <span className="data">{clusterCount}</span> clusters.
          </div>
        </div>

        {/* Where contributions concentrate */}
        <CorpusHBars title="Where contributions concentrate" rows={rows.slice(0, 5)} sum={sum} />

        {/* Cluster breakdown — kept from the shipped card */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-3)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-strong)' }}>
                {[['Cluster', {}], ['Envelopes', { n: 1 }], ['Contributors', { n: 1 }], ['Top tags', { pl: 24 }]].map(([label, o]) =>
                  <th key={label} style={{ padding: '10px 16px', textAlign: o.n ? 'right' : 'left', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)', fontWeight: 500, whiteSpace: 'nowrap', paddingLeft: o.pl }}>{label}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {mainRows.map((c, i) => <ClusterRow key={c.name} c={c} i={i} />)}
              {tailRows.length > 0 && <>
                <tr><td colSpan={4} style={{ padding: '8px 16px 6px', background: 'var(--bg-sunken)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)', fontWeight: 500 }}>Low-volume</td></tr>
                {tailRows.map((c) => <ClusterRow key={c.name} c={c} i={1} />)}
              </>}
            </tbody>
          </table>
        </div>

        {/* Entry point into the tab */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <a href="#" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>Browse the corpus →</a>
          <span style={{ ...corpusDimCaps, fontSize: 10, textTransform: 'none', letterSpacing: '0.02em' }}>every trace: summary · tool steps · IPFS ref · on-chain anchor</span>
        </div>
      </div>
    </CorpusCardShell>);
}

// ---- Empty state ----
function CorpusCardEmpty() {
  return (
    <CorpusCardShell title="Corpus">
      <div style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius-3)', padding: '44px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--fg)' }}>No contributions yet — the corpus grows as operators publish task traces.</div>
      </div>
    </CorpusCardShell>);
}

// ---- mounts ----
ReactDOM.createRoot(document.getElementById('card-network')).render(
  <CorpusShell active="Network">
    <NetActivityStrip />
    <CorpusCard />
  </CorpusShell>);

ReactDOM.createRoot(document.getElementById('card-empty')).render(
  <div style={{ background: 'var(--bg)', padding: '28px' }}><CorpusCardEmpty /></div>);
