import type {
  LaunchedSolverNetRecord,
  LaunchedStatus,
  LifecycleTarget,
  SolverNetManifestV1,
} from '../../../../../api/contract/index.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Separator } from '../../components/ui/separator.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';
import {
  ALLOWED_TRANSITIONS,
  truncateAddress,
  truncateCid,
} from './helpers.js';

import type { JSX } from 'react';

/**
 * Top-of-page header for the post-launch dashboard.
 *
 * Surfaces the SolverNet name (from manifest), live status badge, launcher
 * identity (Safe + agentId), and the lifecycle action buttons. Pause/Resume
 * is a single-click confirm; Retire requires a typed-name confirmation
 * surfaced via `PauseRetireDialog` — this component just dispatches
 * `onAction(target)` and lets the parent show the dialog.
 *
 * Action buttons appear/disappear per `record.status`:
 *   - launched → [Pause] + [Retire]
 *   - paused   → [Resume] + [Retire]
 *   - retired  → no actions (terminal)
 *   - launching → no actions, "Launching…" pill
 *   - failed   → no actions, "Failed" pill (the launch state machine carries
 *     the actionable details — operator follows up via the create flow)
 */

export interface StatusHeaderProps {
  record: LaunchedSolverNetRecord;
  manifest?: SolverNetManifestV1;
  /**
   * Number of distinct operators that have *ever* claimed a task on this
   * SolverNet (issue #351) — an all-time ever-participated count, including
   * tasks now finalized or refunded. `undefined` while the discovery query is
   * loading or after a discovery outage — the Operators field is omitted
   * rather than showing a misleading 0. The count reflects operators who have
   * *claimed a task*: an operator "join" in the app is a local config write
   * with no on-chain footprint (see
   * `spec/2026-05-05-solvernet-creation-and-launch.md` §12).
   */
  operatorCount?: number;
  /** Triggered when the operator clicks Pause / Resume / Retire. */
  onAction: (target: LifecycleTarget) => void;
  /** When a lifecycle transition is in flight, disable buttons + show pill. */
  pending?: LifecycleTarget | null;
}

const ACTION_LABELS: Record<LifecycleTarget, string> = {
  paused: 'Pause',
  launched: 'Resume',
  retired: 'Retire',
};

type BadgeVariant = NonNullable<Parameters<typeof Badge>[0]['variant']>;

const STATUS_BADGE: Record<LaunchedStatus, { variant: BadgeVariant; label: string }> = {
  launching: { variant: 'default', label: 'Launching' },
  launched: { variant: 'success', label: 'Launched' },
  paused: { variant: 'pill', label: 'Paused' },
  retired: { variant: 'outline', label: 'Retired' },
  failed: { variant: 'destructive', label: 'Failed' },
};

export function StatusHeader({
  record,
  manifest,
  operatorCount,
  onAction,
  pending,
}: StatusHeaderProps): JSX.Element {
  const badge = STATUS_BADGE[record.status] ?? STATUS_BADGE.launching;
  const allowed = ALLOWED_TRANSITIONS[record.status] ?? [];
  const name = manifest?.name ?? record.summary?.name ?? record.solverNetId;

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        data-testid="launcher-launched-status-header"
        data-status={record.status}
        role="region"
        aria-label="SolverNet status header"
        className="flex flex-col gap-4 p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <h1
                data-testid="launcher-launched-name"
                className="m-0 font-serif text-[32px] font-normal tracking-[-0.01em] text-foreground"
              >
                {name}
              </h1>
              <Badge
                data-testid="launcher-launched-status-badge"
                variant={badge.variant}
                className="whitespace-nowrap"
              >
                {badge.label}
              </Badge>
            </div>
            {manifest?.description && (
              <p className="m-0 max-w-[720px] text-[13px] leading-relaxed text-[var(--fg-muted)]">
                {manifest.description}
              </p>
            )}
          </div>
          <ActionButtons
            allowed={allowed}
            onAction={onAction}
            pending={pending ?? null}
            terminal={record.status === 'retired'}
            launching={record.status === 'launching'}
          />
        </div>

        <Separator />

        <dl className="m-0 grid gap-y-2 gap-x-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          <IdentityField
            label="SolverNet id"
            value={record.solverNetId}
            testid="launcher-launched-solvernet-id"
          />
          <IdentityField
            label="Manifest cid"
            value={truncateCid(record.manifestCid)}
            testid="launcher-launched-manifest-cid"
            additionalTestIds={['manifest-cid']}
            tooltip={record.manifestCid}
          />
          <IdentityField
            label="Launcher Safe"
            value={truncateAddress(record.launcherSafeAddress)}
            testid="launcher-launched-safe"
            tooltip={record.launcherSafeAddress}
          />
          <IdentityField
            label="Launcher agent"
            value={record.launcherAgentId}
            testid="launcher-launched-agent"
          />
          {operatorCount !== undefined && (
            <IdentityField
              label="Operators"
              value={String(operatorCount)}
              testid="launcher-launched-operator-count"
              additionalTestIds={['operator-count']}
              tooltip="Distinct operators that have ever claimed a task on this SolverNet, including on finalized or refunded tasks"
            />
          )}
        </dl>
      </Card>
    </TooltipProvider>
  );
}

interface IdentityFieldProps {
  label: string;
  value: string;
  testid?: string;
  /** Extra test-ids to alias this field's value — rendered as hidden spans. */
  additionalTestIds?: string[];
  tooltip?: string;
}

function IdentityField({
  label,
  value,
  testid,
  additionalTestIds,
  tooltip,
}: IdentityFieldProps): JSX.Element {
  const valueNode = (
    <dd
      data-testid={testid}
      className="m-0 truncate font-mono text-[13px] text-foreground"
      tabIndex={tooltip ? 0 : undefined}
    >
      {value}
      {additionalTestIds?.map((id) => (
        <span key={id} data-testid={id} className="hidden" aria-hidden="true">
          {value}
        </span>
      ))}
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

interface ActionButtonsProps {
  allowed: ReadonlyArray<LifecycleTarget>;
  onAction: (target: LifecycleTarget) => void;
  pending: LifecycleTarget | null;
  terminal: boolean;
  launching: boolean;
}

function ActionButtons({
  allowed,
  onAction,
  pending,
  terminal,
  launching,
}: ActionButtonsProps): JSX.Element | null {
  if (terminal) {
    return (
      <Badge
        data-testid="launcher-launched-terminal-pill"
        variant="outline"
        className="self-start whitespace-nowrap"
      >
        Retired — no further actions
      </Badge>
    );
  }
  if (launching) {
    return (
      <Badge
        data-testid="launcher-launched-launching-pill"
        variant="outline"
        className="self-start whitespace-nowrap border-primary text-primary"
      >
        Launching…
      </Badge>
    );
  }
  if (allowed.length === 0) return null;
  return (
    <div
      data-testid="launcher-launched-actions"
      className="flex flex-wrap gap-2 self-start"
    >
      {allowed.map((target) => {
        const label = ACTION_LABELS[target];
        const isPending = pending === target;
        const isDanger = target === 'retired';
        return (
          <Button
            key={target}
            type="button"
            variant={isDanger ? 'destructive' : 'default'}
            data-testid={`launcher-launched-action-${target}`}
            onClick={() => onAction(target)}
            disabled={pending !== null}
            className={pending !== null && !isPending ? 'opacity-60' : undefined}
          >
            {isPending ? `${label}…` : label}
          </Button>
        );
      })}
    </div>
  );
}
