'use client';

import Link from 'next/link';
import { Calendar, Rows3, FileText, HeartPulse } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TruncatedId } from '@/components/truncated-id';
import { DispatchScheduleTab } from './dispatch-schedule';
import { ArtifactsGallery } from './artifacts-gallery';
import { WorkstreamHealth } from '@/components/workstream-health';
import type { ScheduleEntry } from '@/lib/ventures-services';
import type { Workstream } from '@/lib/subgraph';

interface VentureScheduleDashboardProps {
  ventureId: string;
  schedule: ScheduleEntry[];
  workstreams: Workstream[];
  /** Venture-level blueprint (overrides template blueprint in health tab) */
  ventureBlueprint?: unknown;
}

/**
 * Dashboard for schedule-only ventures (no root workstream).
 * Shows Schedule + Workstreams tabs.
 */
export function VentureScheduleDashboard({
  ventureId,
  schedule,
  workstreams,
  ventureBlueprint,
}: VentureScheduleDashboardProps) {
  return (
    <Tabs defaultValue="schedule" className="flex-1 flex flex-col min-h-0">
      <TabsList className="w-fit">
        <TabsTrigger value="schedule" className="gap-1 md:gap-2">
          <Calendar className="h-4 w-4" />
          Schedule
        </TabsTrigger>
        <TabsTrigger value="workstreams" className="gap-1 md:gap-2">
          <Rows3 className="h-4 w-4" />
          Workstreams ({workstreams.length})
        </TabsTrigger>
        <TabsTrigger value="health" className="gap-1 md:gap-2">
          <HeartPulse className="h-4 w-4" />
          Health
        </TabsTrigger>
        <TabsTrigger value="artifacts" className="gap-1 md:gap-2">
          <FileText className="h-4 w-4" />
          Artifacts
        </TabsTrigger>
      </TabsList>

      <TabsContent value="schedule" className="flex-1 min-h-0 mt-4">
        <DispatchScheduleTab
          ventureId={ventureId}
          schedule={schedule}
          workstreams={workstreams}
        />
      </TabsContent>

      <TabsContent value="workstreams" className="flex-1 min-h-0 mt-4 overflow-auto">
        {workstreams.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No workstreams yet
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job Name</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workstreams.map((ws) => (
                  <TableRow key={ws.id}>
                    <TableCell>
                      <Link
                        href={`/workstreams/${ws.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {ws.jobName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(Number(ws.blockTimestamp) * 1000).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <TruncatedId value={ws.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TabsContent>

      <TabsContent value="health" className="flex-1 min-h-0 mt-4">
        {workstreams.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No workstreams yet
          </div>
        ) : (
          <WorkstreamHealth workstreamId={workstreams[0].id} ventureBlueprint={ventureBlueprint} />
        )}
      </TabsContent>

      <TabsContent value="artifacts" className="flex-1 min-h-0 mt-4">
        <div className="min-h-[500px]">
          <ArtifactsGallery ventureId={ventureId} />
        </div>
      </TabsContent>
    </Tabs>
  );
}
