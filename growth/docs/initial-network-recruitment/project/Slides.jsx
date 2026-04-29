// Jinn — Initial Network Recruitment deck
// Action-title style; visual-first (speaker script carries narrative)
// 1920x1080

const TYPE_SCALE = {
  display: 168,   // hero title
  displaySm: 128,
  title: 88,      // slide titles
  titleSm: 72,
  subtitle: 44,
  lede: 40,
  body: 34,
  bodySm: 28,
  small: 24,
  label: 20,      // ALL CAPS labels (tracked)
  number: 220,    // big stat
};

const SPACING = {
  paddingTop: 120,
  paddingBottom: 100,
  paddingX: 128,
  titleGap: 56,
  itemGap: 32,
  sectionGap: 72,
};

/* ---------- Slide shell ---------- */
const Slide = ({ label, children, style, chrome = true, index, total }) => (
  <section data-screen-label={label} style={{
    width: 1920, height: 1080, background: 'var(--blue-900)', color: 'var(--blue-50)',
    padding: `110px ${SPACING.paddingX}px 170px`,
    position: 'relative', boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    fontFamily: 'var(--font-mono)',
    ...style,
  }}>
    {chrome && <SlideChrome label={label} index={index} total={total} />}
    {children}
  </section>
);

const SlideChrome = ({ label, index, total }) => (
  <>
    <div style={{
      position: 'absolute', top: 56, left: SPACING.paddingX, right: SPACING.paddingX,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      color: 'var(--fg-muted)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <img src="assets/logo-sigil.svg" style={{ width: 22, height: 22, filter: 'brightness(0) invert(1) opacity(0.92)' }} alt=""/>
        <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 26, color: 'var(--blue-50)', lineHeight: 1 }}>jinn</span>
      </div>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: TYPE_SCALE.label - 4,
        letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--fg-dim)',
      }}>{label}</span>
    </div>
    <div style={{
      position: 'absolute', bottom: 56, left: SPACING.paddingX, right: SPACING.paddingX,
      borderTop: '1px solid var(--border)', paddingTop: 18,
      display: 'flex', justifyContent: 'space-between',
      fontSize: 14, color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)',
      letterSpacing: '0.18em', textTransform: 'uppercase', pointerEvents: 'none',
    }}>
      <span>Jinn &middot; April 2026</span>
      <span>{typeof index === 'number' ? `${String(index + 1).padStart(2,'0')} / ${String(total).padStart(2,'0')}` : ''}</span>
    </div>
  </>
);

/* ---------- Primitives ---------- */
const Eyebrow = ({ children, color = 'var(--gold-400)', style }) => (
  <span style={{
    fontFamily: 'var(--font-mono)', fontSize: TYPE_SCALE.label,
    letterSpacing: '0.3em', textTransform: 'uppercase', color, ...style,
  }}>{children}</span>
);

const Title = ({ children, italic = false, style }) => (
  <h2 style={{
    margin: 0, fontFamily: 'var(--font-display)',
    fontSize: TYPE_SCALE.title, lineHeight: 1.02,
    letterSpacing: '-0.015em', fontStyle: italic ? 'italic' : 'normal',
    color: 'var(--blue-50)', textWrap: 'balance',
    ...style,
  }}>{children}</h2>
);

const Body = ({ children, style }) => (
  <p style={{
    margin: 0, fontFamily: 'var(--font-mono)',
    fontSize: TYPE_SCALE.body, lineHeight: 1.45,
    letterSpacing: '-0.01em', color: 'var(--fg)',
    ...style,
  }}>{children}</p>
);

const Rule = ({ color = 'var(--border)', style }) => (
  <div style={{ borderTop: `1px solid ${color}`, ...style }} />
);

/* ================================================================
   01 — Title
   ================================================================ */
