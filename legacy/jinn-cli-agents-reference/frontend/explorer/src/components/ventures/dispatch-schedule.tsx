'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Calendar, Clock } from 'lucide-react';
import { ScheduleTimeline } from './schedule-timeline';
import { describeCron, buildTimelineEntries } from '@/lib/ventures/cron-utils';
import type { ScheduleEntry } from '@/lib/ventures-services';
import type { Workstream } from '@/lib/subgraph';

interface DispatchScheduleTabProps {
  ventureId: string;
  schedule: ScheduleEntry[];
  workstreams: Workstream[];
}

export function DispatchScheduleTab({ ventureId, schedule, workstreams }: DispatchScheduleTabProps) {
  const now = useMemo(() => new Date(), []);

  const timelineEntries = useMemo(
    () => buildTimelineEntries(schedule, workstreams, now),
    [schedule, workstreams, now],
  );

  // Count recent successes (7 days) per templateId
  const recentSuccessCounts = useMemo(() => {
    const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    for (const ws of workstreams) {
      if (!ws.templateId) continue;
      const wsTime = Number(ws.blockTimestamp) * 1000;
      if (wsTime < sevenDaysAgo) continue;
      if (ws.delivered) {
        counts[ws.templateId] = (counts[ws.templateId] || 0) + 1;
      }
    }
    return counts;
  }, [workstreams, now]);

  if (!schedule || schedule.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No dispatch schedule configured
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-6">
      {/* Left: Timeline Overview */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            Timeline
            <span className="text-xs font-normal text-muted-foreground">48h past — now — 48h future</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScheduleTimeline entries={timelineEntries} />
        </CardContent>
      </Card>

      {/* Right: Schedule Items Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Schedule Items
            <Badge variant="outline" className="text-xs">
              {schedule.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead className="text-right">Recent (7d)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedule.map((entry) => {
                  const isEnabled = entry.enabled !== false;
                  const successCount = recentSuccessCounts[entry.templateId] || 0;

                  return (
                    <TableRow key={entry.id} className={!isEnabled ? 'opacity-50' : undefined}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">
                            {entry.label || entry.templateId.slice(0, 12)}
                          </span>
                          {!isEnabled && (
                            <Badge variant="secondary" className="text-[10px]">Paused</Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                          {entry.templateId.slice(0, 8)}...
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{describeCron(entry.cron)}</div>
                        <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                          {entry.cron}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="text-sm font-medium">
                          {successCount > 0 ? (
                            <span className="text-green-600">{successCount}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
