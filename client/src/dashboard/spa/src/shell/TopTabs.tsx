import { Link, useLocation } from 'wouter';

const TABS = [
  { path: '/overview', label: 'Overview' },
  { path: '/configuration', label: 'Configuration' },
] as const;

export function TopTabs(): JSX.Element {
  const [location] = useLocation();
  return (
    <nav
      style={{
        display: 'flex',
        padding: '0 24px',
      }}
    >
      {TABS.map((tab) => {
        const active = location === tab.path || location.startsWith(`${tab.path}/`);
        return (
          <Link
            key={tab.path}
            href={tab.path}
            data-active={active ? 'true' : 'false'}
            style={{
              padding: '14px 18px',
              fontFamily: "'JetBrains Mono', ui-monospace, SF Mono, Menlo, monospace",
              fontSize: '11px',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              borderBottom: `1px solid ${active ? 'var(--accent-sky)' : 'transparent'}`,
              marginBottom: '-1px',
              textDecoration: 'none',
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
