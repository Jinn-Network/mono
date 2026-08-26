'use client';

import Link from 'next/link';
import { NOTIFICATION_KINDS } from '@jinn-network/lifecycle-notifications';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { consoleJumpHref } from '@/lib/notification-jump';
import { classifySurface, SurfaceStatus, useDaemonJson } from '@/lib/use-daemon';

const KNOWN_KINDS = new Set<string>(NOTIFICATION_KINDS);

type Notification = {
  kind: string;
  severity: string;
  title: string;
  message: string;
  jumpTo?: string;
};

type NotificationsPayload = {
  notifications?: Notification[];
};

export default function NotificationsPage() {
  const { data, loading, error } = useDaemonJson<NotificationsPayload>(
    '/v1/notifications',
    5000,
  );
  const items = data?.notifications ?? [];
  const state = classifySurface({
    loading,
    error,
    empty: items.length === 0,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state !== 'ready' ? (
          <SurfaceStatus name="notifications" state={state} />
        ) : (
          items.map((item, index) => {
            const href = consoleJumpHref(item.jumpTo);
            const body = (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <Badge
                    variant={
                      item.severity === 'blocking'
                        ? 'destructive'
                        : item.severity === 'warning'
                          ? 'warning'
                          : 'outline'
                    }
                  >
                    {item.severity}
                  </Badge>
                  <span className="font-mono text-[13px]">{item.title}</span>
                  {KNOWN_KINDS.has(item.kind) ? null : (
                    <span className="font-mono text-[12px] text-muted-foreground">{item.kind}</span>
                  )}
                </div>
                <p className="m-0 font-mono text-[12px] text-muted-foreground">{item.message}</p>
              </>
            );
            const className = 'rounded-[var(--radius-2)] border border-border p-3 no-underline text-inherit';
            return href ? (
              <Link
                key={`${item.kind}-${index}`}
                href={href}
                data-testid="notification-item"
                data-jump={href}
                className={`${className} hover:border-foreground/40`}
              >
                {body}
              </Link>
            ) : (
              <div
                key={`${item.kind}-${index}`}
                data-testid="notification-item"
                className={className}
              >
                {body}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
