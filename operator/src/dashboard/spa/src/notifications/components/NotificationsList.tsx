import type { OperatorNotification } from '../taxonomy.js';
import { NotificationItem } from './NotificationItem.js';

import type { JSX } from 'react';

export function NotificationsList({
  notices,
}: {
  notices: OperatorNotification[];
}): JSX.Element | null {
  if (notices.length === 0) return null;
  return (
    <section aria-label="Notifications" role="region">
      <ul className="m-0 list-none p-0">
        {notices.map((n, i) => (
          <NotificationItem notice={n} key={`${n.kind}-${i}`} />
        ))}
      </ul>
    </section>
  );
}
