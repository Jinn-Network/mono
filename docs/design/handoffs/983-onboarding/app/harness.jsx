/* §2.9 Harness Selection surface — ONE component, two homes (onboarding +
   settings), three legibility approaches (column / badges / grouped), full
   state set. Reports readiness up via onReady so the Bootstrap completion
   gate can enable/disable "Enter dashboard". */

const { h: hh, useState: uS, useEffect: uE } = window;

/* Build the harness set + initial selection for a scenario. */
function deriveSet(scenario) {
  const set = window.harnessSet();
  let selected = 'Codex';
  if (scenario === 'not-ready') selected = 'Hermes Agent';
  else if (scenario === 'auth-expired') selected = 'Codex';
  else if (scenario === 'version-mismatch') {
    const cc = set.find((x) => x.name === 'Claude Code');
    cc.ready = false; cc.authenticated = true; cc.installed = true;
    cc.message = 'Version mismatch';
    cc.reason = 'claude CLI 2.14.0 is outside the tested range — harness may misbehave.';
    cc.next = { description: 'Update the claude CLI, then re-check', cli: 'npm i -g @anthropic-ai/claude-code@latest' };
    selected = 'Claude Code';
  } else if (scenario === 'empty') {
    return { set: [], selected: null };
  }
  return { set, selected };
}

/* Resolve the at-a-glance status descriptor for a harness row. */
function statusOf(hx) {
  if (!hx.protocolAvailable) return { key: 'not-protocol', label: 'Not in protocol', variant: 'secondary' };
  if (!hx.nodeSupported) return { key: 'not-build', label: 'Unavailable here', variant: 'secondary' };
  if (hx.ready) return { key: 'ready', label: 'Ready', variant: 'success' };
  if (hx.message === 'Auth expired') return { key: 'auth', label: 'Auth expired', variant: 'warning' };
  if (hx.message === 'Version mismatch') return { key: 'ver', label: 'Version mismatch', variant: 'warning' };
  return { key: 'setup', label: 'Setup required', variant: 'destructive' };
}

function pickable(hx) { return hx.role === 'solver' && hx.protocolAvailable && hx.nodeSupported; }

/* Per-harness setup action block (install / authenticate / re-check). */
function SetupBlock({ hx, onRecheck, compact }) {
  if (hx.ready || !hx.next) return null;
  const isInstall = hx.message === 'Harness not installed';
  return hh('div', { className: 'col gap-2', style: { marginTop: compact ? 0 : 4 } },
    hx.reason && hh('span', { className: 'mono-xs', style: { color: 'var(--severity-warning-fg)' } }, hx.reason),
    hx.next.cli && hh('div', { className: 'row gap-2', style: { alignItems: 'stretch' } },
      hh('pre', { className: 'codeblock grow', style: { margin: 0 } }, hx.next.cli),
      hh(window.Button, { variant: 'secondary', size: 'sm', onClick: () => window.copyToClipboard(hx.next.cli) },
        hh(window.Icon, { name: 'copy', size: 13 }), 'Copy'),
    ),
    hh('div', { className: 'row gap-2' },
      hh(window.Button, { variant: 'default', size: 'sm', onClick: onRecheck },
        hh(window.Icon, { name: isInstall ? 'download' : 'lock', size: 13 }),
        isInstall ? 'Install & re-check' : 'Authenticate'),
      hh(window.Button, { variant: 'outline', size: 'sm', onClick: onRecheck },
        hh(window.Icon, { name: 'refresh', size: 13 }), 'Re-check'),
    ),
  );
}

/* role tag — roles are no longer surfaced; the one harness handles all work. */
function RoleTag() {
  return null;
}

