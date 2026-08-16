import { useEffect, useState, type JSX } from 'react';
import type { LifecycleTarget } from '../../../../../api/contract/index.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { cn } from '../../lib/utils.js';

/**
 * Confirmation dialog for lifecycle transitions.
 *
 * Two flavors per spec §10 / Decision 11:
 *
 *   - Pause / Resume — single-click confirm. The dialog explains the
 *     consequences ("existing Tasks continue normally" / "the generator will
 *     resume polling"); Confirm is enabled the moment the dialog opens.
 *
 *   - Retire — typed-name match. The operator must type the exact manifest
 *     name into a text field; the Confirm button is disabled until the input
 *     matches. This guards against accidental retirement of a working
 *     SolverNet, which is irreversible at the registry level.
 *
 * The dialog is a controlled overlay — the parent decides when it's open and
 * supplies the `target` lifecycle action. `onConfirm` is fired only when
 * confirmation passes; the parent handles the actual API call and refetch.
 *
 * Built on shadcn `AlertDialog` (radix). Backdrop click + Escape route
 * through `onOpenChange`, which fires `onCancel` unless an action is pending.
 */

export interface PauseRetireDialogProps {
  open: boolean;
  target: LifecycleTarget;
  /** Manifest name — required for the Retire typed-confirmation. */
  solverNetName: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  errorMessage?: string;
}

const TARGET_COPY: Record<
  LifecycleTarget,
  { title: string; body: string; confirmLabel: string; danger?: boolean }
> = {
  paused: {
    title: 'Pause SolverNet',
    body:
      'The generator will stop posting new Tasks. Existing Tasks continue through their normal lifecycle. You can resume any time.',
    confirmLabel: 'Pause',
  },
  launched: {
    title: 'Resume SolverNet',
    body:
      'The generator will resume polling and posting new Tasks at the configured cadence.',
    confirmLabel: 'Resume',
  },
  retired: {
    title: 'Retire SolverNet',
    body:
      'Retirement is permanent. The SolverNet stops accepting new work and disappears from the operator catalog. Historical Tasks, solutions, and verdicts remain discoverable. Type the SolverNet name to confirm.',
    confirmLabel: 'Retire permanently',
    danger: true,
  },
};

export function PauseRetireDialog({
  open,
  target,
  solverNetName,
  onConfirm,
  onCancel,
  pending = false,
  errorMessage,
}: PauseRetireDialogProps): JSX.Element {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) setTyped('');
  }, [open, target]);

  const copy = TARGET_COPY[target];
  const requiresType = target === 'retired';
  // Compare case-insensitively: the label renders the name with
  // `text-transform: uppercase` in CSS, so the operator types what they see
  // (all-caps) but the underlying name may have mixed case.  Lowercasing both
  // sides collapses the mismatch without altering the displayed label.
  const typeMatches =
    !requiresType || typed.trim().toLowerCase() === solverNetName.trim().toLowerCase();
  const confirmDisabled = pending || !typeMatches;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <AlertDialogContent
        data-testid="launcher-launched-dialog"
        data-target={target}
        className={cn('gap-4', copy.danger && 'border-destructive')}
      >
        <AlertDialogHeader>
          <AlertDialogTitle
            className={cn(copy.danger && 'text-destructive')}
          >
            {copy.title}
          </AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>

        {requiresType && (
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="launcher-launched-dialog-typed"
              className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]"
            >
              Type{' '}
              <span className="text-foreground">{solverNetName}</span> to
              confirm
            </Label>
            <Input
              id="launcher-launched-dialog-typed"
              data-testid="launcher-launched-dialog-typed"
              type="text"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={pending}
              // var(--vow-green) is unmapped in tailwind config (no shadcn
              // equivalent); used here to mark a positive typed-name match.
              className={cn(typeMatches && 'border-[var(--vow-green)]')}
            />
          </div>
        )}

        {errorMessage && (
          <span
            data-testid="launcher-launched-dialog-error"
            className="font-mono text-[12px] text-destructive"
          >
            {errorMessage}
          </span>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="launcher-launched-dialog-cancel"
            onClick={(e) => {
              e.preventDefault();
              onCancel();
            }}
            disabled={pending}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="launcher-launched-dialog-confirm"
            onClick={(e) => {
              if (confirmDisabled) {
                e.preventDefault();
                return;
              }
              e.preventDefault();
              onConfirm();
            }}
            disabled={confirmDisabled}
            className={cn(
              copy.danger &&
                'border border-destructive bg-transparent text-destructive hover:bg-[var(--severity-blocking-bg)]',
            )}
          >
            {pending ? `${copy.confirmLabel}…` : copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
