import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../../api/client.js';
import { JoinedNetCard, type JoinedNetEntry } from '../configuration/JoinedNetCard.js';

interface JoinedListResponse {
  joinedSolverNets: Record<string, JoinedNetEntry>;
}

export interface MembershipsTabProps {
  onRestartPending?: () => void;
}

/**
 * /operator/memberships — operator's joined SolverNets, edit-in-place.
 * Extracted from SolverNetsSection JOINED block (§2.4).
 */
export function MembershipsTab({
  onRestartPending,
}: MembershipsTabProps = {}): JSX.Element {
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
    <div
      data-testid="memberships-tab"
      style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          Joined · {joinedEntries.length}
        </span>
        {joinedQuery.isError && (
          <span
            role="alert"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              color: 'var(--break-red)',
            }}
          >
            Failed to load joined SolverNets.
          </span>
        )}
      </div>

      {joinedQuery.isLoading && (
        <p
          data-testid="memberships-tab-loading"
          style={{
            margin: 0,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: 'var(--fg-muted)',
          }}
        >
          Loading…
        </p>
      )}

      {!joinedQuery.isLoading && joinedEntries.length === 0 && (
        <p
          data-testid="memberships-tab-empty"
          style={{
            margin: 0,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: 'var(--fg-muted)',
            lineHeight: 1.5,
          }}
        >
          You haven't joined any SolverNets yet. Browse the{' '}
          <a
            href="/operator/registry"
            style={{
              color: 'var(--accent-sky)',
              textDecoration: 'none',
            }}
          >
            Registry
          </a>{' '}
          to participate.
        </p>
      )}

      {joinedEntries.map((entry) => (
        <JoinedNetCard
          key={entry.manifestCid}
          joined={entry}
          onRestartPending={onRestartPending}
        />
      ))}
    </div>
  );
}
