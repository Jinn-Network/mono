import { Link, useLocation, useRoute } from 'wouter';
import { Menu } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Button } from '../../components/ui/button.js';

import type { JSX } from 'react';

const TABS = [
  { to: '/operator/claim-policy', label: 'Claim policy & wiring' },
  { to: '/operator/memberships', label: 'Memberships' },
  { to: '/operator/registry', label: 'Registry' },
  { to: '/operator/execution-data', label: 'Execution data' },
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
        className={cn(
          'block rounded-sm px-3 py-2 font-mono text-[12px] tracking-[0.08em] no-underline transition-colors',
          active
            ? 'bg-[var(--bg-elevated)] font-medium text-foreground'
            : 'bg-transparent font-normal text-[var(--fg-muted)] hover:text-foreground',
        )}
      >
        {label}
      </Link>
    </li>
  );
}

/**
 * Vertical sub-navigation for /operator/* sub-routes.
 *
 * Renders the desktop vertical list as before, plus a compact narrow-viewport
 * trigger (`<DropdownMenu>`) that surfaces the same routes from a single
 * button — useful below the `sm` breakpoint where the rail collapses.
 */
export function OperatorSubNav(): JSX.Element {
  const [, navigate] = useLocation();
  return (
    <nav
      aria-label="Operator sections"
      data-testid="operator-sub-nav"
      className="flex min-w-[160px] flex-col pt-1"
    >
      {/* Compact menu — only shows below `sm`, gives the operator a way to
          jump between sections without the vertical rail taking screen real
          estate on narrow viewports. */}
      <div className="mb-2 sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" data-testid="operator-sub-nav-trigger">
              <Menu className="h-3.5 w-3.5" /> Sections
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {TABS.map((t) => (
              <DropdownMenuItem key={t.to} onSelect={() => navigate(t.to)}>
                {t.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {TABS.map((t) => (
          <NavItem key={t.to} to={t.to} label={t.label} />
        ))}
      </ul>
    </nav>
  );
}
