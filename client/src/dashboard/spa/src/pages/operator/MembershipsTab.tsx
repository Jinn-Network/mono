import { useQuery } from '@tanstack/react-query';
import { useMemo, type JSX } from 'react';
import { api } from '../../api/client.js';
import { harnessDisplayName } from '../configuration/harnessNames.js';
import { Badge } from '../../components/ui/badge.js';
import { Card } from '../../components/ui/card.js';
import { Skeleton } from '../../components/ui/skeleton.js';

/**
 * /operator/memberships — the SolverNets this operator's config declares.
 *
 * READ-ONLY. Wave-4 D1 (DR-2026-08-05) retired the join/leave lifecycle with
 * the `joinedSolverNets` claim gate, so this surface no longer edits anything:
 * `POST`/`DELETE /v1/operator/join/:cid` are gone and headless design §4.2
 * schedules no CLI twin. `client/OPERATOR-APP-SPEC.md` §2.4 keeps the page as
 * the legacy VIEW until cutover stage 5, which is what this renders — one row
 * per entry in `GET /v1/operator/joined`.
 *
 * Claim eligibility no longer comes from here: it is Settings > Claim policy
 * & wiring (§2.15).
 */

export interface JoinedEntry {
  manifestCid: string;
  name?: string;
  contract?: { id: string; version: string };
  roles: Array<'solver' | 'evaluator'>;
  harness?: string;
  model?: string;
  plugins?: string[];
}

interface JoinedListResponse {
  joinedSolverNets: Record<string, JoinedEntry>;
}

const fieldLabel =
  'font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={fieldLabel}>{label}</span>
      <span className="font-mono text-[12px] text-foreground">{value}</span>
    </div>
  );
}

function JoinedRow({ entry }: { entry: JoinedEntry }): JSX.Element {
  const roles = entry.roles ?? [];
  const plugins = entry.plugins ?? [];
  return (
    <Card
      data-testid="joined-net-card"
      data-manifest-cid={entry.manifestCid}
      className="flex flex-col gap-3 p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span data-testid="joined-net-card-name" className="font-mono text-[14px] text-foreground">
          {entry.name ?? entry.manifestCid}
        </span>
        {roles.map((role) => (
          <Badge key={role} variant="outline" data-testid={`joined-net-card-role-${role}`}>
            {role}
          </Badge>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Manifest CID" value={entry.manifestCid} />
        <Field
          label="Contract"
          value={entry.contract ? `${entry.contract.id}.${entry.contract.version}` : '—'}
        />
        <Field label="Harness" value={entry.harness ? harnessDisplayName(entry.harness) : '—'} />
        <Field label="Model" value={entry.model ?? '—'} />
      </div>
      {plugins.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={fieldLabel}>Plugins</span>
          {plugins.map((plugin) => (
            <Badge key={plugin} variant="secondary">
              {plugin}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

export function MembershipsTab(): JSX.Element {
  const joinedQuery = useQuery<JoinedListResponse>({
    queryKey: ['operator', 'joined'],
    queryFn: () => api.operator.listJoined(),
    refetchInterval: 30_000,
  });

  const joinedEntries = useMemo<JoinedEntry[]>(() => {
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
            Failed to load joined SolverNets. Retrying every 30 seconds.
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
          No memberships in this operator&apos;s config. Add entries under{' '}
          <code>joinedSolverNets</code> in <code>~/.jinn-client/config.json</code> and restart the
          daemon.
        </p>
      )}

      {joinedEntries.map((entry) => (
        <JoinedRow key={entry.manifestCid} entry={entry} />
      ))}
    </div>
  );
}
