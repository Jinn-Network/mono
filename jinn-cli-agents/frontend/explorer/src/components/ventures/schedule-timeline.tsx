'use client';

import { useRef, useEffect, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Clock, ArrowRight } from 'lucide-react';
import type { TimelineEntry } from '@/lib/ventures/cron-utils';
import type { Workstream } from '@/lib/subgraph';

function getWorkstreamStatusDisplay(ws: Workstream): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  if (ws.delivered) {
    return { label: 'Delivered', variant: 'default' };
  }
  return { label: 'In Progress', variant: 'secondary' };
}

function formatTime24(date: Date): string {
  return date.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
}

function formatDayHeader(date: Date): string {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dateStr = date.toISOString().slice(0, 10);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const dayName = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

  if (dateStr === todayStr) return `Today — ${dayName}`;
  if (dateStr === yesterdayStr) return `Yesterday — ${dayName}`;
  if (dateStr === tomorrowStr) return `Tomorrow — ${dayName}`;
  return dayName;
}

interface ScheduleTimelineProps {
  entries: TimelineEntry[];
}

export function ScheduleTimeline({ entries }: ScheduleTimelineProps) {
  const nowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll to "Now" marker
    const timer = setTimeout(() => {
      nowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // Group entries by day
  const dayGroups = useMemo(() => {
    const groups: { dayKey: string; dayDate: Date; entries: TimelineEntry[]; showNowAfter?: boolean }[] = [];
    const now = new Date();
    const nowDayKey = now.toISOString().slice(0, 10);
    let nowInserted = false;

    for (const entry of entries) {
      const dayKey = entry.time.toISOString().slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.dayKey === dayKey) {
        last.entries.push(entry);
      } else {
        groups.push({ dayKey, dayDate: entry.time, entries: [entry] });
      }
    }

    // Figure out where to show the "Now" marker
    for (const group of groups) {
      if (group.dayKey === nowDayKey) {
        // Insert now marker after the last past entry in today's group
        const lastPastIdx = group.entries.reduce(
          (acc, e, i) => (e.isPast ? i : acc), -1
        );
        group.showNowAfter = true;
        // Store the index in a custom way — we'll handle in rendering
        (group as any)._nowAfterIdx = lastPastIdx;
        nowInserted = true;
      }
    }

    // If now wasn't inserted in any existing day, add a synthetic group
    if (!nowInserted && groups.length > 0) {
      // Find where today falls
      const insertIdx = groups.findIndex(g => g.dayKey > nowDayKey);
      if (insertIdx === -1) {
        // Now is after all groups
        groups.push({ dayKey: nowDayKey, dayDate: now, entries: [], showNowAfter: true });
        (groups[groups.length - 1] as any)._nowAfterIdx = -1;
      } else {
        groups.splice(insertIdx, 0, { dayKey: nowDayKey, dayDate: now, entries: [], showNowAfter: true });
        (groups[insertIdx] as any)._nowAfterIdx = -1;
      }
    }

    return groups;
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        No scheduled dispatches in the timeline window
      </div>
    );
  }

  return (
    <ScrollArea className="h-[600px]">
      {/*
        3-column layout: [time 44px] [track 16px] [content flex-1]
        The vertical line sits at left-[52px] = 44 + half of 16, which is the
        flex justify-center centre of the track column — no magic pixel offsets.
      */}
      <div className="relative">
        <div className="absolute left-[52px] top-0 bottom-0 w-px bg-border" />

        {dayGroups.map((group) => {
          const nowAfterIdx = (group as any)._nowAfterIdx as number | undefined;

          return (
            <div key={group.dayKey} className="mb-4">
              {/* Sticky day header — track column left blank so line shows through */}
              <div className="sticky top-0 z-10 bg-background/95 backdrop-blur py-1.5 mb-2 flex items-center">
                <div className="w-[44px] shrink-0" />
                <div className="w-4 shrink-0" />
                <span className="flex-1 pl-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {formatDayHeader(group.dayDate)}
                </span>
              </div>

              {/* Entries */}
              {group.entries.map((entry, idx) => (
                <div key={`${entry.templateId}-${entry.time.toISOString()}`}>
                  <TimelineRow entry={entry} />
                  {group.showNowAfter && nowAfterIdx === idx && (
                    <NowMarker ref={nowRef} />
                  )}
                </div>
              ))}

              {group.showNowAfter && (nowAfterIdx === -1 || group.entries.length === 0) && (
                <NowMarker ref={nowRef} />
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

import { forwardRef } from 'react';

/*
 * 3-column layout used throughout: [time 44px] [track 16px] [content flex-1]
 * The vertical line is at left-[52px] = 44 + 8 (centre of the 16px track col).
 * Dots are centered in the track column via flex justify-center — no pixel offsets.
 */

const NowMarker = forwardRef<HTMLDivElement>(function NowMarker(_, ref) {
  const now = new Date();
  const timeStr = formatTime24(now);
  return (
    <div ref={ref} className="flex items-center py-2">
      {/* Col 1: time placeholder */}
      <div className="w-[44px] shrink-0" />
      {/* Col 2: track — primary dot, larger to distinguish from entry dots */}
      <div className="w-4 shrink-0 flex justify-center">
        <div className="w-3 h-3 rounded-full bg-primary border-2 border-background shadow-sm z-10" />
      </div>
      {/* Col 3: horizontal rule + label */}
      <div className="flex-1 flex items-center gap-2 pl-2">
        <div className="flex-1 h-px bg-primary" />
        <span className="text-xs font-semibold text-primary pr-2">Now · {timeStr}</span>
      </div>
    </div>
  );
});

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  return (
    <div className={`flex items-start py-1.5 ${entry.isPast ? 'opacity-70' : ''}`}>
      {/* Col 1: time */}
      <span className="font-mono text-xs text-muted-foreground w-[44px] shrink-0 pt-[3px] text-right pr-3">
        {formatTime24(entry.time)}
      </span>
      {/* Col 2: track — dot centred via flex, no absolute positioning */}
      <div className="w-4 shrink-0 flex justify-center pt-[3px]">
        <div className="w-2 h-2 rounded-full bg-muted-foreground/40 z-10" />
      </div>
      {/* Col 3: content */}
      <div className="flex-1 flex items-center gap-2 flex-wrap min-w-0 pl-2">
        <span className="text-sm truncate max-w-[200px]">{entry.label}</span>

        {entry.status === 'pending' && (
          <Badge variant="outline" className="text-[10px]">Pending</Badge>
        )}

        {entry.status === 'overdue' && (
          <Badge variant="destructive" className="text-[10px]">Overdue</Badge>
        )}

        {entry.status === 'dispatched' && entry.workstream && (
          <>
            {(() => {
              const { label, variant } = getWorkstreamStatusDisplay(entry.workstream);
              return <Badge variant={variant} className="text-[10px]">{label}</Badge>;
            })()}
            <a
              href={`/workstreams/${entry.workstream.id}`}
              className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
            >
              View <ArrowRight className="h-3 w-3" />
            </a>
          </>
        )}
      </div>
    </div>
  );
}
