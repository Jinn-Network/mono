import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, GitBranch } from 'lucide-react';
import type { Workstream } from '@/lib/subgraph';

function formatTimeAgo(unixSeconds: string): string {
  const now = Date.now();
  const diff = now - Number(unixSeconds) * 1000;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString();
}

interface WorkstreamsListProps {
  workstreams: Workstream[];
  ventureName: string;
}

export function WorkstreamsList({ workstreams, ventureName }: WorkstreamsListProps) {
  if (workstreams.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No workstreams found for this venture yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <GitBranch className="h-4 w-4" />
        <span>{workstreams.length} workstream{workstreams.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workstreams.map((ws) => (
          <Card key={ws.id} className="hover:border-primary/50 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base leading-tight">
                  <a
                    href={`https://explorer.jinn.network/ventures/${ws.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-primary hover:underline"
                  >
                    {ws.jobName || 'Unnamed Workstream'}
                  </a>
                </CardTitle>
                <Badge
                  variant="outline"
                  className={ws.delivered
                    ? 'bg-green-500/10 text-green-500 border-green-500/20 shrink-0'
                    : 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20 shrink-0'
                  }
                >
                  {ws.delivered ? 'delivered' : 'active'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>{ws.childRequestCount} request{ws.childRequestCount !== 1 ? 's' : ''}</span>
                <span>Last active {formatTimeAgo(ws.lastActivity || ws.blockTimestamp)}</span>
              </div>
              <a
                href={`https://explorer.jinn.network/ventures/${ws.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-primary hover:underline"
              >
                View details <ArrowRight className="h-3 w-3" />
              </a>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