const S01_Title = ({ index, total }) => (
  <Slide label="01 Title" index={index} total={total} chrome={false} style={{ background: 'var(--blue-950)' }}>
    {/* Minimal chrome only — wordmark top left, meta bottom */}
    <div style={{
      position: 'absolute', top: 56, left: SPACING.paddingX, right: SPACING.paddingX,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <img src="assets/logo-sigil.svg" style={{ width: 28, height: 28, filter: 'brightness(0) invert(1)' }} alt=""/>
        <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 34, color: 'var(--blue-50)', lineHeight: 1 }}>jinn</span>
      </div>
      <span style={{ fontSize: 18, letterSpacing: '0.3em', textTransform: 'uppercase', color: 'var(--fg-dim)' }}>
        April 2026
      </span>
    </div>

    <div className="texture-grid" style={{
      position: 'absolute', inset: 0, opacity: 0.5, pointerEvents: 'none',
    }} />

    <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 48, position: 'relative' }}>
      <Eyebrow>Jinn</Eyebrow>
      <h1 style={{
        margin: 0, fontFamily: 'var(--font-display)',
        fontSize: 220, lineHeight: 0.95,
        letterSpacing: '-0.03em', maxWidth: '14ch', textWrap: 'balance',
      }}>
        Summoning<br/>
        <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>outcomes.</span>
      </h1>
      <div style={{ marginTop: 56, display: 'flex', alignItems: 'baseline', gap: 32, color: 'var(--fg-muted)' }}>
        <span style={{ fontSize: TYPE_SCALE.bodySm, letterSpacing: '-0.01em' }}>
          Oak &amp; Ritsu &middot; jinn.network
        </span>
      </div>
    </div>

    <div style={{
      position: 'absolute', bottom: 56, left: SPACING.paddingX, right: SPACING.paddingX,
      borderTop: '1px solid var(--border)', paddingTop: 18,
      display: 'flex', justifyContent: 'space-between',
      fontSize: 16, color: 'var(--fg-dim)', letterSpacing: '0.14em', textTransform: 'uppercase',
    }}>
      <span>A decentralised network for training agentic fulfilment of outcomes.</span>
      <span>01 / {String(total).padStart(2,'0')}</span>
    </div>
  </Slide>
);

/* ================================================================
   02 — Why now (market timing)
   ================================================================ */
const S02_WhyNow = ({ index, total }) => (
  <Slide label="02 Why now" index={index} total={total}>
    <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: SPACING.titleGap, flex: 1 }}>
      <Eyebrow>Why now &middot; Q1 2026</Eyebrow>
      <Title style={{ maxWidth: '22ch' }}>
        Agentic work is now the dominant mode of AI consumption.
      </Title>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        border: '1px solid var(--border)', marginTop: 24,
      }}>
        {[
          { v: '$2B',   l: 'Cursor ARR',        d: 'Doubled in 3 months. $50B valuation.' },
          { v: '$2.5B', l: 'Claude Code ARR',   d: 'Agent-native coding.' },
          { v: '80%',   l: 'Anthropic via API', d: 'Agents consume the tokens, not humans.' },
          { v: '73%',   l: 'Engineers daily',   d: 'Up from 41% a year ago.' },
        ].map((k, i) => (
          <div key={k.l} style={{
            padding: '44px 36px 40px',
            borderRight: i < 3 ? '1px solid var(--border)' : 0,
          }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 128, lineHeight: 1,
              letterSpacing: '-0.02em', color: 'var(--gold-400)',
            }} className="data">{k.v}</div>
            <div style={{
              marginTop: 28, fontFamily: 'var(--font-mono)',
              fontSize: TYPE_SCALE.label, letterSpacing: '0.18em',
              textTransform: 'uppercase', color: 'var(--fg)',
            }}>{k.l}</div>
            <div style={{
              marginTop: 14, fontFamily: 'var(--font-mono)',
              fontSize: TYPE_SCALE.small, lineHeight: 1.35,
              color: 'var(--fg-muted)', letterSpacing: '-0.01em',
            }}>{k.d}</div>
          </div>
        ))}
      </div>
    </div>
  </Slide>
);

