import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { api } from '../api/client.js';
import { getFeatures } from '../lib/features.js';
import { cn } from '../lib/utils.js';

import type { JSX } from 'react';

// The Build tab is gated behind the `pluginBuilderUi` feature flag (issue
// #327) — appended to the base tabs only when the daemon was started with
// JINN_ENABLE_PLUGIN_BUILDER_UI=1.
const BASE_TABS = [
  { path: '/overview', label: 'Dashboard' },
  { path: '/events', label: 'Events' },
  { path: '/operator', label: 'Settings' },
] as const;

export function TopTabs(): JSX.Element {
  const [location] = useLocation();
  const locationPath = location.split(/[?#]/)[0] || '/';
  const onLauncherRoute = locationPath === '/launcher' || locationPath.startsWith('/launcher/');
  const { data: launched } = useQuery({
    queryKey: ['solvernets', 'launched', 'top-tabs'],
    queryFn: () => api.solvernets.listLaunched(),
    refetchInterval: 30_000,
    enabled: !onLauncherRoute,
  });
  const baseTabs = getFeatures().pluginBuilderUi
    ? [...BASE_TABS, { path: '/build', label: 'Build' } as const]
    : BASE_TABS;
  const showLauncher = onLauncherRoute || (launched?.records.length ?? 0) > 0;
  const tabs = showLauncher
    ? [...baseTabs, { path: '/launcher', label: 'Launcher' } as const]
    : baseTabs;

  return (
    <nav className="-mb-px flex px-6">
      {tabs.map((tab) => {
        const active = locationPath === tab.path || locationPath.startsWith(`${tab.path}/`);
        return (
          <Link
            key={tab.path}
            href={tab.path}
            data-active={active ? 'true' : 'false'}
            className={cn(
              'border-b px-4 py-3.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] no-underline transition-colors',
              active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
