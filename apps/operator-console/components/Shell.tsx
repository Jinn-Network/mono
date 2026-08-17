'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/events', label: 'Events' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/operator/claim-policy', label: 'Claim policy' },
  { href: '/operator/network', label: 'Network' },
  { href: '/operator/security', label: 'Security' },
  { href: '/operator/posting', label: 'Posting' },
] as const;

export function Shell({
  children,
  warn,
}: {
  children: React.ReactNode;
  warn?: string;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="flex w-52 flex-col gap-1 border-r border-border bg-sunken p-4">
        <p className="mb-4 font-[family-name:var(--font-display)] text-[26px] text-foreground">
          Operator
        </p>
        <nav className="flex flex-col gap-1" aria-label="Console">
          {NAV.map((item) => {
            const current =
              item.href === '/'
                ? pathname === '/'
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'rounded-[var(--radius-2)] px-2 py-1.5 font-mono text-[13px] no-underline',
                  current
                    ? 'bg-elevated text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {warn ? (
          <div
            data-testid="contract-minor-warn"
            role="status"
            className="border-b border-wane/40 bg-wane/10 px-6 py-2 font-mono text-[12px] text-wane"
          >
            {warn}
          </div>
        ) : null}
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
