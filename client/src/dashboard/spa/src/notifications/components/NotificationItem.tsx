import { Link } from 'wouter';
import type { OperatorNotification } from '../taxonomy.js';

export function NotificationItem({ notice }: { notice: OperatorNotification }): JSX.Element {
  return (
    <li
      data-kind={notice.kind}
      data-severity={notice.severity}
      aria-label={`${notice.severity} notice: ${notice.message}`}
      style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}
    >
      <span aria-hidden="true" style={{ textTransform: 'uppercase', fontSize: '11px' }}>
        {notice.severity}
      </span>
      <span style={{ flex: 1 }}>{notice.message}</span>
      {notice.jumpTo ? <Link href={notice.jumpTo}>resolve →</Link> : null}
    </li>
  );
}
