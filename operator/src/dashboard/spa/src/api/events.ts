import { useEffect, useState } from 'react';
import {
  operatorLifecycleCloudEventSchema,
  type OperatorLifecycleCloudEvent,
} from '../../../../api/contract/index.js';

export function parseOperatorLifecycleSseData(raw: string): OperatorLifecycleCloudEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = operatorLifecycleCloudEventSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function useEventStream(filterKinds?: string[]): {
  events: OperatorLifecycleCloudEvent[];
  connected: boolean;
} {
  const [events, setEvents] = useState<OperatorLifecycleCloudEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const q = filterKinds && filterKinds.length > 0
      ? `?kinds=${filterKinds.join(',')}`
      : '';
    const es = new EventSource(`/v1/events${q}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      const parsed = parseOperatorLifecycleSseData(msg.data);
      if (!parsed) return;
      setEvents((prev) => [...prev.slice(-499), parsed]);
    };
    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKinds?.join(',')]);

  return { events, connected };
}
