import type { ReactNode } from 'react';

/**
 * Shared step-level layout primitives for the Create wizard.
 *
 * Each step component renders its body inside `<StepShell>` so we get
 * consistent header / nav / error chrome without re-implementing it five
 * times. The wizard parent (`LauncherCreate.tsx`) owns the state machine;
 * each step only worries about its own form.
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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--fg-muted)',
      }}
    >
      <span data-testid="launcher-create-step-counter">
        Step {current} of {total}
      </span>
      <div
        style={{
          display: 'flex',
          gap: '4px',
          flex: 1,
          maxWidth: '320px',
        }}
      >
        {Array.from({ length: total }).map((_, idx) => {
          const i = idx + 1;
          const filled = i <= current;
          return (
            <span
              key={i}
              data-testid={`launcher-create-progress-pip-${i}`}
              data-filled={filled ? 'true' : 'false'}
              style={{
                flex: 1,
                height: '3px',
                background: filled ? 'var(--accent-sky)' : 'var(--border)',
                borderRadius: 'var(--radius-1)',
              }}
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
      style={{
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        maxWidth: '720px',
        margin: '0 auto',
      }}
    >
      <StepProgress current={step} total={total} />
      <header style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <h1
          style={{
            fontFamily: "'Instrument Serif', 'Times New Roman', serif",
            fontSize: '32px',
            margin: 0,
            color: 'var(--fg)',
            fontWeight: 400,
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h1>
        {blurb && (
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '14px', lineHeight: 1.5 }}>
            {blurb}
          </p>
        )}
      </header>
      {error && (
        <div
          data-testid="launcher-create-error"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '12px 16px',
            color: 'var(--break-red)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '13px',
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>{children}</div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          paddingTop: '12px',
          borderTop: '1px solid var(--border)',
        }}
      >
        {footer}
      </div>
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
          <button
            type="button"
            data-testid="launcher-create-back"
            onClick={onBack}
            disabled={busy}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              padding: '10px 18px',
              background: 'transparent',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2)',
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            Back
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        {right}
        {onNext && (
          <button
            type="button"
            data-testid="launcher-create-next"
            onClick={onNext}
            disabled={nextDisabled || busy}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              padding: '10px 22px',
              background:
                nextDisabled || busy ? 'var(--bg-elevated)' : 'var(--accent-sky)',
              color: nextDisabled || busy ? 'var(--fg-dim)' : 'var(--bg-sunken)',
              border: '1px solid var(--accent-sky)',
              borderRadius: 'var(--radius-2)',
              cursor: nextDisabled || busy ? 'not-allowed' : 'pointer',
              opacity: nextDisabled || busy ? 0.6 : 1,
            }}
          >
            {nextLabel}
          </button>
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
}

/**
 * Form-field wrapper for the Create wizard. Reuses the visual rhythm of
 * `<ConfigField>` but with inline error rendering — Operator configuration's pattern
 * surfaces errors at the section footer, the wizard surfaces per-field.
 */
export function FieldShell({ label, helperText, error, children }: FieldShellProps): JSX.Element {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
        {label}
      </span>
      {children}
      {error ? (
        <span
          style={{
            fontSize: '12px',
            color: 'var(--break-red)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {error}
        </span>
      ) : (
        helperText && (
          <span
            style={{
              fontSize: '11px',
              color: 'var(--fg-dim)',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {helperText}
          </span>
        )
      )}
    </label>
  );
}

import type { CSSProperties } from 'react';

const inputBase: CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  padding: '10px 12px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '13px',
  color: 'var(--fg)',
  width: '100%',
  boxSizing: 'border-box',
};

export const inputStyle: CSSProperties = inputBase;

export const inputErrorStyle: CSSProperties = {
  ...inputBase,
  border: '1px solid var(--break-red)',
};
