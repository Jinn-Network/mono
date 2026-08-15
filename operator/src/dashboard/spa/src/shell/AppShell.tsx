import type { ReactNode, JSX } from 'react';
import { NotificationsList } from '../notifications/components/NotificationsList.js';
import { useNotifications } from '../notifications/useNotifications.js';
import { cn } from '../lib/utils.js';

/**
 * Three-region shell for the running-mode operator dashboard. Header + tabs
 * span both columns; the main outlet flows in the left column; the agent
 * rail is sticky on the right when present (gated via `showRail = rail != null`).
 * Onboarding still owns the screen before bootstrap completes.
 */
export interface AppShellProps {
  header: ReactNode;
  tabs: ReactNode;
  /**
   * Right-rail content (the embedded agent panel). Optional — when omitted
   * the shell collapses to a single column and renders no aside.
   */
  rail?: ReactNode;
  children: ReactNode;
}

export function AppShell({ header, tabs, rail, children }: AppShellProps): JSX.Element {
  const showRail = rail != null;
  const notices = useNotifications();
  const rows = notices.length > 0 ? 'grid-rows-[auto_auto_auto_minmax(0,1fr)]' : 'grid-rows-[auto_auto_minmax(0,1fr)]';
  return (
    <div
      className={cn(
        'grid h-screen w-full overflow-hidden bg-background text-foreground',
        showRail ? 'grid-cols-[1fr_320px]' : 'grid-cols-1',
        rows,
      )}
    >
      <div className="col-span-full border-b border-border">{header}</div>
      <div className="col-span-full border-b border-border">{tabs}</div>
      {notices.length > 0 && (
        <div className="col-span-full border-b border-border">
          <NotificationsList notices={notices} />
        </div>
      )}
      <main className="min-h-0 overflow-y-auto">{children}</main>
      {showRail && (
        <aside className="h-full min-h-0 overflow-y-auto border-l border-border">{rail}</aside>
      )}
    </div>
  );
}
