import { Link } from 'wouter';
import type { OperatorNotification } from '../taxonomy.js';

/**
 * Renders one notice row inside `<NotificationsList>`. Severity drives both
 * the row's left-border tint and the severity-word color via the
 * `j-notification--{severity}` CSS class (defined in `globals.css`). The
 * row reads severity at a glance: blocking is red, warning is gold, info
 * is sky. Closes #444.
 */
export function NotificationItem({ notice }: { notice: OperatorNotification }): JSX.Element {
  return (
    <li
      data-kind={notice.kind}
      data-severity={notice.severity}
      aria-label={`${notice.severity} notice: ${notice.message}`}
      className={`j-notification j-notification--${notice.severity}`}
    >
      <span aria-hidden="true" className="j-notification__severity">
        {notice.severity}
      </span>
      <span className="j-notification__message">{notice.message}</span>
      {notice.jumpTo ? (
        <Link href={notice.jumpTo} className="j-notification__jump">
          resolve →
        </Link>
      ) : null}
    </li>
  );
}
