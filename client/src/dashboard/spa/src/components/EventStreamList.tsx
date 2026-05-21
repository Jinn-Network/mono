import type { StructuredEvent } from '../api/types.js';

export interface EventStreamListProps {
  events: StructuredEvent[];
  /** Optional: render only events whose kind matches this value */
  filterKind?: string;
}

export function EventStreamList({ events, filterKind }: EventStreamListProps): JSX.Element {
  const filtered = filterKind ? events.filter(e => e.kind === filterKind) : events;
  // Sort descending — most recent first. Stable for equal timestamps.
  const sorted = [...filtered].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  if (sorted.length === 0) {
    return <p>No events.</p>;
  }

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {sorted.map(e => (
        <li
          key={e.id}
          data-kind={e.kind}
          style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '6px 0' }}
        >
          <time
            dateTime={e.ts}
            style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: 'var(--fg-dim)', minWidth: 180 }}
          >
            {e.ts}
          </time>
          <code
            style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', textTransform: 'uppercase', minWidth: 80 }}
          >
            {e.kind}
          </code>
          <span style={{ flex: 1 }}>{e.message}</span>
        </li>
      ))}
    </ul>
  );
}
