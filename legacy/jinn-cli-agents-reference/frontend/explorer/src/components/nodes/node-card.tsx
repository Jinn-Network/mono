'use client';

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { WorkerNode, NodeHealthStatus } from '@/lib/nodes/nodes-config';

interface NodeCardProps {
  node: WorkerNode;
  health: NodeHealthStatus | null;
  isLoading?: boolean;
}

export function NodeCard({ node, health, isLoading }: NodeCardProps) {
  const isOnline = health?.status === 'ok';

  return (
    <Card className="relative">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-lg font-mono">
              {health?.nodeId || node.name}
            </CardTitle>
            <CardDescription>{node.description}</CardDescription>
          </div>
          <StatusBadge isOnline={isOnline} isLoading={isLoading} />
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm">
          {node.location && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Location</dt>
              <dd className="font-medium">{node.location}</dd>
            </div>
          )}
          {health?.uptime && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Uptime</dt>
              <dd className="font-medium">{health.uptime.human}</dd>
            </div>
          )}
          {health?.lastActivity && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Last Activity</dt>
              <dd className="font-medium">{health.lastActivity.human}</dd>
            </div>
          )}
          {health?.processedJobs !== undefined && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Jobs Processed</dt>
              <dd className="font-medium">{health.processedJobs.toLocaleString()}</dd>
            </div>
          )}
          {health?.timestamp && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Last Check</dt>
              <dd className="font-medium text-xs">
                {new Date(health.timestamp).toLocaleTimeString()}
              </dd>
            </div>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ isOnline, isLoading }: { isOnline: boolean; isLoading?: boolean }) {
  if (isLoading) {
    return (
      <Badge variant="secondary" className="animate-pulse">
        Checking...
      </Badge>
    );
  }

  if (isOnline) {
    return (
      <Badge className="bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500/20">
        <span className="mr-1.5 h-2 w-2 rounded-full bg-green-500 animate-pulse" />
        Online
      </Badge>
    );
  }

  return (
    <Badge variant="destructive" className="bg-red-500/10 text-red-600 border-red-500/20">
      <span className="mr-1.5 h-2 w-2 rounded-full bg-red-500" />
      Offline
    </Badge>
  );
}

export function NodeCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="h-5 w-32 bg-muted rounded animate-pulse" />
            <div className="h-4 w-48 bg-muted rounded animate-pulse" />
          </div>
          <div className="h-6 w-20 bg-muted rounded animate-pulse" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex justify-between">
            <div className="h-4 w-16 bg-muted rounded animate-pulse" />
            <div className="h-4 w-24 bg-muted rounded animate-pulse" />
          </div>
          <div className="flex justify-between">
            <div className="h-4 w-16 bg-muted rounded animate-pulse" />
            <div className="h-4 w-24 bg-muted rounded animate-pulse" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
