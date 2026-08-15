import type { StructuredEvent } from '../../../../api/contract/index.js';

import type { JSX } from 'react';

export interface EventStreamListProps {
  events: StructuredEvent[];
  /** Optional: render only events whose kind matches this value */
  filterKind?: string;
}

export function EventStreamList({ events, filterKind }: EventStreamListProps): JSX.Element {
  const filtered = filterKind ? events.filter((e) => e.kind === filterKind) : events;
  const sorted = [...filtered].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  if (sorted.length === 0) {
    return <p className="m-0 font-mono text-[12px] text-muted-foreground">No events.</p>;
  }

  return (
    <ul className="m-0 list-none p-0">
      {sorted.map((e) => (
        <li
          key={e.id}
          data-kind={e.kind}
          className="flex items-baseline gap-3 py-1.5"
        >
          <time
            dateTime={e.ts}
            className="min-w-[180px] font-mono text-[11px] text-[var(--fg-dim)]"
          >
            {e.ts}
          </time>
          <code className="min-w-[80px] font-mono text-[11px] uppercase">{e.kind}</code>
          <span className="flex-1 font-mono text-[12px]">{e.message}</span>
        </li>
      ))}
    </ul>
  );
}
