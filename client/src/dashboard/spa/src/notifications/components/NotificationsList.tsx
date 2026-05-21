import type { OperatorNotification } from '../taxonomy.js';
import { NotificationItem } from './NotificationItem.js';

export function NotificationsList({ notices }: { notices: OperatorNotification[] }): JSX.Element | null {
  if (notices.length === 0) return null;
  return (
    <section aria-label="Notifications" role="region">
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {notices.map((n, i) => (
          <NotificationItem notice={n} key={`${n.kind}-${i}`} />
        ))}
      </ul>
    </section>
  );
}