/* ================================================================
   03 — Why decentralised
   ================================================================ */
const S03_WhyDecentralised = ({ index, total }) => (
  <Slide label="03 Why decentralised" index={index} total={total} style={{ background: 'var(--blue-950)' }}>
    <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 48 }}>
      <Eyebrow>Why not just build a startup</Eyebrow>
      <Title style={{ fontSize: 72, lineHeight: 1.12, maxWidth: '26ch' }}>
        Three reasons to do this as a protocol. <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>Any one is enough.</span>
      </Title>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
        border: '1px solid var(--border)', marginTop: 8,
      }}>
        {[
          {
            n: '01',
            t: 'Economic',
            lede: 'We can\u2019t out-build the labs \u2014 and we don\u2019t need to.',
            body: 'A thin protocol under the agentic market captures value across the whole space at low rates. A fractional take on verified outcomes at Cursor-adjacent volumes, at a fraction of the headcount.',
          },
          {
            n: '02',
            t: 'Impact',
            lede: 'Which agents get paid for doing things in the world is the rails, not a feature.',
            body: 'There is arguably no bigger piece of infrastructure to work on right now. If that\u2019s true, making it credibly ownable by its operators is worth the extra engineering cost.',
          },
          {
            n: '03',
            t: 'Ethos',
            lede: 'The centralising force in AI is already severe. Don\u2019t add fulfilment to the pile.',
            body: 'Three labs, a handful of clouds, agents as the direct consumer of tokens. A network whose trust assumptions don\u2019t reduce to a single safe is a counterweight worth building.',
          },
        ].map((c, i) => (
          <div key={c.n} style={{
            padding: '36px 32px 40px',
            borderRight: i < 2 ? '1px solid var(--border)' : 0,
            display: 'flex', flexDirection: 'column', gap: 20,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 18,
                letterSpacing: '0.28em', color: 'var(--gold-400)',
              }} className="data">{c.n}</div>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: TYPE_SCALE.label,
                letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--fg-muted)',
              }}>{c.t}</div>
            </div>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 30, lineHeight: 1.22,
              letterSpacing: '-0.01em',
            }}>
              {c.lede}
            </div>
            <Body style={{ color: 'var(--fg-muted)', fontSize: 24, lineHeight: 1.5 }}>
              {c.body}
            </Body>
          </div>
        ))}
      </div>
    </div>
  </Slide>
);

/* ================================================================
   04 — Output vs outcome (the frame)
   ================================================================ */
const S03_OutputVsOutcome = ({ index, total }) => (
  <Slide label="04 The frame" index={index} total={total}>
    <div style={{ marginTop: 40, flex: 1, display: 'flex', flexDirection: 'column', gap: SPACING.titleGap }}>
      <Eyebrow>The frame</Eyebrow>
      <Title style={{ maxWidth: '26ch' }}>
        Benchmarks score outputs.<br/>
        <span style={{ color: 'var(--gold-400)', fontStyle: 'italic' }}>The world pays for outcomes.</span>
      </Title>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
        border: '1px solid var(--border)', marginTop: 32,
      }}>
        <div style={{ padding: '44px 44px 48px', borderRight: '1px solid var(--border)' }}>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 28 }}>
            Output
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 44, lineHeight: 1.2, letterSpacing: '-0.01em', marginBottom: 44 }}>
            Did A&rsquo;s answer look better than B&rsquo;s?
          </div>
          <Body style={{ color: 'var(--fg-muted)', fontSize: TYPE_SCALE.bodySm, lineHeight: 1.5 }}>
            Peer-ranked. Voted on. Plausible. Works for benchmarks where there is no ground truth.
          </Body>
        </div>
        <div style={{ padding: '44px 44px 48px', background: 'var(--blue-800)' }}>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--gold-400)', marginBottom: 28 }}>
            Outcome
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 44, lineHeight: 1.2, letterSpacing: '-0.01em', marginBottom: 44 }}>
            Did the thing the agent was asked to cause <span style={{ fontStyle: 'italic' }}>actually happen?</span>
          </div>
          <Body style={{ fontSize: TYPE_SCALE.bodySm, lineHeight: 1.5 }}>
            Resolved against on-chain state, oracle prices, realised APY, transaction inclusion. Verifiable.
          </Body>
        </div>
      </div>
    </div>
  </Slide>
);