/* ── Approach A — status column (dense list with an AVAILABILITY column) ── */
function ApproachColumn({ set, selected, onSelect, recheck }) {
  const solver = set.filter((x) => x.role === 'solver');
  const evaluator = set.filter((x) => x.role === 'evaluator');
  const Row = (hx) => {
    const st = statusOf(hx);
    const sel = hx.name === selected;
    const can = pickable(hx);
    return hh(window.Fragment, { key: hx.name },
      hh('div', {
        className: 'harness-grid-row', 'data-sel': sel ? '1' : '0',
        onClick: can ? () => onSelect(hx.name) : undefined,
        style: {
          display: 'grid', gridTemplateColumns: '20px 1.6fr 1fr auto', gap: 16, alignItems: 'center',
          padding: '14px 16px', borderTop: '1px solid var(--border)',
          cursor: can ? 'pointer' : 'default',
          background: sel ? 'rgba(122,167,220,.06)' : 'transparent',
        },
      },
        hh('span', { style: {
          width: 16, height: 16, borderRadius: 999, flexShrink: 0,
          border: '1px solid ' + (sel ? 'var(--accent-sky)' : 'var(--border-strong)'),
          background: sel ? 'var(--accent-sky)' : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: can ? 1 : 0.25,
        } }, sel && hh('span', { style: { width: 6, height: 6, borderRadius: 999, background: 'var(--bg-sunken)' } })),
        hh('div', { className: 'col gap-1' },
          hh('div', { className: 'row gap-2 center wrap' },
            hh('span', { className: 'fg', style: { fontSize: 14, fontWeight: 500 } }, hx.name),
          ),
        ),
        hh('div', { className: 'col gap-1' },
          hh('div', { className: 'row gap-2 center' },
            hh(window.TierDots, { ...hx }),
            hh('span', { className: 'mono-xs', style: { textTransform: 'none', letterSpacing: 0 } },
              !hx.protocolAvailable ? 'not in manifest' : !hx.nodeSupported ? 'not in build' : hx.ready ? 'installed · authed' : 'pickable'),
          ),
        ),
        hh(window.Badge, { variant: st.variant }, st.label),
      ),
      sel && !hx.ready && hh('div', { style: { padding: '0 16px 16px 52px', borderTop: '1px solid transparent' } },
        hh(SetupBlock, { hx, onRecheck: () => recheck(hx.name) })),
      !can && hx.protocolAvailable && !hx.nodeSupported && hh('div', { style: { padding: '0 16px 14px 52px' } },
        hh('span', { className: 'mono-xs' }, hx.reason)),
    );
  };
  return hh('div', { className: 'card', style: { overflow: 'hidden' } },
    hh('div', { style: {
      display: 'grid', gridTemplateColumns: '20px 1.6fr 1fr auto', gap: 16,
      padding: '10px 16px', background: 'var(--bg-sunken)',
    } },
      hh('span', {}),
      hh(window.Eyebrow, { tone: 'dim' }, 'Harness'),
      hh(window.Eyebrow, { tone: 'dim' }, 'Availability'),
      hh(window.Eyebrow, { tone: 'dim' }, 'Status'),
    ),
    solver.map(Row),
  );
}

