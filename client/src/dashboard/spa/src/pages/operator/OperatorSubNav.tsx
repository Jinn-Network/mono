import { Link, useRoute } from 'wouter';

const TABS = [
  { to: '/operator/memberships', label: 'Memberships' },
  { to: '/operator/registry', label: 'Registry' },
  { to: '/operator/network', label: 'Network' },
  { to: '/operator/security', label: 'Security' },
] as const;

function NavItem({ to, label }: { to: string; label: string }): JSX.Element {
  const [active] = useRoute(to);
  return (
    <li>
      <Link
        href={to}
        aria-current={active ? 'page' : undefined}
        style={{
          display: 'block',
          padding: '8px 12px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          letterSpacing: '0.08em',
          textDecoration: 'none',
          borderRadius: 'var(--radius-1, 4px)',
          color: active ? 'var(--fg)' : 'var(--fg-muted)',
          background: active ? 'var(--bg-elevated)' : 'transparent',
          fontWeight: active ? 500 : 400,
          transition: 'color 100ms, background 100ms',
        }}
      >
        {label}
      </Link>
    </li>
  );
}

/**
 * Vertical sub-navigation for /operator/* sub-routes.
 * Uses wouter's useRoute to detect the active tab since wouter's Link
 * does NOT auto-set aria-current like react-router-dom's NavLink.
 */
export function OperatorSubNav(): JSX.Element {
  return (
    <nav
      aria-label="Operator sections"
      data-testid="operator-sub-nav"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: '160px',
        paddingTop: '4px',
      }}
    >
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        }}
      >
        {TABS.map((t) => (
          <NavItem key={t.to} to={t.to} label={t.label} />
        ))}
      </ul>
    </nav>
  );
}