/* ================================================================
   04 — Centralisation critique
   ================================================================ */
const S04_Centralisation = ({ index, total }) => (
  <Slide label="05 Centralisation" index={index} total={total} style={{ background: 'var(--blue-950)' }}>
    <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 96, maxWidth: 1600 }}>
      <Eyebrow>The last fortnight</Eyebrow>
      <Title style={{ fontSize: 64, lineHeight: 1.15, maxWidth: '26ch' }}>
        Output-scoring&rsquo;s centralisation problem is live.
      </Title>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48, marginTop: 0 }}>
        <div style={{ borderTop: '1px solid var(--gold-500)', paddingTop: 20 }}>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--gold-400)', marginBottom: 16 }}>
            Covalent
          </div>
          <Body style={{ fontSize: 36, lineHeight: 1.3 }}>
            Exits Bittensor. One party in the middle, gone.
          </Body>
        </div>
        <div style={{ borderTop: '1px solid var(--gold-500)', paddingTop: 20 }}>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--gold-400)', marginBottom: 16 }}>
            Jacob Steeves multisig
          </div>
          <Body style={{ fontSize: 36, lineHeight: 1.3 }}>
            The row put the single-safe problem on the front page.
          </Body>
        </div>
      </div>

      <div style={{ marginTop: 12, fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 32, color: 'var(--fg-muted)', maxWidth: '60ch', lineHeight: 1.3, textWrap: 'balance' }}>
        There is a real opening for a protocol whose trust assumptions don&rsquo;t reduce to a single safe.
      </div>
    </div>
  </Slide>
);

/* ================================================================
   05 — Thesis
   ================================================================ */
const S05_Thesis = ({ index, total }) => (
  <Slide label="06 Thesis" index={index} total={total}>
    <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 48 }}>
      <Eyebrow>The thesis</Eyebrow>
      <h2 style={{
        margin: 0, fontFamily: 'var(--font-display)',
        fontSize: 156, lineHeight: 0.98, letterSpacing: '-0.022em',
        maxWidth: '14ch', textWrap: 'balance',
      }}>
        Jinn scores <span style={{ color: 'var(--gold-400)', fontStyle: 'italic' }}>outcomes</span>,<br/>
        not outputs.
      </h2>
      <div style={{ fontSize: TYPE_SCALE.lede, lineHeight: 1.4, color: 'var(--fg-muted)', maxWidth: '42ch', letterSpacing: '-0.01em', marginTop: 24 }}>
        A protocol for producing verified solutions to outcomes &mdash; where &ldquo;verified&rdquo; means evidence, independently checked, not votes on whether an answer looked right.
      </div>
    </div>
  </Slide>
);

/* ================================================================
   06 — The loop
   ================================================================ */
