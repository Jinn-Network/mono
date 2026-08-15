import type { CaptureSummary } from '../../../../api/contract/index.js';
import { Button } from '../components/ui/button.js';
import { cn } from '../lib/utils.js';

import type { JSX } from 'react';

export interface CapturesListProps {
  captures: CaptureSummary[];
  selectedSessionId?: string;
  onSelect: (sessionId: string) => void;
}

/**
 * CapturesList — stack of selectable capture rows.
 *
 * Each row is a `<Button variant="ghost">` styled as a left-aligned card.
 * The active row gets a primary left-border accent — matches the
 * ActivityCard "joined SolverNets" pattern.
 */
export function CapturesList({
  captures,
  selectedSessionId,
  onSelect,
}: CapturesListProps): JSX.Element {
  if (captures.length === 0) {
    return (
      <div className="p-6 font-mono text-[12px] text-muted-foreground">
        No pending execution data.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {captures.map((capture) => {
        const active = capture.sessionId === selectedSessionId;
        return (
          <Button
            key={capture.sessionId}
            variant="ghost"
            data-state={active ? 'active' : undefined}
            aria-current={active ? 'true' : undefined}
            onClick={() => onSelect(capture.sessionId)}
            className={cn(
              'flex h-auto w-full flex-col items-stretch gap-1.5 rounded-md border border-border bg-card px-4 py-3 text-left font-mono text-[12px] normal-case tracking-normal hover:bg-accent',
              active && 'border-primary bg-primary/[0.06]',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <strong className="min-w-0 truncate font-medium text-foreground">
                {capture.originatingTool.name}
              </strong>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {capture.capturePath}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {capture.repoRemoteUrl ?? 'No repo'} · {capture.spanCount} spans ·{' '}
              {capture.redactedSpanCount} redacted
            </div>
          </Button>
        );
      })}
    </div>
  );
}
