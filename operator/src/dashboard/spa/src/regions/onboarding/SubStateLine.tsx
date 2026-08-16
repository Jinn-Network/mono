import { cn } from '../../lib/utils.js';

import type { JSX } from 'react';

/**
 * Status line shown beneath the active Phase 3 row while the bootstrapper
 * is working through its remaining sub-steps (service deploy, agent
 * registration, identity binding). Pulled out of the parent Onboarding
 * region as part of the C.7 shadcn split.
 */
export function SubStateLine({
  label,
  step,
  serviceIndex,
  serviceId,
  safeAddress,
  explorer,
  contractRevertReason,
}: {
  label: string;
  step: string;
  serviceIndex?: number;
  serviceId?: number;
  safeAddress?: string;
  explorer: string;
  /** Decoded contract revert reason from a failed setAgentWallet call, if any. */
  contractRevertReason?: string | null;
}): JSX.Element {
  const hasRevertReason = Boolean(contractRevertReason);
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-md border bg-[var(--bg-elevated)] px-4 py-3',
        hasRevertReason ? 'border-[var(--break-red)]' : 'border-border',
      )}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'jinn-anim-pulse h-1.5 w-1.5 rounded-full',
            hasRevertReason ? 'bg-[var(--break-red)]' : 'bg-[var(--accent-sky)]',
          )}
        />
        <span className="font-mono text-sm text-foreground">{label}</span>
        <span
          className={cn(
            'ml-auto font-mono text-[10px]',
            hasRevertReason ? 'text-[var(--break-red)]' : 'text-[var(--fg-dim)]',
          )}
        >
          {hasRevertReason ? 'binding failed · will retry' : 'running · no action needed'}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--fg-muted)] md:grid-cols-[120px_1fr]">
        <span className="text-[var(--fg-dim)]">Current step</span>
        <span>{formatOperatorStep(step)}</span>
        {serviceIndex !== undefined && (
          <>
            <span className="text-[var(--fg-dim)]">Service</span>
            <span>
              #{serviceIndex}
              {serviceId !== undefined ? ` · id ${serviceId}` : ''}
            </span>
          </>
        )}
        {safeAddress && (
          <>
            <span className="text-[var(--fg-dim)]">Safe</span>
            <a
              href={`${explorer}/address/${safeAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-[var(--accent-sky)] hover:underline"
            >
              {safeAddress}
            </a>
          </>
        )}
        {contractRevertReason && (
          <>
            <span className="text-[var(--fg-dim)]">Contract revert reason</span>
            <code className="break-words text-xs text-[var(--break-red)]">
              {contractRevertReason}
            </code>
          </>
        )}
      </div>
    </div>
  );
}

function formatOperatorStep(step: string): string {
  return step
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
