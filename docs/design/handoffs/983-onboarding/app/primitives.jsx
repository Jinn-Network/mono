/* Shared primitives + fixtures for the Jinn onboarding-completeness design.
   Plain React (no JSX-scope sharing assumptions): everything is exported to
   window at the end so harness.jsx / solvernet.jsx / onboarding.jsx etc. can
   consume them across <script> boundaries. */

const { useState, useEffect, useRef, createElement: h, Fragment } = React;

/* ── icons — Lucide-style, 1.5px stroke, currentColor ──────────────────── */
function Icon({ name, size = 16, className = '' }) {
  const paths = {
    check: 'M20 6 9 17l-5-5',
    x: 'M18 6 6 18M6 6l12 12',
    'arrow-right': 'M5 12h14M12 5l7 7-7 7',
    'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
    'shield-check': 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zM9 12l2 2 4-4',
    cpu: 'M12 20v2M12 2v2M17 20v2M17 2v2M2 12h2M2 17h2M2 7h2M20 12h2M20 17h2M20 7h2M7 20v2M7 2v2M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 10h8v4H8z',
    box: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7l8.7 5 8.7-5M12 22V12',
    alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
    info: 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
    lock: 'M5 11h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4',
    wallet: 'M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-3a2 2 0 0 1 0-4h4M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4',
    coins: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM18.1 7.8A6 6 0 1 1 9.9 16.3M7 6h1v4M16.7 13.9l.7.7-2.8 2.8',
    network: 'M12 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 9v4M6.6 17.4 10 13M17.4 17.4 14 13',
    settings: 'M12.2 2h-.4a2 2 0 0 0-2 2 1.7 1.7 0 0 1-1 1.5 1.7 1.7 0 0 1-1.8-.3 2 2 0 0 0-2.8 0l-.3.3a2 2 0 0 0 0 2.8 1.7 1.7 0 0 1 .3 1.8 1.7 1.7 0 0 1-1.5 1 2 2 0 0 0-2 2v.4a2 2 0 0 0 2 2 1.7 1.7 0 0 1 1.5 1 1.7 1.7 0 0 1-.3 1.8 2 2 0 0 0 0 2.8l.3.3a2 2 0 0 0 2.8 0 1.7 1.7 0 0 1 1.8-.3 1.7 1.7 0 0 1 1 1.5 2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2 1.7 1.7 0 0 1 1-1.5 1.7 1.7 0 0 1 1.8.3 2 2 0 0 0 2.8 0l.3-.3a2 2 0 0 0 0-2.8 1.7 1.7 0 0 1-.3-1.8 1.7 1.7 0 0 1 1.5-1 2 2 0 0 0 2-2v-.4a2 2 0 0 0-2-2 1.7 1.7 0 0 1-1.5-1 1.7 1.7 0 0 1 .3-1.8 2 2 0 0 0 0-2.8l-.3-.3a2 2 0 0 0-2.8 0 1.7 1.7 0 0 1-1.8.3 1.7 1.7 0 0 1-1-1.5 2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    copy: 'M20 8h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zM4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2',
    external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    chevron: 'm6 9 6 6 6-6',
    plug: 'M12 22v-5M9 8V2M15 8V2M18 8v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z',
    spinner: 'M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8',
  };
  const d = paths[name] || '';
  return h('svg', {
    className, width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { flexShrink: 0 },
  }, d.split('M').filter(Boolean).map((seg, i) => h('path', { key: i, d: 'M' + seg })));
}

function Eyebrow({ tone = 'muted', children, style }) {
  return h('span', { className: 'eyebrow ' + (tone === 'fg' ? 'fg' : tone === 'gold' ? 'gold' : tone === 'dim' ? 'dim' : ''), style }, children);
}

function Button({ variant = 'default', size, block, disabled, onClick, children, style, title }) {
  const cls = ['btn', 'btn-' + variant];
  if (size) cls.push('btn-' + size);
  if (block) cls.push('block');
  if (disabled) cls.push('disabled');
  return h('button', { className: cls.join(' '), onClick: disabled ? undefined : onClick, disabled, style, title, type: 'button' }, children);
}

function Badge({ variant = 'default', children, style, title }) {
  return h('span', { className: 'badge badge-' + variant, style, title }, children);
}

function Card({ tone, hoverable, pad = 'card-pad', className = '', children, style, onClick, ...rest }) {
  const cls = ['card'];
  if (tone) cls.push(tone);
  if (hoverable) cls.push('hoverable');
  if (pad) cls.push(pad);
  if (className) cls.push(className);
  return h('div', { className: cls.join(' '), style, onClick, ...rest }, children);
}

function Alert({ variant = 'info', icon = true, title, children, action, style }) {
  const iconName = { blocking: 'alert', warning: 'alert', info: 'info', success: 'shield-check' }[variant];
  return h('div', { className: 'alert alert-' + variant, style, role: 'status' },
    icon && h(Icon, { name: iconName, size: 16, className: 'alert-ico', }),
    h('div', { className: 'alert-body' },
      title && h('span', { className: 'alert-title' }, title),
      children && h('span', { className: 'alert-desc' }, children),
    ),
    action,
  );
}

/* Three-tier availability glyph — protocol / build / installed-authed.
   Renders three small squares; filled = tier satisfied, dashed = blocked
   at that tier, green = ready (final tier passing). */
