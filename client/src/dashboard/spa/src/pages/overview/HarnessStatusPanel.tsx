import { Fragment } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { api } from '../../api/client.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Separator } from '../../components/ui/separator.js';
import type { HarnessReadinessEntry } from '../../api/types.js';

/**
 * Harness Readiness — §2.9 surface promoted out of buried state into a
 * first-class /overview card. One row per harness this operator has joined
 * a SolverNet against (joined-only scope; see design note 2026-05-26 for the
 * "joined vs all" decision). Per-row read uses `api.harnessReadiness(name)`
 * via TanStack Query with a 30s refetch — same query the JoinFlow uses,
 * different surface.
 */
export interface HarnessStatusPanelProps {
  /** Harness names this operator joined SolverNets against, deduplicated. */
  harnessNames: string[];
}

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const sectionLabel = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';

type RowStatus = 'ready' | 'not-ready' | 'error';

function HarnessStatusRow({ name }: { name: string }): JSX.Element {
  const queryClient = useQueryClient();
  const { data, isError, error } = useQuery<HarnessReadinessEntry>({
    queryKey: ['harness-readiness', name],
    queryFn: () => api.harnessReadiness(name),
    refetchInterval: 30_000,
  });

  function statusOf(): RowStatus | null {
    if (isError) return 'error';
    if (data?.ready === true) return 'ready';
    if (data?.ready === false) return 'not-ready';
    return null;
  }
  const status = statusOf();
  const showActions = status === 'not-ready';

  const recheck = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['harness-readiness', name] });
  };

  const reauthenticate = (): void => {
    const step = data?.nextStep;
    if (!step) return;
    if (step.url) {
      window.open(step.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (step.cli) {
      void navigator.clipboard
        .writeText(step.cli)
        .then(() => toast.success('Command copied', { description: step.cli, duration: 5_000 }))
        .catch(() =>
          toast.error('Could not copy', {
            description: step.cli,
            duration: Infinity,
          }),
        );
    }
  };

  return (
    <div data-testid={`harness-row-${name}`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className={sectionLabel}>{name}</span>
        {status === 'ready' && (
          <Badge variant="success" data-testid={`harness-pill-ready-${name}`}>
            ready
          </Badge>
        )}
        {status === 'not-ready' && (
          <Badge variant="destructive" data-testid={`harness-pill-not-ready-${name}`}>
            not ready
          </Badge>
        )}
        {status === 'error' && (
          <Badge variant="outline" data-testid={`harness-pill-error-${name}`}>
            unavailable
          </Badge>
        )}
      </div>
      {status === 'not-ready' && data?.reason && (
        <span className="font-mono text-[12px] text-[var(--break-red)]">{data.reason}</span>
      )}
      {status === 'not-ready' && data?.nextStep && (
        <span
          data-testid={`harness-next-step-${name}`}
          className="font-mono text-[12px] text-[var(--fg-muted)]"
        >
          {data.nextStep.description}
          {data.nextStep.cli ? ` (${data.nextStep.cli})` : ''}
        </span>
      )}
      {status === 'error' && (
        <span className="font-mono text-[12px] text-[var(--fg-muted)]">
          {error instanceof Error ? error.message : 'Readiness check failed.'}
        </span>
      )}
      {showActions && (
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            data-testid={`harness-reauth-${name}`}
            onClick={reauthenticate}
          >
            Re-authenticate
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid={`harness-recheck-${name}`}
            onClick={recheck}
          >
            Re-check
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyState(): JSX.Element {
  const [, navigate] = useLocation();
  return (
    <div className="flex flex-col gap-2" data-testid="harness-empty-state">
      <span className="font-mono text-[12px] text-[var(--fg-muted)]">
        No SolverNets joined — Harness Readiness will populate after you join one.
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate('/operator/registry')}
        data-testid="harness-empty-state-browse"
        className="self-start"
      >
        Browse SolverNets
      </Button>
    </div>
  );
}

export function HarnessStatusPanel({
  harnessNames,
}: HarnessStatusPanelProps): JSX.Element {
  return (
    <Card
      role="region"
      aria-label="Harness Readiness"
      data-testid="harness-status-panel"
      className="flex flex-col gap-4 p-6"
    >
      <span className={eyebrow}>Harness Readiness</span>
      {harnessNames.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-4">
          {harnessNames.map((name, idx) => (
            <Fragment key={name}>
              {idx > 0 && <Separator />}
              <HarnessStatusRow name={name} />
            </Fragment>
          ))}
        </div>
      )}
    </Card>
  );
}
