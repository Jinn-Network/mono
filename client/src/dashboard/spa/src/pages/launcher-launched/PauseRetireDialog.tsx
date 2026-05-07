import { useEffect, useState } from 'react';
import type { LifecycleTarget } from '../../api/types.js';

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
}: PauseRetireDialogProps): JSX.Element | null {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) setTyped('');
  }, [open, target]);

  if (!open) return null;

  const copy = TARGET_COPY[target];
  const requiresType = target === 'retired';
  const typeMatches = !requiresType || typed.trim() === solverNetName.trim();
  const confirmDisabled = pending || !typeMatches;

  return (
    <div
      data-testid="launcher-launched-dialog"
      data-target={target}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 100,
      }}
      onClick={(e) => {
        // Click outside the dialog body cancels.
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: `1px solid ${copy.danger ? 'var(--break-red)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-3)',
          padding: '24px 26px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          maxWidth: '480px',
          width: '100%',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontFamily: "'Instrument Serif', 'Times New Roman', serif",
            fontSize: '24px',
            color: copy.danger ? 'var(--break-red)' : 'var(--fg)',
            fontWeight: 400,
          }}
        >
          {copy.title}
        </h2>
        <p
          style={{
            margin: 0,
            color: 'var(--fg-muted)',
            fontSize: '13px',
            lineHeight: 1.5,
          }}
        >
          {copy.body}
        </p>

        {requiresType && (
          <label
            style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
              }}
            >
              Type <span style={{ color: 'var(--fg)' }}>{solverNetName}</span> to confirm
            </span>
            <input
              data-testid="launcher-launched-dialog-typed"
              type="text"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={pending}
              style={{
                background: 'var(--bg)',
                border: `1px solid ${typeMatches ? 'var(--vow-green)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-2)',
                padding: '10px 12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '13px',
                color: 'var(--fg)',
              }}
            />
          </label>
        )}

        {errorMessage && (
          <span
            data-testid="launcher-launched-dialog-error"
            style={{
              color: 'var(--break-red)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
            }}
          >
            {errorMessage}
          </span>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            data-testid="launcher-launched-dialog-cancel"
            onClick={onCancel}
            disabled={pending}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              padding: '10px 16px',
              background: 'transparent',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2)',
              cursor: pending ? 'wait' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="launcher-launched-dialog-confirm"
            onClick={onConfirm}
            disabled={confirmDisabled}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              padding: '10px 18px',
              background: copy.danger
                ? confirmDisabled
                  ? 'var(--bg-elevated)'
                  : 'var(--break-red)'
                : confirmDisabled
                  ? 'var(--bg-elevated)'
                  : 'var(--accent-sky)',
              color: confirmDisabled
                ? 'var(--fg-dim)'
                : copy.danger
                  ? 'var(--bg-sunken)'
                  : 'var(--bg-sunken)',
              border: `1px solid ${copy.danger ? 'var(--break-red)' : 'var(--accent-sky)'}`,
              borderRadius: 'var(--radius-2)',
              cursor: confirmDisabled ? 'not-allowed' : 'pointer',
              opacity: confirmDisabled ? 0.6 : 1,
            }}
          >
            {pending ? `${copy.confirmLabel}…` : copy.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
