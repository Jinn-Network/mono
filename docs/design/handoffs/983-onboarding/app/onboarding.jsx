/* §2.8 Bootstrap takeover — the full guided onboarding flow with the two new
   selection steps (SolverNet + harness/model) sequenced BEFORE the running
   flip. Completion gate: cannot reach the dashboard without \u22651 joined
   SolverNet AND a ready harness + model (or the evaluator-only equivalent). */

const { h: ho, useState: uSo, useEffect: uEo } = window;

function JinnSigil({ size = 26 }) {
  return ho('span', { style: {
    width: size, height: size, borderRadius: 999, border: '1px solid var(--fg)', position: 'relative', flexShrink: 0, display: 'inline-block',
  } },
    ho('span', { style: { position: 'absolute', inset: 5, border: '1px solid var(--fg)', borderRadius: 999, opacity: 0.55 } }),
    ho('span', { style: { position: 'absolute', left: '50%', top: -3, bottom: -3, width: 1, background: 'var(--fg)', transform: 'translateX(-50%)' } }),
  );
}

function PhaseRow({ index, label, status, active, children }) {
  const tag = status === 'done' ? 'Done' : status === 'active' ? 'Active' : 'Queued';
  const tagColor = status === 'done' ? 'var(--vow-green)' : status === 'active' ? 'var(--accent-gold)' : 'var(--fg-dim)';
  return ho('li', { className: 'phase-row', 'data-status': status, style: {
    listStyle: 'none', padding: '14px 16px', borderBottom: '1px solid var(--border)',
    background: status === 'active' ? 'linear-gradient(90deg, rgba(220,184,102,.05) 0%, transparent 70%)' : 'transparent',
  } },
    ho('div', { className: 'row gap-3 center', style: { opacity: status === 'queued' ? 0.5 : 1 } },
      ho('span', { style: {
        width: 26, height: 26, borderRadius: 999, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid ' + (status === 'done' ? 'var(--vow-green)' : status === 'active' ? 'var(--accent-gold)' : 'var(--border-strong)'),
        color: status === 'done' ? 'var(--vow-green)' : status === 'active' ? 'var(--accent-gold)' : 'var(--fg-dim)',
        fontSize: 11, fontVariantNumeric: 'tabular-nums',
      } }, status === 'done' ? ho(window.Icon, { name: 'check', size: 13 }) : String(index).padStart(2, '0')),
      ho('span', { className: 'grow fg', style: { fontSize: 14 } }, label),
      ho('span', { className: 'eyebrow', style: { color: tagColor, fontSize: 10 } }, tag),
    ),
  );
}

/* ── Shipped bootstrap phases (faithful to spa/src/regions/Onboarding.tsx) ──
   The live takeover is a single always-visible list of three phases; the
   active one expands inline. Phase 2 → the faucet funding card, Phase 3 →
   the deploy sub-state line. Recreated here so the whole flow is visible
   end-to-end and reworkable. */

function AddrGrid({ rows }) {
  return ho('div', { style: { display: 'grid', gridTemplateColumns: '120px 1fr', columnGap: 16, rowGap: 6, fontSize: 12 } },
    rows.flatMap(([k, v, link], i) => [
      ho('span', { key: 'k' + i, className: 'dim' }, k),
      link
        ? ho('a', { key: 'v' + i, href: '#', style: { color: 'var(--accent-sky)', textDecoration: 'none', wordBreak: 'break-all' } }, v)
        : ho('span', { key: 'v' + i, className: 'fg', style: { wordBreak: 'break-all', fontFamily: 'var(--mono)' } }, v),
    ]));
}

// SubStateLine — the live "running · no action needed" status card.
function SubStateLine({ label, hint, rows }) {
  return ho('div', { className: 'card card-pad-sm col gap-3' },
    ho('div', { className: 'row gap-3 center' },
      ho('span', { className: 'pulse', style: { background: 'var(--accent-sky)' } }),
      ho('span', { className: 'fg', style: { fontSize: 14 } }, label),
      ho('span', { className: 'mono-xs', style: { marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, color: 'var(--fg-dim)' } }, hint || 'running · no action needed')),
    rows && ho(AddrGrid, { rows }));
}

