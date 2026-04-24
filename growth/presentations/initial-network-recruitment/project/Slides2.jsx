// Jinn — Initial Network Recruitment deck (slides 10–15)

/* ================================================================
   10 — Governance on mainnet, day one
   ================================================================ */
const S10_Governance = ({ index, total }) => (
  <Slide label="11 Governance" index={index} total={total}>
    <div style={{ marginTop: 40, flex: 1, display: 'flex', flexDirection: 'column', gap: SPACING.titleGap }}>
      <Eyebrow>Day one, not day 180</Eyebrow>
      <Title style={{ maxWidth: '24ch' }}>
        Governance lives on Ethereum mainnet <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>from day one.</span>
      </Title>

      <div style={{
        marginTop: 24, display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        border: '1px solid var(--border)',
      }}>
        {[
          { v: '2d',  l: 'Voting delay' },
          { v: '14d', l: 'Voting period' },
          { v: '4%',  l: 'Quorum' },
          { v: '2d',  l: 'Timelock' },
          { v: '18d', l: 'Observation window', accent: true },
        ].map((k, i, a) => (
          <div key={k.l} style={{
            padding: '44px 28px',
            borderRight: i < a.length - 1 ? '1px solid var(--border)' : 0,
            background: k.accent ? 'var(--blue-800)' : 'transparent',
          }}>
            <div style={{
              fontFamily: 'var(--font-display)',
              fontSize: k.accent ? 140 : 120, lineHeight: 1,
              letterSpacing: '-0.025em',
              color: k.accent ? 'var(--gold-400)' : 'var(--blue-50)',
            }} className="data">{k.v}</div>
            <div style={{
              marginTop: 24, fontSize: TYPE_SCALE.label,
              letterSpacing: '0.2em', textTransform: 'uppercase',
              color: k.accent ? 'var(--gold-400)' : 'var(--fg-muted)',
            }}>{k.l}</div>
          </div>
        ))}
      </div>

      <Body style={{ color: 'var(--fg-muted)', maxWidth: '56ch', marginTop: 8, fontSize: TYPE_SCALE.bodySm, lineHeight: 1.45 }}>
        Every change gets 18 days of public observation between proposal and execution. No &ldquo;we&rsquo;ll migrate governance to mainnet once we&rsquo;re bigger.&rdquo;
      </Body>
    </div>
  </Slide>
);

/* ================================================================
   11 — Phase 0 shipped / 1a needs operators
   ================================================================ */
