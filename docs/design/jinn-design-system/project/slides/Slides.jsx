// Slide components — Jinn technical-talk template

const Slide = ({ label, children, style }) => (
  <section data-screen-label={label} style={{
    width: 1920, height: 1080, background: 'var(--blue-900)', color: 'var(--blue-50)',
    padding: '96px 128px', position: 'relative', boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', overflow: 'hidden', ...style,
  }}>
    <SlideChrome label={label} />
    {children}
  </section>
);

const SlideChrome = ({ label }) => (
  <>
    <div style={{ position: 'absolute', top: 48, left: 128, right: 128, display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--fg-muted)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <img src="../assets/logo-sigil.svg" style={{ width: 20, height: 20, filter: 'brightness(0) invert(1) opacity(0.9)' }} alt=""/>
        <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 22, color: 'var(--blue-50)' }}>jinn</span>
      </div>
      <span className="label" style={{ fontSize: 12, letterSpacing: '0.2em' }}>{label}</span>
    </div>
    <div style={{ position: 'absolute', bottom: 48, left: 128, right: 128, borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
      <span>jinn &middot; decentralised training</span>
      <span>&mdash; a co-created brand</span>
    </div>
  </>
);

const TitleSlide = () => (
  <Slide label="01 · TITLE">
    <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 1500 }}>
      <span className="label" style={{ fontSize: 14, letterSpacing: '0.3em' }}>A technical talk</span>
      <h1 style={{ margin: 0, fontSize: 220, lineHeight: 0.92, letterSpacing: '-0.03em', whiteSpace: 'nowrap' }}>
        Summoning
      </h1>
      <h1 style={{ margin: 0, fontSize: 220, lineHeight: 0.92, letterSpacing: '-0.03em', fontStyle: 'italic', color: 'var(--gold-400)' }}>
        outcomes.
      </h1>
      <div className="wish" style={{ fontSize: 32, maxWidth: '32ch', color: 'var(--fg-muted)', marginTop: 12 }}>
        A decentralised network for training agentic fulfilment.
      </div>
    </div>
  </Slide>
);

const SectionSlide = () => (
  <Slide label="02 · SECTION" style={{ background: 'var(--blue-950)' }}>
    <div style={{ margin: 'auto', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 40 }}>
      <img src="../assets/mark-smoke.svg" style={{ width: 180, height: 180, filter: 'brightness(0) invert(0.82) sepia(1) saturate(2.5) hue-rotate(5deg)' }} alt="" />
      <span className="label" style={{ fontSize: 14, letterSpacing: '0.4em', color: 'var(--gold-400)' }}>Part one</span>
      <h1 style={{ margin: 0, fontSize: 140, lineHeight: 1, fontStyle: 'italic' }}>The wish.</h1>
    </div>
  </Slide>
);

const ContentSlide = () => (
  <Slide label="03 · CONTENT">
    <div style={{ marginTop: 120 }}>
      <span className="label" style={{ fontSize: 14, letterSpacing: '0.3em' }}>How a wish enters the ether</span>
      <h2 style={{ margin: '24px 0 64px', fontSize: 88, lineHeight: 1.05, maxWidth: '18ch' }}>
        Four steps. No orchestrator. No server.
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 40, marginTop: 20 }}>
        {[
          { n: '01', t: 'Summon', d: 'A binder posts a wish with a bond.' },
          { n: '02', t: 'Bind', d: 'Seers are elected. Vessels volunteer.' },
          { n: '03', t: 'Smoke', d: 'Training runs across vessels. Gradients return.' },
          { n: '04', t: 'Vow', d: 'Seers agree. The outcome is bound on-chain.' },
        ].map(s => (
          <div key={s.n} style={{ borderTop: '1px solid var(--gold-500)', paddingTop: 20 }}>
            <div className="data" style={{ fontSize: 14, color: 'var(--gold-400)', letterSpacing: '0.2em', marginBottom: 18 }}>{s.n}</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 48, lineHeight: 1, marginBottom: 16 }}>{s.t}</div>
            <div style={{ fontSize: 20, color: 'var(--fg-muted)', lineHeight: 1.5, letterSpacing: '-0.01em' }}>{s.d}</div>
          </div>
        ))}
      </div>
    </div>
  </Slide>
);

const QuoteSlide = () => (
  <Slide label="04 · QUOTE" style={{ background: 'var(--blue-950)' }}>
    <div style={{ margin: 'auto 0', maxWidth: '24ch' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 144, lineHeight: 1.05, letterSpacing: '-0.01em' }}>
        "A wish without<br/>a vessel is only<br/><span style={{ color: 'var(--gold-400)' }}>weather.</span>"
      </div>
      <div style={{ marginTop: 48, display: 'flex', alignItems: 'center', gap: 20, color: 'var(--fg-muted)' }}>
        <div style={{ width: 48, borderTop: '1px solid var(--fg-muted)' }}/>
        <span className="label" style={{ fontSize: 16, letterSpacing: '0.3em' }}>a node operator, epoch 14,820</span>
      </div>
    </div>
  </Slide>
);

const DataSlide = () => (
  <Slide label="05 · DATA">
    <div style={{ marginTop: 120 }}>
      <span className="label" style={{ fontSize: 14, letterSpacing: '0.3em' }}>The ether — last 30 days</span>
      <h2 style={{ margin: '24px 0 64px', fontSize: 88, lineHeight: 1.05 }}>The network, in numbers.</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, border: '1px solid var(--border)' }}>
        {[
          { l: 'Wishes summoned', v: '18,412', d: '+2,104 vs prior' },
          { l: 'Vessels online', v: '12,408', d: '+184 vs prior' },
          { l: 'JN bonded', v: '2.4M', d: '+4.2% vs prior' },
          { l: 'Failed wishes', v: '0.7%', d: '−0.2pp vs prior' },
        ].map((k, i) => (
          <div key={k.l} style={{ padding: '40px 36px', borderRight: i < 3 ? '1px solid var(--border)' : 0 }}>
            <div className="label" style={{ fontSize: 13, marginBottom: 28 }}>{k.l}</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 96, lineHeight: 1 }} className="data">{k.v}</div>
            <div style={{ marginTop: 20, fontSize: 16, color: 'var(--vow-green)', fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>{k.d}</div>
          </div>
        ))}
      </div>
    </div>
  </Slide>
);

const ClosingSlide = () => (
  <Slide label="06 · CLOSE">
    <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 40 }}>
      <img src="../assets/mark-binding.svg" style={{ width: 120, height: 120, filter: 'brightness(0) invert(1) opacity(0.9)' }} alt="" />
      <h1 style={{ margin: 0, fontSize: 140, lineHeight: 1, fontStyle: 'italic' }}>
        Bind a vessel.
      </h1>
      <div style={{ fontSize: 28, color: 'var(--fg-muted)', maxWidth: '28ch' }}>
        Run the harness. Read the README. Fork the brand — we mean it.
      </div>
      <div style={{ marginTop: 48, display: 'flex', gap: 40, alignItems: 'baseline' }}>
        <span className="label" style={{ fontSize: 14, letterSpacing: '0.3em' }}>jinn.network/harness</span>
        <span style={{ color: 'var(--border)' }}>·</span>
        <span className="label" style={{ fontSize: 14, letterSpacing: '0.3em', color: 'var(--gold-400)' }}>@jinn</span>
      </div>
    </div>
  </Slide>
);

Object.assign(window, { Slide, TitleSlide, SectionSlide, ContentSlide, QuoteSlide, DataSlide, ClosingSlide });