function TierDots({ protocolAvailable, nodeSupported, ready, size = 7 }) {
  const t1 = protocolAvailable ? 'on' : 'blocked';
  const t2 = !protocolAvailable ? 'blocked' : (nodeSupported ? 'on' : 'blocked');
  const t3 = (!protocolAvailable || !nodeSupported) ? 'blocked' : (ready ? 'ready' : '');
  return h('span', { className: 'tierdots', title: 'protocol · build · installed-authed' },
    h('i', { className: t1, style: { width: size, height: size } }),
    h('i', { className: t2, style: { width: size, height: size } }),
    h('i', { className: t3, style: { width: size, height: size } }),
  );
}

/* ── domain fixtures ────────────────────────────────────────────────────
   A SolverNet's harness availability set. Each harness carries the spec's
   §2.9 per-harness fields. `status` is the resolved tier-3 condition that
   drives state copy. */

// Resolved availability + readiness states for one harness row.
const HARNESS_STATES = {
  ready: { installed: true, authenticated: true, ready: true, message: null },
  not_installed: { installed: false, authenticated: false, ready: false, message: 'Harness not installed' },
  auth_expired: { installed: true, authenticated: false, ready: false, message: 'Auth expired' },
  version_mismatch: { installed: true, authenticated: true, ready: false, message: 'Version mismatch' },
  ready_no_auth: { installed: true, authenticated: true, ready: true, message: null }, // pure-compute
};

function mkHarness(over) {
  return Object.assign({
    name: '', desc: '', role: 'solver',
    protocolAvailable: true, nodeSupported: true,
    installed: false, authenticated: false, ready: false,
    pureCompute: false, message: null, reason: '', next: null,
    models: [], defaultModel: '',
  }, over);
}

// The harness set for the SolverNet in context (swe-rebench-v2). This is the
// canonical happy-path fixture; gallery states override individual rows.
function harnessSet() {
  // One unified harness list — the selected harness + model is used for BOTH
  // solving and evaluating. No solver/evaluator split. Codex is the default.
  return [
    mkHarness({
      name: 'Codex', desc: 'OpenAI coding agent CLI.',
      role: 'solver', protocolAvailable: true, nodeSupported: true,
      installed: true, authenticated: true, ready: true,
      models: ['ChatGPT 4.5 mini', 'GPT-5.2 Codex', 'GPT-5.2'], defaultModel: 'ChatGPT 4.5 mini',
    }),
    mkHarness({
      name: 'Claude Code', desc: 'Anthropic CLI. Signed in via subscription or API key.',
      role: 'solver', protocolAvailable: true, nodeSupported: true,
      installed: true, authenticated: true, ready: true,
      models: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'Claude Haiku 4.4'],
      defaultModel: 'Claude Sonnet 4.6',
    }),
    mkHarness({
      name: 'Hermes Agent', desc: 'Self-improving agent by Nous Research. Built-in learning loop.',
      role: 'solver', protocolAvailable: true, nodeSupported: true,
      installed: false, authenticated: false, ready: false, message: 'Harness not installed',
      reason: 'Hermes Agent binary not found on this machine.',
      next: { description: 'Install Hermes Agent, then re-check', cli: 'curl -fsSL https://hermes.nousresearch.com/install.sh | bash' },
      models: ['Hermes-4-405B', 'Hermes-4-70B'], defaultModel: 'Hermes-4-405B',
    }),
    mkHarness({
      name: 'Aider', desc: 'Pair-programming CLI.',
      role: 'solver', protocolAvailable: true, nodeSupported: false,
      installed: false, authenticated: false, ready: false,
      message: 'Not supported by this node build',
      reason: 'Protocol-available for this SolverNet, but not compiled into your installed node binary (v0.4.2).',
      models: [], defaultModel: '',
    }),
  ];
}

// SolverNet registry fixtures for the discovery step.
function registrySet() {
  return [
    { cid: 'bafy…swe2', name: 'swe-rebench-v2', desc: 'Resolve real GitHub issues against a held-out test suite.',
      launcher: '0x4b…91ac', agentId: 142, roles: ['solver', 'evaluator'], solution: '0.0120 ETH', verdict: '0.0030 ETH', status: 'launched', posts24h: 1284 },
    { cid: 'bafy…pred1', name: 'prediction-v1', desc: 'Forecast resolution of curated real-world questions.',
      launcher: '0x9c…2d10', agentId: 88, roles: ['solver', 'evaluator'], solution: '0.0040 ETH', verdict: '0.0010 ETH', status: 'launched', posts24h: 612 },
    { cid: 'bafy…webnav', name: 'web-navigation-v1', desc: 'Complete multi-step web tasks end to end.',
      launcher: '0x21…7f4e', agentId: 203, roles: ['solver'], solution: '0.0080 ETH', verdict: '—', status: 'launched', posts24h: 95 },
    { cid: 'bafy…math', name: 'olympiad-proofs', desc: 'Produce verifiable proofs for competition problems.',
      launcher: '0x77…b0c2', agentId: 311, roles: ['evaluator'], solution: '0.0200 ETH', verdict: '0.0050 ETH', status: 'paused', posts24h: 0 },
  ];
}

function copyToClipboard(text) {
  try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (e) {}
}

Object.assign(window, {
  h, Fragment, useState, useEffect, useRef,
  Icon, Eyebrow, Button, Badge, Card, Alert, TierDots,
  HARNESS_STATES, mkHarness, harnessSet, registrySet, copyToClipboard,
});
