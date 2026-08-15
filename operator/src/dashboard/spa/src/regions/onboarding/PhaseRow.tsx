import { type ReactNode, type JSX } from 'react';
import { cn } from '../../lib/utils.js';
import { PhaseStatusTag, type PhaseStatus } from './PhaseStatusTag.js';

export type Phase = 1 | 2 | 3 | 4;

const PHASE_TITLES: Record<Phase, string> = {
  1: 'Provisioning your wallet',
  2: 'Fund your wallet',
  3: 'Joining Jinn',
  // Step 4 confirms readiness; it does not "set up" anything. Wave-4 D1
  // removed the harness/model picker that used to live here — that choice is
  // configuration now (see regions/Onboarding.tsx).
  4: 'Check your harness',
};

/**
 * A single row in the Onboarding phase list. Renders the phase index, title,
 * and status tag, then expands its `children` body when the phase is
 * `active` or in an `error` state. Pulled out of the parent Onboarding
 * region as part of the C.7 shadcn split.
 */
export function PhaseRow({
  phase,
  status,
  children,
}: {
  phase: Phase;
  status: PhaseStatus;
  children: ReactNode;
}): JSX.Element {
  const isActive = status === 'active';
  const isError = status === 'error';
  const isDone = status === 'done';
  const expanded = isActive || isError;

  const indexColor = isError
    ? 'text-[var(--break-red)]'
    : isActive
      ? 'text-[var(--accent-gold)]'
      : isDone
        ? 'text-[var(--accent-sky)]'
        : 'text-[var(--fg-dim)]';
  const titleColor = isError || isActive
    ? 'text-foreground'
    : isDone
      ? 'text-[var(--fg-muted)]'
      : 'text-[var(--fg-dim)]';
  const titleType = expanded
    ? 'font-serif text-[28px] leading-[1.2]'
    : 'font-mono text-[14px] leading-[1.2]';

  return (
    <li
      className="phase-row border-t border-border"
      data-status={status}
      data-testid={`onboarding-phase-${phase}`}
    >
      <div className="grid grid-cols-[3rem_1fr_auto] items-baseline gap-4 py-4">
        <span
          className={cn(
            'font-mono text-xs tabular-nums tracking-[0.05em] transition-colors duration-200',
            indexColor,
          )}
        >
          {String(phase).padStart(2, '0')}
        </span>
        <span className={cn(titleType, titleColor, 'transition-colors duration-200')}>
          {PHASE_TITLES[phase]}
        </span>
        <PhaseStatusTag status={status} />
      </div>
      {expanded && children && (
        <div className="jinn-anim-fade-slide ml-12 pb-5 pr-2">{children}</div>
      )}
    </li>
  );
}
