/**
 * Chrome — the persistent shell header.
 *
 * Contains: Logo, TopNav, SearchBox.
 * Visual reference: docs/design/jinn-design-system/project/ui_kits/explorer/Chrome.jsx
 *
 * Design rules applied:
 *   - Sticky header, bg-sunken, 1px hairline border-bottom
 *   - Logo: Instrument Serif italic "jinn" + hairline separator + caps-mono "explorer" label
 *   - Nav: caps-mono 12px, letter-spacing 0.08em, active = --fg + 1px sky underline offset 4px
 *   - SearchBox: visual-only; wired search is deferred (TODO ebu7.<later>)
 *   - No emoji, no gradients
 */

import { Link, useLocation } from 'wouter';

// ── Logo ──────────────────────────────────────────────────────────────────────

export function Logo() {
  return (
    <Link
      href="/"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        textDecoration: 'none',
        color: 'var(--fg)',
      }}
    >
      <img
        src="/logo-sigil.svg"
        alt=""
        aria-hidden="true"
        style={{
          width: 22,
          height: 22,
          filter: 'brightness(0) invert(1) opacity(0.95)',
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontStyle: 'italic',
          fontSize: 26,
          lineHeight: 1,
          letterSpacing: 0,
          color: 'var(--fg)',
        }}
      >
        jinn
      </span>
      <span
        className="label"
        style={{
          marginLeft: 8,
          borderLeft: '1px solid var(--border)',
          paddingLeft: 10,
          color: 'var(--fg-muted)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontSize: 11,
        }}
      >
        explorer
      </span>
    </Link>
  );
}

// ── TopNav ────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { to: '/', label: 'Network' },
  { to: '/solvernets', label: 'SolverNets' },
  { to: '/operators', label: 'Operators' },
] as const;

function NavItem({ to, label }: { to: string; label: string }) {
  const [location] = useLocation();

  // Active: exact match for "/", prefix match for deeper paths
  const isActive =
    to === '/'
      ? location === '/'
      : location === to || location.startsWith(to + '/');

  return (
    <Link
      href={to}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '6px 12px',
        textDecoration: 'none',
        color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
        borderBottom: isActive
          ? '1px solid var(--accent)'
          : '1px solid transparent',
        paddingBottom: isActive ? 5 : 6,
        transition: 'color var(--dur-fast) var(--ease-linear)',
        display: 'inline-block',
      }}
      aria-current={isActive ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

// ── SearchBox ─────────────────────────────────────────────────────────────────

function SearchBox() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: '1px solid var(--border)',
        padding: '6px 10px',
        width: 260,
        background: 'var(--bg-sunken)',
        borderRadius: 'var(--radius-2)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          color: 'var(--fg-dim)',
          fontSize: 13,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ⌕
      </span>
      {/* TODO(ebu7.<later>): wire ⌘K command palette */}
      <input
        placeholder="Search SolverNet, operator, block… (⌘K)"
        disabled
        style={{
          background: 'transparent',
          border: 0,
          color: 'var(--fg-muted)',
          width: '100%',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          outline: 'none',
          cursor: 'not-allowed',
          letterSpacing: 'var(--tracking-mono)',
        }}
      />
      <span
        className="label"
        style={{
          fontSize: 9,
          border: '1px solid var(--border)',
          padding: '1px 5px',
          color: 'var(--fg-muted)',
          flexShrink: 0,
          borderRadius: 'var(--radius-1)',
          letterSpacing: '0.08em',
        }}
      >
        ⌘K
      </span>
    </div>
  );
}

// ── Chrome ────────────────────────────────────────────────────────────────────

export function Chrome() {
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 'var(--z-sticky)' as unknown as number,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 28px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
        <Logo />
        <nav
          aria-label="Primary navigation"
          style={{ display: 'flex', gap: 4, alignItems: 'center' }}
        >
          {NAV_ITEMS.map((item) => (
            <NavItem key={item.to} to={item.to} label={item.label} />
          ))}
        </nav>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <SearchBox />
      </div>
    </header>
  );
}
