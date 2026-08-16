import { Link } from 'wouter';
import type { OperatorNotification } from '../taxonomy.js';
import { cn } from '../../lib/utils.js';

import type { JSX } from 'react';

/**
 * One notice row inside `<NotificationsList>`. Severity drives the
 * left-border tint and the severity-word color. The row reads severity
 * at a glance: blocking is red, warning is gold, info is sky.
 *
 * The row is rendered as a styled `<li>` (the list owns the semantics)
 * with shadcn-aligned tokens — keeps a11y (aria-label per #444) intact
 * while sharing tokens with `<Alert>`.
 */
const severityClass: Record<OperatorNotification['severity'], string> = {
  blocking: 'border-l-[var(--severity-blocking-fg)] bg-[var(--severity-blocking-bg)]',
  warning: 'border-l-[var(--severity-warning-fg)] bg-[var(--severity-warning-bg)]',
  info: 'border-l-[var(--severity-info-fg)]',
};

const severityTextClass: Record<OperatorNotification['severity'], string> = {
  blocking: 'text-[var(--severity-blocking-fg)]',
  warning: 'text-[var(--severity-warning-fg)]',
  info: 'text-[var(--severity-info-fg)]',
};

export function NotificationItem({ notice }: { notice: OperatorNotification }): JSX.Element {
  return (
    <li
      data-kind={notice.kind}
      data-severity={notice.severity}
      aria-label={`${notice.severity} notice: ${notice.message}`}
      className={cn(
        'flex items-baseline gap-3 border-l-2 px-4 py-2 font-mono text-[12px] text-foreground',
        severityClass[notice.severity],
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'min-w-[64px] font-mono text-[11px] font-medium uppercase tracking-[0.14em]',
          severityTextClass[notice.severity],
        )}
      >
        {notice.severity}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>{notice.title}</span>
        <span className="text-[11px] text-muted-foreground">{notice.message}</span>
      </span>
      {notice.jumpTo ? (
        <Link
          href={notice.jumpTo}
          className="font-mono text-[var(--accent-sky)] no-underline hover:text-[var(--accent-sky-hover)]"
        >
          resolve →
        </Link>
      ) : null}
    </li>
  );
}
