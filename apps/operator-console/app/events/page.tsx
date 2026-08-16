'use client';

import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { daemonFetch, daemonJson } from '@/lib/daemon';
import { classifySurface, SurfaceStatus } from '@/lib/use-daemon';

type CloudEvent = {
  id?: string;
  type?: string;
  time?: string;
  data?: { title?: string; kind?: string; requestId?: string };
};

type RecentPayload = { events?: CloudEvent[] } | CloudEvent[];

function rowsFrom(payload: RecentPayload | null): CloudEvent[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.events ?? [];
}

export default function EventsPage() {
  const [events, setEvents] = useState<CloudEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lastId = { current: undefined as string | undefined };

    async function pullRecent(): Promise<void> {
      try {
        const payload = await daemonJson<RecentPayload>('/v1/events/recent');
        if (!cancelled) {
          setEvents(rowsFrom(payload));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void pullRecent();

    const abort = new AbortController();
    void (async () => {
      const headers: Record<string, string> = {};
      if (lastId.current) headers['Last-Event-ID'] = lastId.current;
      try {
        const response = await daemonFetch('/v1/events', {
          headers,
          signal: abort.signal,
        });
        if (!response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            const idLine = block.split('\n').find((line) => line.startsWith('id:'));
            const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
            if (idLine) lastId.current = idLine.slice(3).trim();
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(5).trim()) as CloudEvent;
              if (!cancelled) {
                setEvents((curr) => [parsed, ...curr].slice(0, 200));
                setLoading(false);
              }
            } catch {
              // ignore malformed frames
            }
          }
        }
      } catch {
        // SSE is best-effort; recent poll already populated the table.
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, []);

  const state = classifySurface({
    loading,
    error,
    empty: events.length === 0,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Events</CardTitle>
      </CardHeader>
      <CardContent>
        {state !== 'ready' ? (
          <SurfaceStatus name="events" state={state} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Title</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event, index) => (
                <TableRow key={event.id ?? `${event.time}-${index}`}>
                  <TableCell>{event.time ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {event.data?.kind ?? event.type ?? 'unknown'}
                    </Badge>
                  </TableCell>
                  <TableCell>{event.data?.title ?? event.type ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
