/* "You're live" Operating entry (no residue) + Settings home for the §2.9
   surface (one component, two homes) + the top-level OperatorApp router. */

const { h: hp, useState: uSp } = window;

function nameForCid(cid) { const n = window.registrySet().find((x) => x.cid === cid); return n ? n.name : cid; }

function TabBar({ route, setRoute }) {
  const tabs = [['overview', 'Overview'], ['memberships', 'Memberships'], ['tasks', 'Tasks'], ['rewards', 'Rewards'], ['settings', 'Settings']];
  return hp('nav', { className: 'row', style: { gap: 0, marginLeft: 40 } },
    tabs.map(([k, label]) => hp('button', {
      key: k, type: 'button', onClick: () => setRoute(k === 'memberships' || k === 'tasks' || k === 'rewards' ? 'overview' : k),
      style: {
        background: 'transparent', border: '1px solid transparent', cursor: 'pointer',
        font: 'inherit', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
        padding: '8px 16px', borderRadius: 6,
        color: (route === k || (route === 'overview' && k === 'overview')) ? 'var(--fg)' : 'var(--fg-muted)',
        borderColor: (route === k) ? 'var(--border-strong)' : 'transparent',
      },
    }, label)));
}

function OperatingChrome({ route, setRoute, children }) {
  return hp('div', { style: { minHeight: '100vh' } },
    hp('header', { className: 'row between center', style: { padding: '16px 32px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 10 } },
      hp('div', { className: 'row center' },
        hp('div', { className: 'row gap-3 center' },
          hp(window.JinnSigil, { size: 26 }),
          hp('span', { className: 'serif italic', style: { fontSize: 28, lineHeight: 1 } }, 'jinn'),
          hp('span', { className: 'eyebrow', style: { marginLeft: 8, paddingLeft: 14, borderLeft: '1px solid var(--border)' } }, 'Operator')),
        hp(TabBar, { route, setRoute })),
      hp('div', { className: 'row gap-3 center' },
        hp(window.Badge, { variant: 'success' }, hp('span', { className: 'pulse', style: { width: 6, height: 6 } }), 'Running'),
        hp(window.Badge, { variant: 'outline' }, hp('span', { className: 'dot', style: { background: 'var(--accent-gold)' } }), 'Base Sepolia'))),
    hp('main', { style: { maxWidth: 1200, margin: '0 auto', padding: '40px 32px 96px' } }, children));
}

function MetricCard({ eyebrow, value, sub, foot }) {
  return hp('div', { className: 'card card-pad col gap-3' },
    hp(window.Eyebrow, {}, eyebrow),
    hp('div', { className: 'col gap-1' },
      hp('span', { className: 'fg data', style: { fontSize: 30, fontFamily: 'var(--mono)', lineHeight: 1 } }, value),
      sub && hp('span', { className: 'mono-xs' }, sub)),
    foot);
}

function MembershipRow({ cid, roles, harness, onChange }) {
  const evalOnly = harness && harness.evaluatorOnly;
  return hp('div', { className: 'card card-pad-sm col gap-3' },
    hp('div', { className: 'row between center wrap', style: { gap: 12 } },
      hp('div', { className: 'row gap-2 center wrap' },
        hp('span', { className: 'fg', style: { fontSize: 15, fontWeight: 500 } }, nameForCid(cid)),
        roles.map((r) => hp(window.Badge, { key: r, variant: 'outline', style: { borderRadius: 999 } }, r))),
      hp('span', { className: 'row gap-2 center' },
        hp('span', { className: 'pulse', style: { width: 6, height: 6 } }),
        hp('span', { className: 'mono-xs', style: { textTransform: 'none', letterSpacing: 0 } }, 'last action 4s ago'))),
    hp('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 16, rowGap: 6 } },
      hp('span', { className: 'mono-xs' }, 'Solver harness'),
      hp('span', { className: 'mono-sm fg' }, evalOnly ? '—  (evaluator-only)' : (harness && harness.harness || 'Claude Code')),
      hp('span', { className: 'mono-xs' }, 'Model'),
      hp('span', { className: 'mono-sm fg' }, evalOnly ? '—' : (harness && harness.model || 'Claude Sonnet 4.6')),
      hp('span', { className: 'mono-xs' }, 'Evaluator'),
      hp('span', { className: 'mono-sm fg' }, 'swe-rebench-v2-evaluator · ready')),
    onChange && hp('div', { className: 'row between center', style: { gap: 12 } },
      hp('span', { className: 'row gap-2 center' }, hp(window.Badge, { variant: 'success' }, 'Ready · claiming')),
      hp(window.Button, { variant: 'secondary', size: 'sm', onClick: onChange }, hp(window.Icon, { name: 'settings', size: 13 }), 'Change environment')));
}

function OperatingEntry({ joined, harness, setRoute }) {
  const cids = Object.keys(joined);
  const activity = [
    ['Claimed', 'task swe-2218 — fix flaky retry', '4s ago', 'success'],
    ['Delivered', 'task swe-2209 — null-deref in parser', '2m ago', 'success'],
    ['Evaluated', 'verdict on swe-2207 — pass', '6m ago', 'info'],
    ['Claimed', 'task swe-2201 — add pagination', '11m ago', 'success'],
  ];
  return hp('div', { className: 'col gap-6' },
    // you're-live hero — reads as "live", not "finish setup"
    hp('div', { className: 'row between center wrap', style: { gap: 16 } },
      hp('div', { className: 'col gap-2' },
        hp('div', { className: 'row gap-3 center' },
          hp('span', { className: 'pulse' }),
          hp('h1', { className: 'serif', style: { fontSize: 48, margin: 0, lineHeight: 1 } }, 'You\u2019re live.')),
        hp('span', { className: 'mono-sm', style: { maxWidth: '56ch' } }, 'Your node is running and claiming tasks. Nothing left to set up.')),
      hp('div', { className: 'col gap-1', style: { textAlign: 'right' } },
        hp(window.Eyebrow, { tone: 'dim' }, 'Node'),
        hp('code', { style: { fontSize: 13 } }, 'vessel-0x91be…44a2'))),
    hp('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 } },
      hp(MetricCard, { eyebrow: 'Node health', value: 'Running', sub: 'uptime 00:01:12 · claiming', foot: hp(window.Badge, { variant: 'success' }, hp(window.Icon, { name: 'check', size: 10 }), 'Eligible') }),
      hp(MetricCard, { eyebrow: 'Memberships', value: String(cids.length || 1), sub: cids.length === 1 || !cids.length ? '1 SolverNet · solver + evaluator' : cids.length + ' SolverNets', foot: hp(window.Badge, { variant: 'success' }, 'Harness ready') }),
      hp(MetricCard, { eyebrow: 'Funds · runway', value: '0.0096 ETH', sub: '~ 31 days at current burn', foot: hp('a', { className: 'mono-xs', href: '#', style: { color: 'var(--accent-sky)', textDecoration: 'none' } }, 'Per-role drill-down \u2192') }),
      hp(MetricCard, { eyebrow: 'Rewards · claimable', value: '0 JINN', sub: 'first epoch settles in ~2h', foot: hp('span', { className: 'mono-xs' }, 'no claim yet') })),
    // memberships + activity
    hp('div', { style: { display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 24, alignItems: 'start' } },
      hp('div', { className: 'col gap-4' },
        hp('div', { className: 'section-head' }, hp(window.Eyebrow, { tone: 'fg' }, 'Memberships'), hp('a', { className: 'mono-xs', href: '#', style: { color: 'var(--accent-sky)', textDecoration: 'none', textTransform: 'none', letterSpacing: 0 }, onClick: (e) => { e.preventDefault(); setRoute('settings'); } }, 'Manage in Settings \u2192')),
        (cids.length ? cids : ['bafy…swe2']).map((cid) => hp(MembershipRow, { key: cid, cid, roles: joined[cid] || ['solver', 'evaluator'], harness, onChange: () => setRoute('settings') }))),
      hp('div', { className: 'col gap-4' },
        hp('div', { className: 'section-head' }, hp(window.Eyebrow, { tone: 'fg' }, 'Recent activity'), hp('span', { className: 'mono-xs' }, 'live')),
        hp('div', { className: 'card', style: { overflow: 'hidden' } },
          activity.map((a, i) => hp('div', { key: i, className: 'row between center', style: { padding: '12px 16px', borderTop: i ? '1px solid var(--border)' : 'none' } },
            hp('div', { className: 'row gap-3 center' },
              hp(window.Badge, { variant: a[3] }, a[0]),
              hp('span', { className: 'mono-xs', style: { textTransform: 'none', letterSpacing: 0, color: 'var(--fg)' } }, a[1])),
            hp('span', { className: 'mono-xs' }, a[2])))))));
}

/* Settings home — same §2.9 surface, reached via "change environment". */
function SettingsHome({ harnessApproach, joined, harness }) {
  const [editing, setEditing] = uSp(false);
  const [changed, setChanged] = uSp(false);
  const cids = Object.keys(joined).length ? Object.keys(joined) : ['bafy…swe2'];
  return hp('div', { className: 'col gap-7' },
    hp('div', { className: 'col gap-2' },
      hp('h1', { className: 'serif', style: { fontSize: 44, margin: 0, lineHeight: 1 } }, 'Settings'),
      hp('span', { className: 'mono-sm' }, 'Operator-tunable configuration. The same harness surface you saw in onboarding lives here.')),

    changed && hp(window.Alert, { variant: 'warning', title: 'Restart required to apply.',
      action: hp(window.Button, { variant: 'secondary', size: 'sm', onClick: () => setChanged(false) }, 'Restart node') },
      'You changed a membership\u2019s harness/model. The daemon picks it up on the next restart.'),

    hp('div', { className: 'col gap-4' },
      hp('div', { className: 'section-head' }, hp(window.Eyebrow, { tone: 'fg' }, 'Memberships · environment'), hp('span', { className: 'mono-xs' }, 'change harness / model per SolverNet')),
      !editing
        ? hp('div', { className: 'col gap-3' }, cids.map((cid) => hp(window.MembershipRow, { key: cid, cid, roles: joined[cid] || ['solver', 'evaluator'], harness, onChange: () => setEditing(true) })))
        : hp('div', { className: 'card card-pad col gap-4' },
            hp('div', { className: 'row between center' },
              hp('span', { className: 'mono-sm fg' }, 'Change environment — ', hp('code', null, 'swe-rebench-v2')),
              hp(window.Button, { variant: 'secondary', size: 'sm', onClick: () => setEditing(false) }, hp(window.Icon, { name: 'arrow-left', size: 13 }), 'Back')),
            hp('hr', { className: 'rule' }),
            hp(window.HarnessSurface, { approach: harnessApproach, context: 'settings', embedded: false, onReady: () => {} }),
            hp('div', { className: 'row between center', style: { paddingTop: 8, borderTop: '1px solid var(--border)' } },
              hp('span', { className: 'mono-xs' }, 'Harness/model changes are restart-required (\u00a73.2).'),
              hp(window.Button, { variant: 'default', size: 'sm', onClick: () => { setChanged(true); setEditing(false); } }, 'Save environment')))),

    hp('div', { className: 'col gap-4' },
      hp('div', { className: 'section-head' }, hp(window.Eyebrow, { tone: 'fg' }, 'Node'), hp('span', { className: 'mono-xs' }, 'read-only')),
      hp('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16 } },
        hp('div', { className: 'card card-pad-sm col gap-2' }, hp(window.Eyebrow, { tone: 'dim' }, 'RPC endpoint'),
          hp('span', { className: 'mono-sm fg' }, 'fallback chain (2 providers)'), hp('span', { className: 'mono-xs' }, 'primary = publicnode · restart-required')),
        hp('div', { className: 'card card-pad-sm col gap-2' }, hp(window.Eyebrow, { tone: 'dim' }, 'Task posts · 24h'),
          hp('span', { className: 'mono-sm fg data' }, '1,896'), hp('span', { className: 'mono-xs' }, 'chain-wide · block-window approx.')),
        hp('div', { className: 'card card-pad-sm col gap-2' }, hp(window.Eyebrow, { tone: 'dim' }, 'Default harness'),
          hp('span', { className: 'mono-sm fg' }, 'Claude Code'), hp('span', { className: 'mono-xs' }, 'seeds new joins')))));
}

window.MembershipRow = MembershipRow;

function OperatorApp({ initialRoute = 'onboarding', flow = 'sequential', harnessApproach = 'column' }) {
  const [route, setRoute] = uSp(initialRoute);
  const [joined, setJoined] = uSp({});
  const [harness, setHarness] = uSp({ harness: 'Claude Code', model: 'Claude Sonnet 4.6', evaluatorOnly: false });

  if (route === 'onboarding') {
    return hp(window.OnboardingTakeover, {
      flow, harnessApproach,
      onComplete: (payload) => {
        if (payload) { setJoined(payload.joined || {}); setHarness(payload.harness || harness); }
        setRoute('overview');
      },
    });
  }
  return hp(OperatingChrome, { route, setRoute },
    route === 'settings'
      ? hp(SettingsHome, { harnessApproach, joined, harness })
      : hp(OperatingEntry, { joined, harness, setRoute }));
}

Object.assign(window, { OperatingEntry, SettingsHome, OperatorApp, OperatingChrome });