/* ── Approach B — tiered badge set (cards, each carries 3 chained tiers) ── */
function TierChain({ hx }) {
  const tiers = [
    { label: 'Protocol', ok: hx.protocolAvailable, hint: 'declared by manifest' },
    { label: 'Build', ok: hx.protocolAvailable && hx.nodeSupported, hint: 'compiled into node' },
    { label: 'Ready', ok: hx.ready, hint: 'installed · authed', last: true },
  ];
  return hh('div', { className: 'row center', style: { gap: 0 } },
    tiers.map((t, i) => hh(window.Fragment, { key: t.label },
      i > 0 && hh('span', { style: { width: 14, height: 1, background: t.ok ? 'var(--accent-sky)' : 'var(--border)' } }),
      hh('span', {
        title: t.hint,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
          borderRadius: 999, border: '1px solid ' + (t.ok ? (t.last ? 'var(--severity-success-border)' : 'var(--accent-sky)') : 'var(--border)'),
          color: t.ok ? (t.last ? 'var(--vow-green)' : 'var(--accent-sky)') : 'var(--fg-dim)',
          background: t.ok && t.last ? 'var(--severity-success-bg)' : 'transparent',
          fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 500, whiteSpace: 'nowrap',
        },
      },
        hh('span', { style: {
          width: 11, height: 11, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid currentColor', flexShrink: 0,
        } }, t.ok && hh(window.Icon, { name: 'check', size: 8 })),
        t.label,
      ),
    )),
  );
}
function ApproachBadges({ set, selected, onSelect, recheck }) {
  return hh('div', { className: 'col gap-3' },
    set.map((hx) => {
      const st = statusOf(hx);
      const sel = hx.name === selected;
      const can = pickable(hx);
      return hh('div', {
        key: hx.name,
        className: 'card card-pad-sm' + (can ? ' hoverable' : ''),
        onClick: can ? () => onSelect(hx.name) : undefined,
        style: {
          cursor: can ? 'pointer' : 'default',
          borderColor: sel ? 'var(--accent-sky)' : undefined,
          opacity: can ? 1 : 0.78,
        },
      },
        hh('div', { className: 'row between center wrap', style: { gap: 12 } },
          hh('div', { className: 'row gap-2 center wrap' },
            can && hh('span', { style: {
              width: 15, height: 15, borderRadius: 999, flexShrink: 0,
              border: '1px solid ' + (sel ? 'var(--accent-sky)' : 'var(--border-strong)'),
              background: sel ? 'var(--accent-sky)' : 'transparent',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            } }, sel && hh('span', { style: { width: 6, height: 6, borderRadius: 999, background: 'var(--bg-sunken)' } })),
            hh('span', { className: 'fg', style: { fontSize: 14, fontWeight: 500 } }, hx.name),
            hh(RoleTag, { hx }),
          ),
          hh(TierChain, { hx }),
        ),
        hh('span', { className: 'mono-xs', style: { marginTop: 8, display: 'block' } }, hx.desc),
        !hx.nodeSupported && hx.protocolAvailable && hh('span', { className: 'mono-xs', style: { display: 'block', marginTop: 6 } }, hx.reason),
        sel && !hx.ready && hh('div', { style: { marginTop: 12 } }, hh(SetupBlock, { hx, onRecheck: () => recheck(hx.name) })),
      );
    }),
  );
}

/* ── Approach C — grouped by actionability (ready / needs setup / unavailable) ── */
function ApproachGrouped({ set, selected, onSelect, recheck }) {
  const groups = [
    { key: 'ready', title: 'Ready to pick', hint: 'installed and authenticated on this machine',
      rows: set.filter((x) => pickable(x) && x.ready) },
    { key: 'setup', title: 'Needs setup', hint: 'pickable once installed / authenticated',
      rows: set.filter((x) => pickable(x) && !x.ready && x.role === 'solver') },
    { key: 'unavail', title: 'Unavailable here', hint: 'protocol-available but not in this node build — informational',
      rows: set.filter((x) => x.role === 'solver' && (!x.protocolAvailable || !x.nodeSupported)) },
  ].filter((g) => g.rows.length > 0);
  const evaluator = set.filter((x) => x.role === 'evaluator');

  const Row = (hx, can) => {
    const sel = hx.name === selected;
    const st = statusOf(hx);
    return hh('div', { key: hx.name },
      hh('div', {
        onClick: can ? () => onSelect(hx.name) : undefined,
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '12px 0', cursor: can ? 'pointer' : 'default',
        },
      },
        hh('div', { className: 'row gap-2 center wrap' },
          can && hh('span', { style: {
            width: 15, height: 15, borderRadius: 999, flexShrink: 0,
            border: '1px solid ' + (sel ? 'var(--accent-sky)' : 'var(--border-strong)'),
            background: sel ? 'var(--accent-sky)' : 'transparent',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          } }, sel && hh('span', { style: { width: 6, height: 6, borderRadius: 999, background: 'var(--bg-sunken)' } })),
          hh('div', { className: 'col gap-1' },
            hh('span', { className: 'fg', style: { fontSize: 14, fontWeight: 500 } }, hx.name),
            hh('span', { className: 'mono-xs' }, hx.desc),
          ),
        ),
        hh(window.Badge, { variant: st.variant }, st.label),
      ),
      sel && !hx.ready && hh('div', { style: { padding: '0 0 12px 27px' } }, hh(SetupBlock, { hx, onRecheck: () => recheck(hx.name) })),
      !can && hh('div', { style: { padding: '0 0 12px 0' } }, hh('span', { className: 'mono-xs' }, hx.reason)),
    );
  };

  return hh('div', { className: 'col gap-4' },
    groups.map((g) => hh('div', { key: g.key, className: 'card', style: { overflow: 'hidden' } },
      hh('div', { className: 'row between center', style: { padding: '12px 16px', background: 'var(--bg-sunken)' } },
        hh(window.Eyebrow, { tone: g.key === 'ready' ? 'gold' : 'dim' }, g.title),
        hh('span', { className: 'mono-xs', style: { textTransform: 'none', letterSpacing: 0 } }, g.hint),
      ),
      hh('div', { style: { padding: '0 16px' } }, g.rows.map((hx) => Row(hx, g.key !== 'unavail'))),
    )),
    evaluator.length > 0 && hh('div', { className: 'card', style: { overflow: 'hidden' } },
      hh('div', { className: 'row between center', style: { padding: '12px 16px', background: 'var(--bg-sunken)' } },
        hh(window.Eyebrow, { tone: 'dim' }, 'Evaluator · manifest-bound'),
        hh('span', { className: 'mono-xs', style: { textTransform: 'none', letterSpacing: 0 } }, 'set for you by the SolverNet'),
      ),
      hh('div', { style: { padding: '0 16px' } }, evaluator.map((hx) => Row(hx, false))),
    ),
  );
}

