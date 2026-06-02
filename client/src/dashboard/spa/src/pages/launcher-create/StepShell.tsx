import type { ReactNode, JSX } from 'react';
import { Button } from '../../components/ui/button.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Label } from '../../components/ui/label.js';
import { Separator } from '../../components/ui/separator.js';
import { cn } from '../../lib/utils.js';

/**
 * Shared step-level layout primitives for the Create wizard.
 *
 * Each step component renders its body inside `<StepShell>` so we get
 * consistent header / nav / error chrome without re-implementing it five
 * times. The wizard parent (`LauncherCreate.tsx`) owns the state machine;
 * each step only worries about its own form.
 *
 * Migrated to shadcn primitives:
 *   - `<Button>` for Back / Next (replacing bespoke native-button styling)
 *   - `<Alert variant="blocking">` for the top-level error banner
 *   - `<Separator>` for the footer divider
 *   - `<Label>` (composed via `FieldShell`) for field eyebrow labels
 */

export const STEP_LABELS: ReadonlyArray<string> = [
  'Define',
  'Review contract',
  'Configure generator',
  'Configure pricing',
  'Review & launch',
];

export interface StepProgressProps {
  /** 1-based current step. */
  current: number;
  total?: number;
}

export function StepProgress({ current, total = 5 }: StepProgressProps): JSX.Element {
  return (
    <div
      data-testid="launcher-create-progress"
      className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-muted"
    >
      <span data-testid="launcher-create-step-counter">
        Step {current} of {total}
      </span>
      <div className="flex max-w-[320px] flex-1 gap-1">
        {Array.from({ length: total }).map((_, idx) => {
          const i = idx + 1;
          const filled = i <= current;
          return (
            <span
              key={i}
              data-testid={`launcher-create-progress-pip-${i}`}
              data-filled={filled ? 'true' : 'false'}
              className={cn(
                'h-[3px] flex-1 rounded-sm',
                filled ? 'bg-accent-sky' : 'bg-border',
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

export interface StepShellProps {
  step: number;
  total?: number;
  title: string;
  blurb?: string;
  children: ReactNode;
  /**
   * Footer overrides — the parent wizard renders Back / Next; tests assert
   * against the raw button labels (`Back`, `Next`, `Launch`).
   */
  footer: ReactNode;
  /** Top-level error banner shown above the body. */
  error?: string | null;
}

export function StepShell({
  step,
  total = 5,
  title,
  blurb,
  children,
  footer,
  error,
}: StepShellProps): JSX.Element {
  return (
    <main
      data-testid={`launcher-create-step-${step}`}
      className="mx-auto flex max-w-[720px] flex-col gap-5 p-6"
    >
      <StepProgress current={step} total={total} />
      <header className="flex flex-col gap-1.5">
        <h1 className="m-0 font-serif text-[32px] font-normal leading-tight tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {blurb && (
          <p className="m-0 text-[14px] leading-relaxed text-fg-muted">
            {blurb}
          </p>
        )}
      </header>
      {error && (
        <Alert
          variant="blocking"
          data-testid="launcher-create-error"
          className="font-mono text-[13px]"
        >
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-4">{children}</div>
      <Separator />
      <div className="flex items-center justify-between gap-3">{footer}</div>
    </main>
  );
}

export interface StepNavProps {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
  /** Right-aligned slot, e.g. for Step 5's launch progress text. */
  right?: ReactNode;
}

export function StepNav({
  onBack,
  onNext,
  nextLabel = 'Next',
  nextDisabled = false,
  busy = false,
  right,
}: StepNavProps): JSX.Element {
  return (
    <>
      <div>
        {onBack && (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            data-testid="launcher-create-back"
            onClick={onBack}
            disabled={busy}
          >
            Back
          </Button>
        )}
      </div>
      <div className="flex items-center gap-4">
        {right}
        {onNext && (
          <Button
            type="button"
            size="lg"
            data-testid="launcher-create-next"
            onClick={onNext}
            disabled={nextDisabled || busy}
          >
            {nextLabel}
          </Button>
        )}
      </div>
    </>
  );
}

export interface FieldShellProps {
  label: string;
  helperText?: string;
  error?: string | null;
  children: ReactNode;
  /**
   * When `true` (the default) the wrapper renders as a `<label>`, which
   * delegates click + focus to the inner input — appropriate for the
   * single-input cases used by Steps 1, 3, and 4. Set `false` when the
   * children contain multiple focusable controls (Step 5's role
   * checkboxes) and the implicit-label association would mis-route
   * clicks.
   */
  asLabel?: boolean;
}

/**
 * Form-field wrapper for the Create wizard. Reuses the shadcn `<Label>`
 * eyebrow plus an inline hint/error line. Operator configuration's
 * pattern surfaces errors at the section footer; the wizard surfaces
 * per-field for clearer step-by-step feedback.
 */
export function FieldShell({
  label,
  helperText,
  error,
  children,
  asLabel = true,
}: FieldShellProps): JSX.Element {
  const body = (
    <>
      <Label>{label}</Label>
      {children}
      {error ? (
        <span className="font-mono text-[12px] text-break-red">{error}</span>
      ) : (
        helperText && (
          <span className="font-mono text-[11px] text-fg-dim">
            {helperText}
          </span>
        )
      )}
    </>
  );
  if (asLabel) {
    return <label className="flex flex-col gap-1.5">{body}</label>;
  }
  return <div className="flex flex-col gap-1.5">{body}</div>;
}
