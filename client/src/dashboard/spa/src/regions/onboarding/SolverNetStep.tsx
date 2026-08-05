import { type JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { RegistryListResponse, SolverNetManifestSummary } from '../../../../../api/contract/index.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { isDemoSolverNet } from '../../lib/demo-solvernet.js';

/**
 * Onboarding step 4 — pick your first SolverNet.
 *
 * Build-delta #4: onboarding surfaces only `swe-rebench-v2`, preselected. The
 * full registry is the post-onboarding surface (RegistryCatalog).
 *
 * #983 (PR B) fix: this step reads the LIVE registry
 * (`api.solvernets.listRegistry()`) and joins under the real `manifestCid`,
 * the same key the running daemon filters claimable tasks by
 * (taskDiscoveryManifestCids). The predecessor synthetic-catalog path keyed
 * the join by `contract.id` ('swe-rebench-v2'), which never matched the
 * daemon's cid set, so the node claimed nothing. The registry holder is
 * populated post-flip; onboarding's action steps render post-flip (under the
 * App overlay), so it is available by then — with a brief 503
 * `subsystem_not_ready` window right after the flip, handled as a
 * non-blocking "starting" state (mirrors RegistryCatalog / HarnessSelectStep).
 *
 * PR A hot-applies the join to the running daemon, so a join made here after
 * the flip takes effect with no restart (restartRequired:false).
 */

/** Treated as "still starting", not a hard error (mirrors RegistryCatalog). */
const STARTING_CODES = new Set(['subsystem_not_ready', 'registry_unavailable']);

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  if (err instanceof Error && err.message.includes('subsystem_not_ready')) {
    return 'subsystem_not_ready';
  }
  return undefined;
}

export function SolverNetStep({
  onJoined,
  joinedCids,
}: {
  onJoined: (cid: string) => void;
  joinedCids: string[];
}): JSX.Element {
  const registryQuery = useQuery<RegistryListResponse>({
    queryKey: ['solvernets', 'registry'],
    queryFn: () => api.solvernets.listRegistry(),
    // Re-poll so the brief post-flip not-ready window self-heals without an
    // operator action (same cadence as the readiness probes in JoinFlow).
    refetchInterval: 5_000,
    retry: false,
  });

  const entry: SolverNetManifestSummary | undefined =
    registryQuery.data?.summaries.find(isDemoSolverNet);
  const cid = entry?.manifestCid;
  const alreadyJoined = cid !== undefined && joinedCids.includes(cid);

  const joinMutation = useMutation({
    mutationFn: async () => {
      if (!entry) throw new Error('no swe-rebench-v2 registry entry');
      return api.operator.join(entry.manifestCid, {
        name: entry.name,
        contract: { id: entry.contractId, version: entry.contractVersion },
        roles: ['solver'],
      });
    },
    onSuccess: () => {
      if (entry) onJoined(entry.manifestCid);
    },
  });

  if (registryQuery.isLoading) {
    return (
      <div data-testid="onboarding-solvernet-loading" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  // A definitive non-503 failure is a hard error. A 503 not-ready window, OR a
  // 200 response that does not (yet) carry the swe-rebench-v2 entry, is a
  // transient "still starting" state — keep polling, don't block the operator.
  const code = registryQuery.isError ? errorCode(registryQuery.error) : undefined;
  if (registryQuery.isError && !STARTING_CODES.has(code ?? '')) {
    return (
      <Alert variant="blocking" data-testid="onboarding-solvernet-error">
        <AlertTitle>Could not load SolverNets.</AlertTitle>
        <AlertDescription>
          The daemon could not read the SolverNet registry. Retry once startup
          finishes; check daemon logs if it keeps failing.
        </AlertDescription>
      </Alert>
    );
  }

  if (!entry) {
    return (
      <div
        data-testid="onboarding-solvernet-starting"
        className="flex items-center gap-3 font-mono text-[12px] text-[var(--fg-muted)]"
      >
        <Skeleton className="h-4 w-4 rounded-full" />
        Finding your first SolverNet…
      </div>
    );
  }

  return (
    <Card data-testid="onboarding-solvernet-card" data-manifest-cid={entry.manifestCid}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="font-mono text-[15px]">{entry.name}</CardTitle>
          {alreadyJoined ? (
            <Badge data-testid="onboarding-solvernet-joined">Joined</Badge>
          ) : (
            <Badge variant="secondary">Recommended</Badge>
          )}
        </div>
        <CardDescription>Pick your first SolverNet; add more later.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-sm text-[var(--fg-muted)]">
          Solve coding tasks; your node claims and submits solutions.
        </p>
        {!alreadyJoined && (
          <Button
            data-testid="onboarding-solvernet-join"
            onClick={() => joinMutation.mutate()}
            disabled={joinMutation.isPending}
          >
            {joinMutation.isPending ? 'Joining…' : 'Join'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
