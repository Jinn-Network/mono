import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../api/client.js';
import type { ActivityEventRow, BootstrapState } from '../../../../api/contract/index.js';
import { eventKindBadgeVariant, eventKindMeta } from '../lib/event-kinds.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';
import { Separator } from '../components/ui/separator.js';

import type { JSX } from 'react';

function formatTimestamp(ts: string | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function explorerBase(chain: string | undefined): string {
  return chain === 'base' ? 'https://basescan.org' : 'https://sepolia.basescan.org';
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
      <dt className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 break-all font-mono text-[12px] text-foreground">{children}</dd>
    </div>
  );
}

export function EventDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';

  const { data: bootstrap } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
  });

  const { data, isLoading, isError, error, refetch } = useQuery<ActivityEventRow>({
    queryKey: ['activity-events', 'detail', id],
    queryFn: () => api.getActivityEvent(id),
    enabled: id.length > 0,
  });

  const meta = data ? eventKindMeta(data.kind) : null;
  const explorer = explorerBase(bootstrap?.chain);

  return (
    <main data-testid="event-detail" className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 font-serif text-[32px] font-normal leading-tight text-foreground">
            {meta ? meta.label : 'Event'}
          </h1>
          <p className="m-0 font-mono text-[12px] text-muted-foreground">
            Event {id}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href="/events" data-testid="event-detail-back">
            <ArrowLeft aria-hidden="true" />
            Events
          </Link>
        </Button>
      </header>

      {isLoading && (
        <div data-testid="event-detail-loading" className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
          <Loader2 className="animate-spin" aria-hidden="true" />
          Loading event
        </div>
      )}

      {isError && (
        <Alert variant="blocking" data-testid="event-detail-error">
          <AlertTitle>Event unavailable</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {(error as { status?: number } | null)?.status === 404
                ? 'This event could not be found.'
                : error instanceof Error
                  ? error.message
                  : 'Failed to load this event.'}
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                void refetch();
              }}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {data && meta && (
        <>
          <Card data-testid="event-detail-summary">
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <CardDescription>{meta.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Badge variant={eventKindBadgeVariant(data.kind, data.outcome)}>
                {data.outcome ?? '-'}
              </Badge>
              <Badge variant="outline">{formatTimestamp(data.ts)}</Badge>
            </CardContent>
          </Card>

          <Card data-testid="event-detail-payload">
            <CardHeader>
              <CardTitle>Details</CardTitle>
              <CardDescription>Raw event fields from the persistent activity log.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="m-0">
                <DetailRow label="Event id">{data.id}</DetailRow>
                <Separator />
                <DetailRow label="Kind">{data.kind}</DetailRow>
                <Separator />
                <DetailRow label="Request id">{data.requestId ?? '-'}</DetailRow>
                <Separator />
                <DetailRow label="Service index">
                  {data.serviceIndex !== null ? data.serviceIndex : '-'}
                </DetailRow>
                <Separator />
                <DetailRow label="Solver type">{data.solverType ?? '-'}</DetailRow>
                <Separator />
                <DetailRow label="Transaction">
                  {data.txHash ? (
                    <Button asChild variant="link" size="sm" className="h-auto justify-start p-0 font-mono text-[12px] normal-case tracking-normal">
                      <a
                        data-testid="event-detail-tx-link"
                        href={`${explorer}/tx/${data.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {data.txHash}
                        <ExternalLink aria-hidden="true" />
                      </a>
                    </Button>
                  ) : (
                    '-'
                  )}
                </DetailRow>
                <Separator />
                <DetailRow label="Detail">{data.detail ?? '-'}</DetailRow>
              </dl>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
