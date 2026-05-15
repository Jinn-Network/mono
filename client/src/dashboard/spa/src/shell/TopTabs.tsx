import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { api } from '../api/client.js';

const TABS = [
  { path: '/overview', label: 'Dashboard' },
  { path: '/operator', label: 'Settings' },
  { path: '/build', label: 'Build' },
] as const;

export function TopTabs(): JSX.Element {
  const [location] = useLocation();
  const onLauncherRoute = location === '/launcher' || location.startsWith('/launcher/');
  const { data: launched } = useQuery({
    queryKey: ['solvernets', 'launched', 'top-tabs'],
    queryFn: () => api.solvernets.listLaunched(),
    refetchInterval: 30_000,
    enabled: !onLauncherRoute,
  });
  const showLauncher = onLauncherRoute || (launched?.records.length ?? 0) > 0;
  const tabs = showLauncher ? [...TABS, { path: '/launcher', label: 'Launcher' } as const] : TABS;

  return (
    <nav
      style={{
        display: 'flex',
        padding: '0 24px',
      }}
    >
      {tabs.map((tab) => {
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
