import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'wouter';
import { api } from '../../api/client.js';
import { JoinedNetCard, type JoinedNetEntry } from '../configuration/JoinedNetCard.js';
import { Skeleton } from '../../components/ui/skeleton.js';

interface JoinedListResponse {
  joinedSolverNets: Record<string, JoinedNetEntry>;
}

export interface MembershipsTabProps {
  onRestartPending?: () => void;
}

/**
 * /operator/memberships — operator's joined SolverNets, edit-in-place.
 */
export function MembershipsTab({ onRestartPending }: MembershipsTabProps = {}): JSX.Element {
  const joinedQuery = useQuery<JoinedListResponse>({
    queryKey: ['operator', 'joined'],
    queryFn: () => api.operator.listJoined(),
    refetchInterval: 30_000,
  });

  const joinedEntries = useMemo<JoinedNetEntry[]>(() => {
    const record = joinedQuery.data?.joinedSolverNets ?? {};
    return Object.values(record);
  }, [joinedQuery.data]);

  return (
    <div data-testid="memberships-tab" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Joined · {joinedEntries.length}
        </span>
        {joinedQuery.isError && (
          <span role="alert" className="font-mono text-[11px] text-[var(--break-red)]">
            Failed to load joined SolverNets.
          </span>
        )}
      </div>

      {joinedQuery.isLoading && (
        <div data-testid="memberships-tab-loading" className="flex flex-col gap-3" aria-label="Loading">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {!joinedQuery.isLoading && joinedEntries.length === 0 && (
        <p
          data-testid="memberships-tab-empty"
          className="m-0 font-mono text-[12px] leading-relaxed text-muted-foreground"
        >
          You haven't joined any SolverNets yet. Browse the{' '}
          <Link href="/operator/registry" className="text-primary no-underline hover:underline">
            Registry
          </Link>{' '}
          to participate.
        </p>
      )}

      {joinedEntries.map((entry) => (
        <JoinedNetCard key={entry.manifestCid} joined={entry} onRestartPending={onRestartPending} />
      ))}
    </div>
  );
}