const APPROACH_RENDER = { column: ApproachColumn, badges: ApproachBadges, grouped: ApproachGrouped };

/* ── the surface ─────────────────────────────────────────────────────────
   props: approach, context ('onboarding'|'settings'), scenario, solverNet,
   evaluatorOnly, onReady(bool), onProceed(), embedded(bool) */
function HarnessSurface(props) {
  const { approach = 'column', context = 'onboarding', scenario = 'default',
    solverNet = 'swe-rebench-v2', onReady, embedded = true } = props;

  const init = deriveSet(scenario);
  const [set, setSet] = uS(init.set);
  const [selected, setSelected] = uS(init.selected);
  const [evaluatorOnly, setEvaluatorOnly] = uS(scenario === 'evaluator-only');
  const [model, setModel] = uS(() => {
    const s = init.set.find((x) => x.name === init.selected);
    return s && s.ready ? s.defaultModel : '';
  });

  const selHx = set.find((x) => x.name === selected);
  const solverReady = !evaluatorOnly && selHx && selHx.ready && !!model;
  const ready = evaluatorOnly || solverReady;
  uE(() => { onReady && onReady(ready, { harness: selHx ? selHx.name : null, model, evaluatorOnly }); }, [ready, selHx && selHx.name, model, evaluatorOnly]);

  const recheck = (name) => {
    // Simulate a successful install/auth → drive the harness to ready (tier 3).
    setSet((prev) => prev.map((x) => x.name === name
      ? { ...x, installed: true, authenticated: true, ready: true, message: null, reason: '', next: null }
      : x));
    const hx = set.find((x) => x.name === name);
    if (hx && !model) setModel(hx.defaultModel);
  };
  const onSelect = (name) => {
    setEvaluatorOnly(false);
    setSelected(name);
    const hx = set.find((x) => x.name === name);
    setModel(hx && hx.ready ? hx.defaultModel : '');
  };

  // ── surface-level states ──
  const header = hh('div', { className: 'col gap-2' },
    !embedded && hh('span', { className: 'mono-sm', style: { maxWidth: '62ch' } },
      'Choose which harness and model your node uses for its work.'),
  );

  if (scenario === 'loading') {
    return hh('div', { className: 'col gap-4' }, header,
      hh('div', { className: 'card', style: { overflow: 'hidden' } },
        [0, 1, 2].map((i) => hh('div', { key: i, style: { display: 'grid', gridTemplateColumns: '20px 1.6fr 1fr auto', gap: 16, alignItems: 'center', padding: '16px', borderTop: i ? '1px solid var(--border)' : 'none' } },
          hh('span', { className: 'skeleton', style: { width: 16, height: 16, borderRadius: 999 } }),
          hh('div', { className: 'col gap-2' }, hh('span', { className: 'skeleton', style: { width: 120, height: 12 } }), hh('span', { className: 'skeleton', style: { width: 220, height: 10 } })),
          hh('span', { className: 'skeleton', style: { width: 90, height: 12 } }),
          hh('span', { className: 'skeleton', style: { width: 64, height: 18, borderRadius: 4 } }),
        ))),
      hh('span', { className: 'mono-xs', style: { display: 'flex', gap: 8, alignItems: 'center' } },
        hh(window.Icon, { name: 'spinner', size: 13, className: 'spin' }), 'Probing harness readiness on this machine…'));
  }
  if (scenario === 'error') {
    return hh('div', { className: 'col gap-4' }, header,
      hh(window.Alert, { variant: 'blocking', title: 'Readiness check failed.',
        action: hh(window.Button, { variant: 'secondary', size: 'sm', onClick: () => {} }, hh(window.Icon, { name: 'refresh', size: 13 }), 'Retry') },
        'Could not reach the daemon to probe harness readiness. Check that the node daemon is running, then retry.'));
  }
  if (scenario === 'empty' || set.length === 0) {
    return hh('div', { className: 'col gap-4' }, header,
      hh('div', { className: 'card card-pad', style: { textAlign: 'center', borderStyle: 'dashed' } },
        hh('div', { className: 'col gap-3', style: { alignItems: 'center', padding: '24px 0' } },
          hh(window.Icon, { name: 'cpu', size: 24, className: 'dim' }),
          hh('span', { className: 'fg', style: { fontSize: 15 } }, 'No solver harness available for this SolverNet on this build.'),
          hh('span', { className: 'mono-sm', style: { maxWidth: '54ch' } },
            'This SolverNet\u2019s manifest declares no harness that your installed node binary supports. Join as evaluator only, or update your node build.'),
          hh(window.Button, { variant: 'outline', size: 'sm', onClick: () => setEvaluatorOnly(true) }, 'Join as evaluator only'))));
  }

  const Render = APPROACH_RENDER[approach] || ApproachColumn;

  // model picker — only once a ready solver harness is selected
  const modelPicker = (!evaluatorOnly && selHx && selHx.ready) && hh('div', { className: 'card card-pad-sm col gap-3' },
    hh('div', { className: 'row between center' },
      hh(window.Eyebrow, {}, 'Model')),
    hh('select', { className: 'field', value: model, onChange: (e) => setModel(e.target.value) },
      hh('option', { value: '' }, 'Select a model…'),
      selHx.models.map((m) => hh('option', { key: m, value: m }, m))),
    hh('span', { className: 'mono-xs' }, 'Usage is designed to use a small amount of a subscription or API, but please monitor as this is alpha software.'));

  return hh('div', { className: 'col gap-4' },
    header,
    hh(Render, { set, selected: evaluatorOnly ? null : selected, onSelect, recheck }),
    modelPicker,
    // readiness summary line
    hh('div', { className: 'row gap-2 center', style: { marginTop: 2 } },
      hh('span', { className: ready ? 'pulse' : '', style: ready ? {} : { width: 7, height: 7, borderRadius: 999, background: 'var(--wane)' } }),
      hh('span', { className: 'mono-xs', style: { textTransform: 'none', letterSpacing: 0, color: ready ? 'var(--vow-green)' : 'var(--wane)' } },
        !selHx ? 'Pick a harness to continue.'
          : !selHx.ready ? selHx.name + ' is not ready — ' + (selHx.message || 'finish setup above') + '.'
          : !model ? 'Select a model to continue.'
          : selHx.name + ' ready · ' + model + ' — your node is eligible to claim tasks.')),
  );
}

window.HarnessSurface = HarnessSurface;
window.harnessStatusOf = statusOf;
