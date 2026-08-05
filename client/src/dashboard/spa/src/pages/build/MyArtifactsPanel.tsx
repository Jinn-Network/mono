import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { DiscoveryBuilderArtifactsResponse } from '../../../../../api/contract/index.js';
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
const inlineCode =
  'rounded-sm border border-border bg-background px-1.5 py-px font-mono text-[12px] text-primary';

function PanelHeader(): JSX.Element {
  return (
    <CardHeader className="mb-5 flex flex-col gap-1 p-0">
      <span className={eyebrow}>Builder</span>
      <h3 className="m-0 font-serif text-[22px] leading-[1.25] text-foreground">
        Your published plug-ins
      </h3>
    </CardHeader>
  );
}

/**
 * MyArtifactsPanel — builder-facing companion to PublishedPluginsPanel.
 * Queries `/v1/discovery/builder-artifacts?builderAgentId=<id>` once the
 * operator has a `fleet_agent_id`; before that, renders an identity-pending
 * prompt pointing at `jinn solver-plugins publish`.
 *
 * Migrated to shadcn `<Card>` / `<Table>` / `<Badge>` / `<Skeleton>` /
 * `<Alert>`. Three empty/intermediate states (identity-pending, loading,
 * empty) all use the dashed-border affordance with eyebrow + prose. Error
 * state lands in `<Alert variant="blocking">`.
 */
export function MyArtifactsPanel({ fleetAgentId }: { fleetAgentId: string | undefined }): JSX.Element {
  const enabled = Boolean(fleetAgentId);
  const { data, isLoading, error } = useQuery<DiscoveryBuilderArtifactsResponse>({
    queryKey: ['discovery', 'builder-artifacts', fleetAgentId],
    queryFn: () => api.discovery.listBuilderArtifacts(fleetAgentId!),
    enabled,
    refetchInterval: 30_000,
  });

  if (!enabled) {
    return (
      <Card className="bg-[var(--bg-sunken)] p-6">
        <PanelHeader />
        <CardContent className="p-0">
          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-6">
            <span className={eyebrow}>Identity pending</span>
            <p className="m-0 max-w-[64ch] font-mono text-[13px] leading-[1.7] text-muted-foreground">
              Complete identity bootstrap to see your published plug-ins. Run{' '}
              <code className={inlineCode}>jinn solver-plugins publish</code> on a
              plug-in and the lazy stage-ensure will provision your builder
              identity (Stage 1).
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="p-6">
        <PanelHeader />
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
        <PanelHeader />
        <CardContent className="p-0">
          <Alert variant="blocking">
            <AlertDescription>Discovery unavailable.</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const rows = (data?.artifacts ?? []).filter((a) => a.artifactType === 'plugin');

  if (rows.length === 0) {
    return (
      <Card className="p-6">
        <PanelHeader />
        <CardContent className="p-0">
          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-[var(--bg-sunken)] p-6">
            <span className={eyebrow}>Nothing yet</span>
            <p className="m-0 max-w-[64ch] font-mono text-[13px] leading-[1.7] text-muted-foreground">
              You have not published any plug-ins yet. Scaffold one with{' '}
              <code className={inlineCode}>jinn create plugin</code>, then publish
              with <code className={inlineCode}>jinn solver-plugins publish</code>.
              It will appear here under your builder agentId.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <PanelHeader />
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plug-in</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Supports</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.builderAgentId}:${r.cid}`}>
                <TableCell className="font-mono text-[12px] text-foreground">{r.name}</TableCell>
                <TableCell className="font-mono text-[12px] text-muted-foreground">{r.version}</TableCell>
                <TableCell className="font-mono text-[12px] text-muted-foreground">
                  {r.supports.join(', ')}
                </TableCell>
                <TableCell>
                  {r.revoked ? (
                    <Badge variant="outline" className="rounded-full border-[var(--wane)] text-[var(--wane)]">
                      Revoked
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