const S11_Phase = ({ index, total }) => (
  <Slide label="12 Where we are" index={index} total={total}>
    <div style={{ marginTop: 40, flex: 1, display: 'flex', flexDirection: 'column', gap: SPACING.titleGap }}>
      <Eyebrow>Where we are</Eyebrow>
      <Title style={{ maxWidth: '26ch' }}>
        Phase 0 is shipped. Phase 1a is <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>bottlenecked on operators.</span>
      </Title>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40, marginTop: 24 }}>
        {/* PHASE 0 */}
        <div style={{ border: '1px solid var(--vow-green)', padding: '32px 36px 36px', background: 'rgba(106,155,143,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
            <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--vow-green)' }}>
              Phase 0
            </div>
            <div style={{
              fontSize: 14, letterSpacing: '0.2em', textTransform: 'uppercase',
              color: 'var(--vow-green)', border: '1px solid var(--vow-green)',
              padding: '4px 10px', borderRadius: 4,
            }}>Complete</div>
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 48, lineHeight: 1.15, marginBottom: 28, letterSpacing: '-0.015em' }}>
            Contracts deployed. Client runs.
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              'Client daemon + on-chain contracts on Base mainnet',
              'End-to-end loop validated against Anvil fork of Base',
              '33 passing client tests',
              'TypeScript daemon; spawns Claude Code for solve + evaluate',
            ].map((t) => (
              <li key={t} style={{ fontFamily: 'var(--font-mono)', fontSize: TYPE_SCALE.small, lineHeight: 1.4, color: 'var(--fg)', letterSpacing: '-0.01em', paddingLeft: 20, position: 'relative' }}>
                <span style={{ position: 'absolute', left: 0, top: 12, width: 10, height: 1, background: 'var(--vow-green)' }} />
                {t}
              </li>
            ))}
          </ul>
        </div>

        {/* PHASE 1a */}
        <div style={{ border: '1px dashed var(--gold-400)', padding: '32px 36px 36px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
            <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--gold-400)' }}>
              Phase 1a
            </div>
            <div style={{
              fontSize: 14, letterSpacing: '0.2em', textTransform: 'uppercase',
              color: 'var(--gold-400)', border: '1px solid var(--gold-400)',
              padding: '4px 10px', borderRadius: 4,
            }}>In&nbsp;design</div>
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 48, lineHeight: 1.15, marginBottom: 28, letterSpacing: '-0.015em' }}>
            Token, Governor, Timelock, bridge.
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              'Sepolia + Base Sepolia for testing',
              'Ethereum + Base mainnet for live launch',
              'Launch gated on ~10 independent operators',
              'No live mainnet executions yet — that\u2019s the bottleneck',
            ].map((t) => (
              <li key={t} style={{ fontFamily: 'var(--font-mono)', fontSize: TYPE_SCALE.small, lineHeight: 1.4, color: 'var(--fg)', letterSpacing: '-0.01em', paddingLeft: 20, position: 'relative' }}>
                <span style={{ position: 'absolute', left: 0, top: 12, width: 10, height: 1, background: 'var(--gold-400)' }} />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  </Slide>
);

/* ================================================================
   12 — OLAS is the bootstrap, not the lock-in
   (The Aleks & Andrey slide — peer acknowledgement)
   ================================================================ */
const S12_Olas = ({ index, total }) => (
  <Slide label="13 vs OLAS" index={index} total={total} style={{ background: 'var(--blue-950)' }}>
    <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 40 }}>
      <Eyebrow>A word to the two of you</Eyebrow>
      <h2 style={{
        margin: 0, fontFamily: 'var(--font-display)',
        fontSize: 104, lineHeight: 1.05, letterSpacing: '-0.022em',
        maxWidth: '20ch', textWrap: 'balance',
      }}>
        OLAS is the <span style={{ color: 'var(--gold-400)' }}>bootstrap</span> &mdash; not the <span style={{ fontStyle: 'italic' }}>lock-in.</span>
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 56, marginTop: 8 }}>
        <div style={{ borderTop: '1px solid var(--gold-500)', paddingTop: 20 }}>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--gold-400)', marginBottom: 16 }}>
            What we use from OLAS
          </div>
          <Body style={{ lineHeight: 1.45, fontSize: TYPE_SCALE.bodySm, color: 'var(--fg)' }}>
            Mech Marketplace for request/delivery. Staking + activity-checker pattern for emissions.
          </Body>
        </div>
        <div style={{ borderTop: '1px solid var(--gold-500)', paddingTop: 20 }}>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--gold-400)', marginBottom: 16 }}>
            What Jinn adds on top
          </div>
          <Body style={{ lineHeight: 1.45, fontSize: TYPE_SCALE.bodySm, color: 'var(--fg)' }}>
            The loop (post &rarr; solve &rarr; evaluate). Evaluator &ne; solver. A separate DAO + token.
          </Body>
        </div>
      </div>

      <div style={{
        marginTop: 8, fontFamily: 'var(--font-display)',
        fontStyle: 'italic', fontSize: 36, lineHeight: 1.25,
        color: 'var(--fg-muted)', maxWidth: '60ch', letterSpacing: '-0.01em',
      }}>
        The Governor can redirect emissions if a better substrate emerges &mdash; the protocol isn&rsquo;t married to the one we grew up on.
      </div>
    </div>
  </Slide>
);

/* ================================================================
   13 — Why now, why you
   ================================================================ */