const S06_Loop = ({ index, total }) => (
  <Slide label="07 The loop" index={index} total={total}>
    <div style={{ marginTop: 40, flex: 1, display: 'flex', flexDirection: 'column', gap: SPACING.titleGap }}>
      <Eyebrow>How it works</Eyebrow>
      <Title style={{ maxWidth: '22ch' }}>
        One loop. Four roles. <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>One structural rule.</span>
      </Title>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 32,
      }}>
        {[
          { n: '01', t: 'Creators', d: 'Post outcomes. Fund their realisation.' },
          { n: '02', t: 'Solvers',  d: 'Produce a plan, run it, supply the evidence.' },
          { n: '03', t: 'Evaluators', d: 'Check the evidence. Independently of the solver.' },
          { n: '04', t: 'Knowledge',  d: 'Verified (solution, outcome) pairs accumulate.' },
        ].map((s, i) => (
          <div key={s.n} style={{
            borderTop: '1px solid var(--gold-500)',
            borderRight: i < 3 ? '1px solid var(--border)' : 0,
            padding: '28px 36px 12px 28px',
          }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 18,
              letterSpacing: '0.28em', color: 'var(--gold-400)', marginBottom: 24,
            }} className="data">{s.n}</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 72, lineHeight: 1, marginBottom: 22, letterSpacing: '-0.015em' }}>
              {s.t}
            </div>
            <Body style={{ color: 'var(--fg-muted)', fontSize: TYPE_SCALE.bodySm, lineHeight: 1.4 }}>
              {s.d}
            </Body>
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 16, padding: '20px 28px',
        border: '1px solid var(--gold-500)', borderLeft: '4px solid var(--gold-500)',
        display: 'flex', alignItems: 'center', gap: 24,
      }}>
        <span style={{ fontSize: 18, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--gold-400)', whiteSpace: 'nowrap' }}>The rule</span>
        <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 30, lineHeight: 1.2, letterSpacing: '-0.01em' }}>
          Evaluator &ne; solver. Structural trust, not a game-theoretic bond.
        </span>
      </div>
    </div>
  </Slide>
);

/* ================================================================
   07 — Services
   ================================================================ */
const S07_Services = ({ index, total }) => (
  <Slide label="08 Services" index={index} total={total}>
    <div style={{ marginTop: 40, flex: 1, display: 'flex', flexDirection: 'column', gap: 48 }}>
      <Eyebrow>Protocol vs. service</Eyebrow>
      <Title style={{ maxWidth: '26ch' }}>
        Jinn is the protocol. Services are the verticals.
      </Title>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 48, marginTop: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <Body style={{ fontSize: TYPE_SCALE.lede, lineHeight: 1.35, color: 'var(--fg)', maxWidth: '30ch' }}>
            A service = one contract + one activity checker, specialised to a domain.
          </Body>
          <Body style={{ color: 'var(--fg-muted)', maxWidth: '36ch' }}>
            Do not collapse the protocol into any single service.
            The protocol&rsquo;s job is to make solutions trustworthy &mdash; execution sits downstream and can vary by service.
          </Body>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ border: '1px solid var(--gold-500)', padding: '28px 32px', background: 'var(--blue-800)' }}>
            <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--gold-400)', marginBottom: 16 }}>
              First service &middot; shipped
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 68, lineHeight: 1, marginBottom: 16 }}>
              PIS
            </div>
            <Body style={{ color: 'var(--fg)', fontSize: TYPE_SCALE.bodySm, lineHeight: 1.4 }}>
              Prediction Intelligence Service. First outcome: APY of a specific lending pool over a specific window. Resolved on-chain.
            </Body>
          </div>
          <div style={{ border: '1px dashed var(--border-strong)', padding: '24px 32px' }}>
            <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 12 }}>
              Candidate next
            </div>
            <Body style={{ fontSize: TYPE_SCALE.bodySm }}>
              Hyperliquid-style financial-outcomes service.
            </Body>
          </div>
        </div>
      </div>
    </div>
  </Slide>
);

/* ================================================================
   08 — On-chain architecture
   ================================================================ */