/* Phase 1 — Provisioning your wallet. Live shows the bare active row; we
   surface the three on-chain identities being provisioned. */
function WalletPhase() {
  return ho('div', { className: 'col gap-4' },
    ho(SubStateLine, { label: 'Provisioning', hint: 'running · no action needed', rows: [
      ['Master', '0x7a2f4b9e…c019'],
      ['Agent', '0x91be…44a2'],
      ['Safe (predicted)', '0x33de…0f17', true],
    ] }));
}

/* Phase 2 — Fund your wallet. Faithful to AwaitingFundingCard: a warning
   alert with the master EOA, faucet/copy/explorer actions, RPC nudge. */
function FundPhase() {
  const [copied, setCopied] = uSo(false);
  return ho('div', { className: 'col gap-4' },
    ho('div', { className: 'alert alert-warning', style: { flexDirection: 'column', gap: 16, borderLeftWidth: 2, padding: '20px 24px' } },
      ho('div', { className: 'row between', style: { alignItems: 'baseline' } },
        ho('span', { className: 'eyebrow gold' }, 'Action needed · fund the master EOA')),
      ho('div', { className: 'col gap-1' },
        ho('span', { className: 'fg', style: { fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all' } }, '0x7a2f4b9e3c8d1a05f6029b7e4411d8c2a90fc019'),
        ho('span', { className: 'mono-xs' }, 'requires at least 0.010 ETH on Base Sepolia')),
      ho('div', { className: 'row gap-2 wrap' },
        ho(window.Button, { variant: 'gold', size: 'sm' }, 'Fund from faucet'),
        ho(window.Button, { variant: 'secondary', size: 'sm', onClick: () => { setCopied(true); setTimeout(() => setCopied(false), 1500); window.copyToClipboard('0x7a2f4b9e3c8d1a05f6029b7e4411d8c2a90fc019'); } }, copied ? 'Copied' : 'Copy address'),
        ho(window.Button, { variant: 'ghost', size: 'sm' }, ho(window.Icon, { name: 'external', size: 13 }), 'View on explorer')),
      ho('span', { className: 'mono-xs', style: { color: 'var(--fg-dim)' } }, 'Using a public RPC — add your own key in the Network section for reliable operation.')),
    ho('span', { className: 'mono-xs' }, 'The bootstrapper advances automatically once the balance target is met.'));
}

/* Phase 3 — Joining Jinn. Faithful to SubStateLine: pulse + sub-state +
   current-step grid (service, Safe). */
function JoinJinnPhase() {
  return ho('div', { className: 'col gap-4' },
    ho('span', { className: 'mono-sm', style: { maxWidth: '62ch' } }, 'Deploying your on-chain identity and staking position, then binding under ERC-8004. This runs to completion on its own.'),
    ho(SubStateLine, { label: 'Deploying', hint: 'running · no action needed', rows: [
      ['Current step', 'Service Activated'],
      ['Service', '#0 · id 142'],
      ['Safe', '0x33de4c1b…0f17', true],
    ] }));
}

const ALL_STEPS = {
  wallet: { k: 'wallet', label: 'Provisioning your wallet', shipped: true },
  fund: { k: 'fund', label: 'Fund your wallet', shipped: true },
  join: { k: 'join', label: 'Joining Jinn', shipped: true },
  net: { k: 'net', label: 'Pick your first SolverNet', shipped: false },
  harness: { k: 'harness', label: 'Set up harness + model', shipped: false },
  run: { k: 'run', label: 'Join a SolverNet & run', shipped: false },
};

function OnboardingTakeover({ flow = 'sequential', harnessApproach = 'column', onComplete }) {
  const combined = flow === 'combined';
  // Full flow: the three shipped bootstrap phases + the net-new selection
  // step(s), all visible and navigable so the flow can be reworked end-to-end.
  const steps = combined
    ? ['wallet', 'fund', 'join', 'run'].map((k) => ALL_STEPS[k])
    : ['wallet', 'fund', 'join', 'net', 'harness'].map((k) => ALL_STEPS[k]);

  const [idx, setIdx] = uSo(0);
  // Preselect swe-rebench-v2 — the only SolverNet we open up for now — so the
  // operator starts already joined (no leave option on this step).
  const SWE_CID = (window.registrySet().find((n) => n.name === 'swe-rebench-v2') || {}).cid;
  const [joined, setJoined] = uSo(SWE_CID ? { [SWE_CID]: ['solver', 'evaluator'] } : {});
  const [harness, setHarness] = uSo({ ready: false, harness: null, model: '', evaluatorOnly: false });
  // Wallet creation runs on the node before the operator can proceed; the
  // Continue button stays disabled ("Creating wallet…") until it completes.
  const [walletReady, setWalletReady] = uSo(false);
  uEo(() => {
    if (steps[idx].k !== 'wallet' || walletReady) return undefined;
    const id = setTimeout(() => setWalletReady(true), 2600);
    return () => clearTimeout(id);
  }, [idx, walletReady]);

  const onJoin = (net) => setJoined((p) => ({ ...p, [net.cid]: net.roles }));
  const onLeave = (cid) => setJoined((p) => { const n = { ...p }; delete n[cid]; return n; });
  const onHarnessReady = (ready, info) => setHarness({ ready, ...info });

  const joinedCount = Object.keys(joined).length;
  const harnessOk = harness.evaluatorOnly || (harness.ready && harness.model);
  const completion = joinedCount >= 1 && harnessOk;

  const step = steps[idx];
  const isLast = idx === steps.length - 1;

  // per-step gate
  let canAdvance = true;
  if (step.k === 'net') canAdvance = joinedCount >= 1;
  else if (step.k === 'harness') canAdvance = harnessOk;
  else if (step.k === 'run') canAdvance = joinedCount >= 1 && harnessOk;

  const stepContent = {
    wallet: ho(WalletPhase, {}),
    fund: ho(FundPhase, {}),
    join: ho(JoinJinnPhase, {}),
    net: ho(window.SolverNetStep, { scenario: 'default', joined, onJoin, onLeave, embedded: false }),
    harness: ho(window.HarnessSurface, { approach: harnessApproach, context: 'onboarding', onReady: onHarnessReady, embedded: false }),
    run: ho('div', { className: 'col gap-6' },
      ho(window.SolverNetStep, { scenario: 'default', joined, onJoin, onLeave, embedded: false }),
      ho('hr', { className: 'rule' }),
      ho(window.HarnessSurface, { approach: harnessApproach, context: 'onboarding', onReady: onHarnessReady, embedded: false })),
  }[step.k];

  const phaseStatus = (i) => i < idx ? 'done' : i === idx ? 'active' : 'queued';
  const totalN = steps.length;
  const stepNo = idx + 1;
  const progress = (idx / Math.max(1, totalN - 1)) * 100;
  // Helper text colocated with the Continue button (per-phase).
  const footerNote = step.k === 'wallet'
    ? 'Your node’s on-chain identities are being provisioned — the agent key signs, the Safe holds operations float, the master address is your refill pool. No action needed.'
    : null;

  return ho('div', { style: { minHeight: '100vh' } },
    // chrome
    ho('header', { className: 'row between center', style: { padding: '16px 32px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 10 } },
      ho('div', { className: 'row gap-3 center' },
        ho(JinnSigil, { size: 26 }),
        ho('span', { className: 'serif italic', style: { fontSize: 28, lineHeight: 1 } }, 'jinn'),
        ho('span', { className: 'eyebrow', style: { marginLeft: 8, paddingLeft: 14, borderLeft: '1px solid var(--border)' } }, 'Onboarding')),
      ho(window.Badge, { variant: 'outline' }, ho('span', { className: 'dot', style: { background: 'var(--accent-gold)' } }), 'Base Sepolia · testnet')),

    ho('div', { style: { maxWidth: 1200, margin: '0 auto', padding: '40px 32px 96px', display: 'grid', gridTemplateColumns: '320px 1fr', gap: 48, alignItems: 'start' } },
      // rail
      ho('aside', { className: 'col gap-5', style: { position: 'sticky', top: 96 } },
        ho('div', { className: 'col gap-3' },
          ho('h1', { className: 'serif', style: { fontSize: 48, margin: 0, lineHeight: 1.12 } }, 'Join the Network')),
        ho('div', { className: 'col gap-2' },
          ho('div', { className: 'progress' }, ho('span', { style: { width: (completion ? 100 : progress) + '%' } })),
          ho(window.Eyebrow, { tone: 'dim' }, 'Phase ' + stepNo + ' of ' + totalN)),
        ho('ol', { className: 'card', style: { margin: 0, padding: 0, overflow: 'hidden' } },
          steps.map((s, i) => ho(PhaseRow, { key: s.k, index: i + 1, label: s.label, status: phaseStatus(i) })))),

      // content
      ho('section', { className: 'col gap-6', style: { minWidth: 0 } },
        ho('div', { className: 'section-head' },
          ho('div', { className: 'col gap-1' },
            ho(window.Eyebrow, { tone: 'gold' }, 'Phase ' + stepNo.toString().padStart(2, '0')),
            ho('h2', { className: 'serif', style: { fontSize: 34, margin: 0 } }, step.label)),
        ),
        stepContent,
        ho('div', { className: 'row between', style: { paddingTop: 8, borderTop: '1px solid var(--border)', alignItems: 'flex-start' } },
          ho(window.Button, { variant: 'secondary', disabled: idx === 0, onClick: () => setIdx((i) => Math.max(0, i - 1)) },
            ho(window.Icon, { name: 'arrow-left', size: 14 }), 'Back'),
          ho('div', { className: 'col gap-2', style: { alignItems: 'flex-end', maxWidth: '52ch' } },
            footerNote && ho('span', { className: 'mono-xs', style: { textAlign: 'right', lineHeight: 1.55 } }, footerNote),
            isLast
              ? ho(window.Button, { variant: 'gold', disabled: !completion, onClick: () => onComplete && onComplete({ joined, harness }), title: completion ? '' : 'Satisfy the completion gate to continue' },
                  'Enter dashboard', ho(window.Icon, { name: 'arrow-right', size: 14 }))
              : step.k === 'wallet'
                ? ho(window.Button, { variant: 'default', disabled: !walletReady, onClick: () => setIdx((i) => i + 1) },
                    walletReady
                      ? ho(window.Fragment, null, 'Continue', ho(window.Icon, { name: 'arrow-right', size: 14 }))
                      : ho(window.Fragment, null, ho(window.Icon, { name: 'spinner', size: 14, className: 'spin' }), 'Creating wallet\u2026'))
                : ho(window.Button, { variant: 'default', disabled: !canAdvance, onClick: () => setIdx((i) => i + 1) },
                    'Continue', ho(window.Icon, { name: 'arrow-right', size: 14 })),
            !isLast && step.k !== 'wallet' && !canAdvance && ho('span', { className: 'mono-xs', style: { textAlign: 'right' } }, step.k === 'net' ? 'Join at least one SolverNet to continue.' : 'Get your harness ready (or choose evaluator-only) to continue.'),
            isLast && !completion && ho('span', { className: 'mono-xs', style: { textAlign: 'right', color: 'var(--wane)' } }, 'The dashboard stays locked until the node is eligible to claim tasks.'))),
      ),
    ));
}

window.OnboardingTakeover = OnboardingTakeover;
window.JinnSigil = JinnSigil;
