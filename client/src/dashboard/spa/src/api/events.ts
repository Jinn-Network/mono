import { useEffect, useState } from 'react';
import type { StructuredEvent } from '../../../../api/contract/index.js';

export function useEventStream(filterKinds?: string[]): {
  events: StructuredEvent[];
  connected: boolean;
} {
  const [events, setEvents] = useState<StructuredEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const q = filterKinds && filterKinds.length > 0
      ? `?kinds=${filterKinds.join(',')}`
      : '';
    const es = new EventSource(`/v1/events${q}`, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as StructuredEvent;
        setEvents((prev) => [...prev.slice(-499), parsed]);
      } catch {
        // ignore parse error
      }
    };
    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKinds?.join(',')]);

  return { events, connected };
}