const S13_WhyYou = ({ index, total }) => (
  <Slide label="14 Why you" index={index} total={total}>
    <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 48 }}>
      <Eyebrow>Why we&rsquo;re talking to you before Phase 1a is deployed</Eyebrow>
      <h2 style={{
        margin: 0, fontFamily: 'var(--font-display)',
        fontSize: 72, lineHeight: 1.18, letterSpacing: '-0.02em',
        maxWidth: '28ch', textWrap: 'balance',
      }}>
        You being on the network <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>is part of what makes it legitimate.</span>
      </h2>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 40,
        marginTop: 56, padding: '40px 0',
        borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 120, lineHeight: 1, letterSpacing: '-0.025em', color: 'var(--blue-50)' }} className="data">
            ~10
          </div>
          <div style={{ marginTop: 12, fontSize: TYPE_SCALE.label, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
            Operators at mainnet launch
          </div>
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 88, color: 'var(--gold-400)' }}>
          &gt;
        </div>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 120, lineHeight: 1, letterSpacing: '-0.025em', color: 'var(--blue-50)' }} className="data">
            1,000
          </div>
          <div style={{ marginTop: 12, fontSize: TYPE_SCALE.label, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
            Operators at month six
          </div>
        </div>
      </div>
    </div>
  </Slide>
);

/* ================================================================
   14 — The ask (three ways in)
   ================================================================ */
const S14_Ask = ({ index, total }) => (
  <Slide label="15 The ask" index={index} total={total}>
    <div style={{ marginTop: 40, flex: 1, display: 'flex', flexDirection: 'column', gap: SPACING.titleGap }}>
      <Eyebrow color="var(--gold-400)">The ask</Eyebrow>
      <Title style={{ maxWidth: '22ch' }}>
        Three ways in. <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>Any one is enough.</span>
      </Title>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0, marginTop: 32, border: '1px solid var(--border)' }}>
        {[
          {
            n: '01',
            t: 'Run the client',
            d: 'On testnet, when Phase 1a is up. You\u2019re the kind of operator the mainnet launch is gated on.',
            tag: 'Testnet',
          },
          {
            n: '02',
            t: 'Open a PR',
            d: 'Any surface — protocol, client, docs. Monorepo at github.com/jinn-network/mono.',
            tag: 'Code',
          },
          {
            n: '03',
            t: 'File an issue',
            d: 'Tell us where the argument breaks. The specs are listed in the doc.',
            tag: 'Thinking',
          },
        ].map((a, i, arr) => (
          <div key={a.n} style={{
            padding: '36px 36px 40px',
            borderRight: i < arr.length - 1 ? '1px solid var(--border)' : 0,
            display: 'flex', flexDirection: 'column', gap: 24,
            background: 'var(--blue-800)',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 18,
                letterSpacing: '0.28em', color: 'var(--gold-400)',
              }} className="data">{a.n}</div>
              <div style={{
                fontSize: 14, letterSpacing: '0.2em',
                textTransform: 'uppercase', color: 'var(--fg-muted)',
                border: '1px solid var(--border)', padding: '3px 10px', borderRadius: 4,
              }}>{a.tag}</div>
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 72, lineHeight: 1, letterSpacing: '-0.018em' }}>
              {a.t}
            </div>
            <Body style={{ color: 'var(--fg-muted)', fontSize: TYPE_SCALE.bodySm, lineHeight: 1.45 }}>
              {a.d}
            </Body>
          </div>
        ))}
      </div>


    </div>
  </Slide>
);

/* ================================================================
   15 — Close: Read the doc, tell us where it breaks
   ================================================================ */
const S15_Close = ({ index, total }) => (
  <Slide label="16 Close" index={index} total={total} chrome={false} style={{ background: 'var(--blue-950)' }}>
    {/* Minimal chrome */}
    <div style={{
      position: 'absolute', top: 56, left: SPACING.paddingX, right: SPACING.paddingX,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <img src="assets/logo-sigil.svg" style={{ width: 28, height: 28, filter: 'brightness(0) invert(1)' }} alt=""/>
        <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 34, color: 'var(--blue-50)', lineHeight: 1 }}>jinn</span>
      </div>
      <span style={{ fontSize: 18, letterSpacing: '0.3em', textTransform: 'uppercase', color: 'var(--fg-dim)' }}>
        Fin
      </span>
    </div>

    <div className="texture-grid" style={{ position: 'absolute', inset: 0, opacity: 0.35, pointerEvents: 'none' }} />

    <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 56, position: 'relative' }}>
      <Eyebrow>Over to you</Eyebrow>
      <h1 style={{
        margin: 0, fontFamily: 'var(--font-display)',
        fontSize: 184, lineHeight: 0.95, letterSpacing: '-0.025em',
        maxWidth: '14ch', textWrap: 'balance',
      }}>
        Read the doc.<br/>
        <span style={{ fontStyle: 'italic', color: 'var(--gold-400)' }}>Tell us where it breaks.</span>
      </h1>

      <div style={{
        marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
        gap: 48, borderTop: '1px solid var(--border)', paddingTop: 28,
      }}>
        <div>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 10 }}>
            Monorepo
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, color: 'var(--blue-50)' }}>
            github.com/jinn-network/mono
          </div>
        </div>
        <div>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 10 }}>
            Eval doc
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, color: 'var(--blue-50)' }}>
            2026-04-23-jinn-eval-doc.md
          </div>
        </div>
        <div>
          <div style={{ fontSize: TYPE_SCALE.label, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 10 }}>
            Us
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, color: 'var(--blue-50)' }}>
            Oak &amp; Ritsu
          </div>
        </div>
      </div>
    </div>

    <div style={{
      position: 'absolute', bottom: 56, left: SPACING.paddingX, right: SPACING.paddingX,
      borderTop: '1px solid var(--border)', paddingTop: 18,
      display: 'flex', justifyContent: 'space-between',
      fontSize: 16, color: 'var(--fg-dim)', letterSpacing: '0.14em', textTransform: 'uppercase',
    }}>
      <span>The next ten matter more than the next thousand</span>
      <span>16 / {String(total).padStart(2,'0')}</span>
    </div>
  </Slide>
);

Object.assign(window, {
  S10_Governance, S11_Phase, S12_Olas, S13_WhyYou, S14_Ask, S15_Close,
});