const S08_Architecture = ({ index, total }) => (
  <Slide label="09 Architecture" index={index} total={total}>
    <div style={{ marginTop: 40, flex: 1, display: 'flex', flexDirection: 'column', gap: SPACING.titleGap }}>
      <Eyebrow>On-chain surface</Eyebrow>
      <Title style={{ maxWidth: '22ch' }}>
        The on-chain surface is intentionally thin.
      </Title>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 64, marginTop: 24, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 220, lineHeight: 0.92, letterSpacing: '-0.03em', color: 'var(--gold-400)' }} className="data">
              ~230
            </div>
            <div style={{ marginTop: 8, fontSize: TYPE_SCALE.label, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
              Lines of bespoke Solidity
            </div>
          </div>
          <Body style={{ color: 'var(--fg-muted)', fontSize: TYPE_SCALE.bodySm, maxWidth: '28ch' }}>
            Across four contracts. The rest is OpenZeppelin and OLAS.
          </Body>
        </div>

        <div style={{ border: '1px solid var(--border)' }}>
          {[
            { k: 'JINN',              v: 'ERC-20 + Permit + Votes. 1B cap / 10y, then 2%/yr perpetual. Canonical on Ethereum mainnet.' },
            { k: 'JinnDistributor',   v: 'claim(serviceId) on Base. Reads OLAS staking rewards, mints at 3:1 operator:DAO.' },
            { k: 'JinnGovernor + Timelock', v: 'OZ Governor on mainnet. 2d delay / 14d vote / 4% quorum / 2d timelock = 18d window.' },
            { k: 'Cross-chain admin', v: 'Mainnet governance, Base distributor. Bridge TBD (Hyperlane / LayerZero / CCIP).' },
          ].map((row, i, arr) => (
            <div key={row.k} style={{
              display: 'grid', gridTemplateColumns: '280px 1fr',
              padding: '20px 28px',
              borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 0,
              alignItems: 'baseline', gap: 24,
            }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontWeight: 600,
                fontSize: TYPE_SCALE.small, letterSpacing: '0.06em',
                textTransform: 'uppercase', color: 'var(--gold-400)',
              }}>{row.k}</div>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 22,
                lineHeight: 1.4, color: 'var(--fg)', letterSpacing: '-0.01em',
              }}>{row.v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  </Slide>
);

/* ================================================================
   09 — Fair launch
   ================================================================ */
const S09_FairLaunch = ({ index, total }) => (
  <Slide label="10 Fair launch" index={index} total={total} style={{ background: 'var(--blue-950)' }}>
    <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 48 }}>
      <Eyebrow>Legitimacy by construction</Eyebrow>
      <h2 style={{
        margin: 0, fontFamily: 'var(--font-display)',
        fontSize: 76, lineHeight: 1.12, letterSpacing: '-0.02em',
        maxWidth: '26ch', textWrap: 'balance',
      }}>
        Every JINN is minted by <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>measurable operator work.</span>
      </h2>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0,
        border: '1px solid var(--border)', marginTop: 16,
      }}>
        {[
          'No team keys',
          'No pre-mine',
          'No allocation',
          'No VC round',
        ].map((k, i) => (
          <div key={k} style={{
            padding: '36px 28px',
            borderRight: i < 3 ? '1px solid var(--border)' : 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              fontFamily: 'var(--font-display)', fontSize: 56,
              letterSpacing: '-0.015em', color: 'var(--blue-50)',
            }}>{k}</span>
          </div>
        ))}
      </div>

      <Body style={{ maxWidth: '48ch', color: 'var(--fg-muted)', fontSize: TYPE_SCALE.bodySm, lineHeight: 1.5 }}>
        Co-founders have the same access to the token as the next ten operators, who have the same access as the next thousand. No early-insider multiplier, no discount, no vesting cliff.
      </Body>
    </div>
  </Slide>
);

Object.assign(window, {
  TYPE_SCALE, SPACING, Slide, SlideChrome, Eyebrow, Title, Body, Rule,
  S01_Title, S02_WhyNow, S03_WhyDecentralised, S03_OutputVsOutcome, S04_Centralisation,
  S05_Thesis, S06_Loop, S07_Services, S08_Architecture, S09_FairLaunch,
});
