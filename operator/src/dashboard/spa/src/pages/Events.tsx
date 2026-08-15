import { useMemo, useState, type JSX } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { ChevronRight, Loader2, X } from 'lucide-react';
import { api } from '../api/client.js';
import type { ActivityEventRow, ActivityEventsResponse } from '../../../../api/contract/index.js';
import {
  LIFECYCLE_KINDS,
  eventKindBadgeVariant,
  eventKindMeta,
} from '../lib/event-kinds.js';
import { cn } from '../lib/utils.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../components/ui/tooltip.js';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';

type OutcomeFilter = 'all' | 'ok' | 'failed' | 'warn';

const PAGE_SIZE = 50;

function formatTimestamp(ts: string | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function truncateMiddle(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function subjectFor(row: ActivityEventRow): string {
  return row.requestId ?? row.solverType ?? '-';
}

function useRequestIdFromLocation(): string | undefined {
  const [location] = useLocation();
  return useMemo(() => {
    const locationQuery = location.includes('?') ? location.split('?')[1] : '';
    const browserQuery =
      typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
    const query = locationQuery || browserQuery;
    const raw = new URLSearchParams(query).get('requestId')?.trim();
    return raw || undefined;
  }, [location]);
}

export interface EventsPageProps {
  pageSize?: number;
}

export function EventsPage({ pageSize = PAGE_SIZE }: EventsPageProps = {}): JSX.Element {
  const requestId = useRequestIdFromLocation();
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');

  const query = useInfiniteQuery<ActivityEventsResponse>({
    queryKey: ['activity-events', selectedKinds, outcome, requestId, pageSize],
    queryFn: ({ pageParam }) =>
      api.getActivityEvents({
        kinds: selectedKinds.length > 0 ? selectedKinds : undefined,
        outcome: outcome === 'all' ? undefined : outcome,
        requestId,
        beforeId: typeof pageParam === 'number' ? pageParam : undefined,
        limit: pageSize,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const pages = query.data?.pages ?? [];
  const events = pages.flatMap((p) => p.events);
  const counts = pages[0]?.counts ?? {};

  function toggleKind(kind: string): void {
    setSelectedKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  }

  return (
    <main data-testid="events-page" className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 font-serif text-[32px] font-normal leading-tight text-foreground">
            Events
          </h1>
          <p className="m-0 font-mono text-[12px] text-muted-foreground">
            Persistent lifecycle activity from this operator.
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href="/overview" data-testid="events-back">Overview</Link>
        </Button>
      </header>

      {requestId && (
        <Alert variant="info" data-testid="events-request-scope">
          <AlertTitle>Request scoped</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span className="break-all">Showing events for {requestId}</span>
            <Button asChild variant="link" size="sm" className="h-auto p-0">
              <Link href="/events" data-testid="events-clear-request">
                <X aria-hidden="true" />
                Clear
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Kind and outcome filters page through the same durable log.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Kind
            </h2>
            <div className="flex flex-wrap gap-2">
              {LIFECYCLE_KINDS.map((kind) => {
                const active = selectedKinds.includes(kind);
                const meta = eventKindMeta(kind);
                return (
                  <Button
                    key={kind}
                    type="button"
                    size="sm"
                    variant={active ? 'outline' : 'secondary'}
                    aria-pressed={active ? 'true' : 'false'}
                    data-testid={`events-kind-filter-${kind}`}
                    onClick={() => toggleKind(kind)}
                    className="normal-case tracking-normal"
                  >
                    {meta.label}
                    {counts[kind] !== undefined && (
                      <Badge variant="secondary">{counts[kind]}</Badge>
                    )}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Outcome
            </h2>
            <div className="flex flex-wrap gap-2">
              {(['all', 'ok', 'failed', 'warn'] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={outcome === value ? 'outline' : 'secondary'}
                  aria-pressed={outcome === value ? 'true' : 'false'}
                  data-testid={`events-outcome-${value}`}
                  onClick={() => setOutcome(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="events-list-section">
        <CardHeader>
          <CardTitle>Event Log</CardTitle>
          <CardDescription>{events.length} loaded</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {query.isLoading && (
            <div data-testid="events-loading" className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
              <Loader2 className="animate-spin" aria-hidden="true" />
              Loading events
            </div>
          )}

          {query.isError && (
            <Alert variant="blocking" data-testid="events-error">
              <AlertTitle>Events unavailable</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {query.error instanceof Error ? query.error.message : 'Failed to load events.'}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void query.refetch();
                  }}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {!query.isLoading && !query.isError && events.length === 0 && (
            <p data-testid="events-empty" className="m-0 font-mono text-[12px] text-muted-foreground">
              No events match the current filters.
            </p>
          )}

          {events.length > 0 && (
            <div data-testid="events-list" className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Time</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Tx</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((row) => {
                    // Unknown-kind rendering rule (§8 artifact 6): pass the row's own
                    // severity/title through so a kind this build doesn't recognize still
                    // renders the daemon's intended framing instead of a bare kind string.
                    const wire = { severity: row.severity, title: row.title };
                    const meta = eventKindMeta(row.kind, wire);
                    return (
                      <TableRow key={row.id} data-testid="events-row">
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatTimestamp(row.ts)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={eventKindBadgeVariant(row.kind, row.outcome, wire)}>
                            {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[280px] font-mono text-[12px]">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className={cn(row.requestId && 'cursor-help')}>
                                {row.requestId
                                  ? truncateMiddle(row.requestId)
                                  : subjectFor(row)}
                              </span>
                            </TooltipTrigger>
                            {row.requestId && <TooltipContent>{row.requestId}</TooltipContent>}
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Badge variant={eventKindBadgeVariant(row.kind, row.outcome, wire)}>
                            {row.outcome ?? '-'}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-[12px] text-muted-foreground">
                          {row.txHash ? truncateMiddle(row.txHash, 6, 4) : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button asChild variant="ghost" size="icon" aria-label={`Inspect event ${row.id}`}>
                            <Link href={`/events/${row.id}`} data-testid="events-row-link">
                              <ChevronRight aria-hidden="true" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {query.hasNextPage && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="events-load-more"
              disabled={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
              className="self-start"
            >
              {query.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden="true" />}
              {query.isFetchingNextPage ? 'Loading' : 'Load more'}
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
