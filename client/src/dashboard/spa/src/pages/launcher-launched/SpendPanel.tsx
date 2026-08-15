import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type {
  LauncherStatusResponse,
  LaunchedSolverNetRecord,
  SolverNetManifestV1,
} from '../../../../../api/contract/index.js';
import { Card } from '../../components/ui/card.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';
import {
  formatWeiAmount,
  projectRunwayTasks,
  truncateAddress,
  LOW_RUNWAY_TASKS,
} from './helpers.js';

import type { JSX } from 'react';

/**
 * Safe-funded budget overview for the launched SolverNet.
 *
 * Sources:
 *   - Solution + verdict prices come straight from the manifest.
 *   - Safe balance comes from the existing `/v1/launcher/status` endpoint —
 *     the daemon's launcher-status assembler returns the launcher's master
 *     Safe balance per net. Until a per-SolverNet Safe lands (out of scope
 *     for Task 19), this panel matches the manifest's `name` against the
 *     launcher-status `nets[i].name` to pick the right entry.
 *
 * If `/v1/launcher/status` returns no matching net (e.g., the operator
 * disabled the launching role manually, or the daemon hasn't surfaced it
 * yet), we degrade to "balance unavailable" rather than fail the panel —
 * the manifest prices remain visible.
 */

export interface SpendPanelProps {
  record: LaunchedSolverNetRecord;
  manifest?: SolverNetManifestV1;
  /** Override fetcher in tests. */
  fetchLauncherStatus?: () => Promise<LauncherStatusResponse>;
}

export function SpendPanel({
  record,
  manifest,
  fetchLauncherStatus,
}: SpendPanelProps): JSX.Element {
  const fetcher = fetchLauncherStatus ?? (() => api.fetchLauncherStatus());
  const { data: status, isLoading, isError } = useQuery<LauncherStatusResponse>({
    queryKey: ['launcher-status', record.solverNetId],
    queryFn: () => fetcher(),
    refetchInterval: 30_000,
  });

  const manifestSolverType = manifest
    ? `${manifest.contract.id}.${manifest.contract.version}`
    : record.summary
      ? `${record.summary.contractId}.${record.summary.contractVersion}`
      : undefined;
  const matchedEntry = manifestSolverType
    ? status?.nets.find((n) =>
        n.solverType === manifestSolverType ||
        n.name === (manifest?.name ?? record.summary?.name),
      )
    : undefined;

  const safeBalanceWei = matchedEntry?.budget.safeBalanceWei;
  const safeAddress =
    matchedEntry?.budget.safeAddress ?? record.launcherSafeAddress;

  const solutionPriceWei = manifest?.solutionPriceWei ?? record.summary?.solutionPriceWei;
  const verdictPriceWei = manifest?.verdictPriceWei ?? record.summary?.verdictPriceWei;

  const projection = projectRunwayTasks(
    safeBalanceWei,
    solutionPriceWei,
    verdictPriceWei,
  );

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        data-testid="launcher-launched-spend-panel"
        role="region"
        aria-label="Spend and runway"
        className="flex flex-col gap-3 p-6"
      >
        <header className="flex items-center justify-between gap-3">
          <h2 className="m-0 font-serif text-[22px] font-normal text-foreground">
            Spend &amp; runway
          </h2>
        </header>

        <dl className="m-0 grid gap-y-2 gap-x-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          <Field
            label="Safe address"
            value={truncateAddress(safeAddress)}
            tooltip={safeAddress}
            testid="launcher-launched-spend-safe-address"
          />
          <Field
            label="Safe balance"
            value={
              isLoading
                ? '—'
                : safeBalanceWei
                  ? formatWeiAmount(safeBalanceWei)
                  : 'unavailable'
            }
            tooltip={safeBalanceWei ? `${safeBalanceWei} wei` : undefined}
            testid="launcher-launched-spend-safe-balance"
          />
          <Field
            label="Solution price"
            value={
              solutionPriceWei
                ? formatWeiAmount(solutionPriceWei)
                : '—'
            }
            tooltip={solutionPriceWei ? `${solutionPriceWei} wei` : undefined}
            testid="launcher-launched-spend-solution-price"
          />
          <Field
            label="Verdict price"
            value={
              verdictPriceWei
                ? formatWeiAmount(verdictPriceWei)
                : '—'
            }
            tooltip={verdictPriceWei ? `${verdictPriceWei} wei` : undefined}
            testid="launcher-launched-spend-verdict-price"
          />
          <Field
            label="Per-Task cost"
            value={
              projection
                ? formatWeiAmount(projection.perTaskWei.toString())
                : '—'
            }
            tooltip={projection ? `${projection.perTaskWei.toString()} wei` : undefined}
            testid="launcher-launched-spend-per-task"
          />
          <Field
            label="Projected runway"
            value={
              projection
                ? `${projection.tasks.toLocaleString()} Tasks at current prices`
                : 'manifest or balance unavailable'
            }
            testid="launcher-launched-spend-runway"
          />
        </dl>

        {isError && (
          <span
            data-testid="launcher-launched-spend-error"
            className="font-mono text-[12px] text-destructive"
          >
            Failed to load Safe balance.
          </span>
        )}

        {projection?.lowRunway && (
          <span
            data-testid="launcher-launched-spend-low-runway"
            className="font-mono text-[12px] text-[var(--wane)]"
          >
            Runway low — under {LOW_RUNWAY_TASKS.toLocaleString()} Tasks remain
            at current prices. Top up your wallet from the Overview faucet — the
            daemon forwards ETH to the Safe automatically. This panel has no
            local top-up action.
          </span>
        )}

        <p className="m-0 font-mono text-[11px] leading-relaxed text-[var(--fg-dim)]">
          Runway projects how many Tasks the Safe can fund at the current
          manifest prices, including the expected claim-tx gas per Task.
        </p>
      </Card>
    </TooltipProvider>
  );
}

function Field({
  label,
  value,
  testid,
  tooltip,
}: {
  label: string;
  value: string;
  testid?: string;
  tooltip?: string;
}): JSX.Element {
  const valueNode = (
    <dd
      data-testid={testid}
      className="m-0 truncate font-mono text-[13px] text-foreground"
      tabIndex={tooltip ? 0 : undefined}
    >
      {value}
    </dd>
  );
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-dim)]">
        {label}
      </dt>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{valueNode}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        valueNode
      )}
    </div>
  );
}
