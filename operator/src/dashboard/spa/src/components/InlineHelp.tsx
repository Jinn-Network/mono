import { useState, type JSX } from 'react';
import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

/**
 * Expandable inline help. A small "i" trigger sits next to a field label;
 * clicking it reveals a short decision-context panel without leaving the
 * form (Issue #334 — operators were choosing roles / harnesses / plug-ins
 * with no trade-off context).
 *
 * Backed by shadcn `<Popover>` so focus management, click-outside, and
 * Escape-to-close come from Radix. The panel carries the *short* answer;
 * the full long-form copy lives in `operator/docs/operator/join-form-context.md`,
 * and `docHref` points the operator there for the complete picture.
 */
export interface InlineHelpProps {
  /** Accessible label for the trigger, e.g. "Roles help". */
  label: string;
  /** Short decision-context copy shown in the popover panel. */
  children: React.ReactNode;
  /** Optional link to the long-form doc section. */
  docHref?: string;
  /** Visible text for the doc link. Defaults to "Read more". */
  docLabel?: string;
}

export function InlineHelp({
  label,
  children,
  docHref,
  docLabel = 'Read more',
}: InlineHelpProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Radix `<PopoverTrigger>` auto-wires aria-controls / aria-expanded /
          aria-haspopup to the panel — no manual useId()/aria-controls needed. */}
      <PopoverTrigger
        type="button"
        data-testid="inline-help-trigger"
        aria-label={label}
        className="inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-md border border-muted-foreground bg-card p-0 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Info className="h-2.5 w-2.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        data-testid="inline-help-panel"
        role="note"
        align="start"
        className="max-w-[420px] whitespace-pre-line font-mono text-[11px] font-normal leading-relaxed normal-case tracking-normal text-muted-foreground"
      >
        {children}
        {docHref && (
          <>
            {' '}
            <a
              data-testid="inline-help-doc-link"
              href={docHref}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {docLabel}
            </a>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
