import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../../api/client.js';
import { SectionCard } from '../../components/SectionCard.js';
import { RegistryCatalog } from '../operator-catalog/RegistryCatalog.js';
import { JoinedNetCard, type JoinedNetEntry } from './JoinedNetCard.js';
import type { NetCardConfig } from './NetCard.js';

/**
 * Operator > SolverNets section. Two-block layout:
 *
 *   1. Joined — operator's joined SolverNets, edit-in-place harness/plugins/model.
 *      Each row is a `<JoinedNetCard>` cross-joined with the registry catalog
 *      so the form knows which harnesses/plugins are compatible.
 *   2. Discovery catalog — the existing `<RegistryCatalog />` for joining new
 *      SolverNets.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §12 + the
 * per-SolverNet harness plan.
 *
 * Hash deep-link: when the URL hash is `solvernets/<manifestCid>` or
 * `solvernets/<manifestCid>/harness`, the matching joined card is
 * `defaultExpanded` (and harness-focused on the latter form). The parent
 * `OperatorPage` passes the raw post-`solvernets/` segment via the
 * `joinedHashFragment` prop.
 */

interface JoinedListResponse {
  joinedSolverNets: Record<string, JoinedNetEntry>;
}

export interface SolverNetsSectionProps {
  /** @deprecated — drained to nothing in Task 22. Retained for compat. */
  configByName?: Record<
    string,
    Partial<NetCardConfig> & { role?: 'solving' | 'evaluating' }
  >;
  /** @deprecated — kept for prop-compat; no-op today. */
  onSaved?: () => void;
  /** Surfaces the restart banner when a per-net edit lands restart-required. */
  onRestartPending?: () => void;
  defaultExpanded?: boolean;
  /**
   * Post-`solvernets/` hash fragment, e.g. `<cid>` or `<cid>/harness`.
   * When set, the matching joined card auto-expands (and focuses harness
   * on the `/harness` form).
   */
  joinedHashFragment?: string;
}

export function SolverNetsSection({
  defaultExpanded = true,
  onRestartPending,
  joinedHashFragment,
}: SolverNetsSectionProps = {}): JSX.Element {
  const joinedQuery = useQuery<JoinedListResponse>({
    queryKey: ['operator', 'joined'],
    queryFn: () => api.operator.listJoined(),
    refetchInterval: 30_000,
  });

  const joinedEntries = useMemo<JoinedNetEntry[]>(() => {
    const record = joinedQuery.data?.joinedSolverNets ?? {};
    return Object.values(record);
  }, [joinedQuery.data]);

  // Parse the hash fragment: `<cid>` or `<cid>/harness`.
  const [hashCid, hashFocus] = useMemo(() => {
    if (!joinedHashFragment) return [null, null] as const;
    const parts = joinedHashFragment.split('/');
    return [parts[0] ?? null, parts[1] === 'harness' ? ('harness' as const) : null] as const;
  }, [joinedHashFragment]);

  return (
    <SectionCard
      title="SolverNets"
      summary="Configure your joined SolverNets and discover new ones."
      defaultExpanded={defaultExpanded}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <section
          data-testid="solvernets-joined-block"
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
              data-testid="solvernets-joined-loading"
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
              data-testid="solvernets-joined-empty"
              style={{
                margin: 0,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
                color: 'var(--fg-muted)',
                lineHeight: 1.5,
              }}
            >
              You haven't joined any SolverNets yet. Pick one below to participate.
            </p>
          )}

          {joinedEntries.map((entry) => {
            const isHashTarget = hashCid !== null && hashCid === entry.manifestCid;
            return (
              <JoinedNetCard
                key={entry.manifestCid}
                joined={entry}
                defaultExpanded={isHashTarget}
                focusOn={isHashTarget ? hashFocus ?? undefined : undefined}
                onRestartPending={onRestartPending}
              />
            );
          })}
        </section>

        <section
          data-testid="solvernets-discover-block"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
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
            Discover
          </span>
          <RegistryCatalog />
        </section>
      </div>
    </SectionCard>
  );
}
