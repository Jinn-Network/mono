import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { DiscoveryPluginPublicationsResponse, PluginPublicationDto } from '../../../../../api/contract/index.js';
import {
  Card,
  CardContent,
  CardHeader,
} from '../../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';

import type { JSX } from 'react';

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';

function truncate(cid: string): string {
  return cid.length > 14 ? `${cid.slice(0, 8)}…${cid.slice(-4)}` : cid;
}

/**
 * Render the panel header — eyebrow + serif title — preserving the
 * literal phrase "Published plug-ins for <solverType>" so the BuildPage
 * test's `getByText` matcher still resolves.
 */
function PanelHeader({ solverType }: { solverType: string }): JSX.Element {
  return (
    <CardHeader className="mb-5 flex flex-col gap-1 p-0">
      <span className={eyebrow}>Registry</span>
      <h3 className="m-0 font-serif text-[22px] leading-[1.25] text-foreground">
        Published plug-ins for {solverType}
      </h3>
    </CardHeader>
  );
}

/**
 * PublishedPluginsPanel — registry browse view for a single SolverType.
 * Queries `/v1/discovery/plugin-publications?solverType=<solverType>` via
 * react-query and renders one row per published plug-in. Revoked rows
 * show a wane-toned outline `<Badge>`; active rows show a success Badge.
 *
 * Loading state renders a small block of `<Skeleton>` lines so the surface
 * doesn't flash blank; the error state lands in an `<Alert variant="blocking">`
 * with the underlying message preserved. Empty state keeps the original
 * dashed-border affordance pointing operators at `jinn solver-plugins publish`.
 */
export function PublishedPluginsPanel({ solverType }: { solverType: string }): JSX.Element {
  const { data, isLoading, error } = useQuery<DiscoveryPluginPublicationsResponse>({
    queryKey: ['discovery', 'plugin-publications', solverType],
    queryFn: () => api.discovery.listPluginPublications({ solverType }),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <Card className="p-6">
        <PanelHeader solverType={solverType} />
        <CardContent className="flex flex-col gap-2 p-0">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-6">
        <PanelHeader solverType={solverType} />
        <CardContent className="p-0">
          <Alert variant="blocking">
            <AlertDescription>
              Discovery unavailable. {(error as Error).message}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const rows = data?.publications ?? [];

  if (rows.length === 0) {
    return (
      <Card className="p-6">
        <PanelHeader solverType={solverType} />
        <CardContent className="p-0">
          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-[var(--bg-sunken)] p-6">
            <span className={eyebrow}>Empty registry</span>
            <p className="m-0 max-w-[64ch] font-mono text-[13px] leading-[1.7] text-foreground">
              No plug-ins published yet. Be the first.
            </p>
            <p className="m-0 max-w-[64ch] font-mono text-[13px] leading-[1.7] text-muted-foreground">
              Run{' '}
              <code className="rounded-sm border border-border bg-background px-1.5 py-px font-mono text-[12px] text-primary">
                jinn solver-plugins publish
              </code>{' '}
              and your plug-in appears here under your builder agentId.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <PanelHeader solverType={solverType} />
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plug-in</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Builder agentId</TableHead>
              <TableHead>CID</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r: PluginPublicationDto) => (
              <TableRow key={`${r.builderAgentId}:${r.cid}`}>
                <TableCell className="font-mono text-[12px] text-foreground">{r.name}</TableCell>
                <TableCell className="font-mono text-[12px] text-muted-foreground">{r.version}</TableCell>
                <TableCell className="font-mono text-[12px] text-muted-foreground">{r.builderAgentId}</TableCell>
                <TableCell className="font-mono text-[12px] text-muted-foreground">{truncate(r.cid)}</TableCell>
                <TableCell>
                  {r.revoked ? (
                    <Badge variant="outline" className="rounded-full border-[var(--wane)] text-[var(--wane)]">
                      Revoked{r.revokedReason ? ` · ${r.revokedReason}` : ''}
                    </Badge>
                  ) : (
                    <Badge variant="success" className="rounded-full">
                      Active
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
