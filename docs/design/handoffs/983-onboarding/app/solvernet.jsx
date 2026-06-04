/* §2.5 SolverNet Registry — the discovery + join step rendered inside the
   Bootstrap takeover (and reusable as a gallery surface). Joining \u22651 net is
   gate-part-1 of the completion criterion. */

const { h: hr } = window;

function StatusBadge({ status }) {
  if (status === 'launched') return hr(window.Badge, { variant: 'success' }, hr('span', { className: 'dot' }), 'Launched');
  if (status === 'paused') return hr(window.Badge, { variant: 'pill' }, 'Paused');
  return hr(window.Badge, { variant: 'outline' }, 'Retired');
}

function RegistryCard({ net, joined, onJoin, onLeave }) {
  return hr('div', { className: 'card card-pad-sm col gap-3', style: { borderColor: joined ? 'var(--severity-success-border)' : undefined } },
    hr('div', { className: 'row between', style: { alignItems: 'flex-start', gap: 16 } },
      hr('div', { className: 'col gap-1 grow' },
        hr('div', { className: 'row gap-2 center wrap' },
          hr('span', { className: 'fg', style: { fontSize: 15, fontWeight: 500 } }, net.name),
          joined && hr(window.Badge, { variant: 'success' }, hr(window.Icon, { name: 'check', size: 10 }), 'Joined'),
        ),
        hr('span', { className: 'mono-xs' }, net.desc),
      ),
    ),
    hr('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 16, rowGap: 6, alignItems: 'baseline' } },
      hr('span', { className: 'mono-xs' }, 'Tasks posted 24hr'),
      hr('span', { className: 'mono-sm fg data', style: { textAlign: 'right' } }, net.posts24h.toLocaleString()),
    ),
    hr('div', { className: 'row between center', style: { gap: 12, paddingTop: 4 } },
      hr('a', { className: 'mono-xs', style: { color: 'var(--accent-sky)', textDecoration: 'none' }, href: '#' },
        'View more detail ', hr(window.Icon, { name: 'external', size: 11, className: '', })),
      joined
        ? hr(window.Button, { variant: 'secondary', size: 'sm', disabled: true }, hr(window.Icon, { name: 'check', size: 13 }), 'Joined')
        : hr(window.Button, { variant: 'default', size: 'sm', onClick: () => onJoin(net) }, 'Join'),
    ),
  );
}

/* The step. props: scenario, joined (map cid->roles), onJoin, onLeave */
function SolverNetStep({ scenario = 'default', joined = {}, onJoin, onLeave, embedded = true }) {
  // DEV NOTE: For this release we only surface swe-rebench-v2 — it's the only
  // SolverNet we want operators to access. This filter also drops paused nets.
  // Revisit when more nets are ready to be opened up.
  const nets = window.registrySet().filter((n) => n.name === 'swe-rebench-v2');
  const header = hr('div', { className: 'col gap-2' },
    !embedded && hr('span', { className: 'mono-sm', style: { maxWidth: '64ch' } },
      'Nodes like yours do work on \u201cSolverNets\u201d. Tasks are posted \u2014 your node posts solutions, and evaluates others\u2019 solutions. The SolverNet gets better at solving these tasks over time and your node accrues valuable knowledge. You can join more later.'));

  if (scenario === 'loading') {
    return hr('div', { className: 'col gap-4' }, header,
      hr('div', { className: 'col gap-3' }, [0, 1, 2].map((i) =>
        hr('div', { key: i, className: 'card card-pad-sm col gap-3' },
          hr('div', { className: 'row between' }, hr('span', { className: 'skeleton', style: { width: 160, height: 14 } }), hr('span', { className: 'skeleton', style: { width: 70, height: 18, borderRadius: 4 } })),
          hr('span', { className: 'skeleton', style: { width: '70%', height: 10 } }),
          hr('span', { className: 'skeleton', style: { width: '40%', height: 10 } })))),
      hr('span', { className: 'mono-xs', style: { display: 'flex', gap: 8, alignItems: 'center' } },
        hr(window.Icon, { name: 'spinner', size: 13, className: 'spin' }), 'Fetching the SolverNet registry…'));
  }
  if (scenario === 'error') {
    return hr('div', { className: 'col gap-4' }, header,
      hr(window.Alert, { variant: 'blocking', title: 'Registry unreachable.',
        action: hr(window.Button, { variant: 'secondary', size: 'sm' }, hr(window.Icon, { name: 'refresh', size: 13 }), 'Retry') },
        'The discovery indexer is down, so launched SolverNets can\u2019t be listed. Onboarding can\u2019t finish until it\u2019s reachable. Check your RPC endpoint, then retry.'));
  }
  if (scenario === 'empty') {
    return hr('div', { className: 'col gap-4' }, header,
      hr('div', { className: 'card card-pad', style: { textAlign: 'center', borderStyle: 'dashed' } },
        hr('div', { className: 'col gap-3', style: { alignItems: 'center', padding: '24px 0' } },
          hr(window.Icon, { name: 'network', size: 24, className: 'dim' }),
          hr('span', { className: 'fg', style: { fontSize: 15 } }, 'No launched SolverNets available.'),
          hr('span', { className: 'mono-sm', style: { maxWidth: '52ch' } }, 'The registry is reachable but nothing has launched on this network yet. Check back shortly.'))));
  }

  const joinedCount = Object.keys(joined).length;
  // 'joined-one' scenario seeds one joined net for the gallery.
  const seeded = scenario === 'joined-one' ? { 'bafy…swe2': ['solver', 'evaluator'] } : joined;
  return hr('div', { className: 'col gap-4' }, header,
    hr('div', { className: 'col gap-3' }, nets.map((net) =>
      hr(RegistryCard, { key: net.cid, net, joined: seeded[net.cid], onJoin, onLeave }))));
}

Object.assign(window, { SolverNetStep, RegistryCard, SolverNetStatusBadge: StatusBadge });
