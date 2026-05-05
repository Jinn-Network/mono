import type { ReactNode } from 'react';
import { RestartPill } from './RestartPill.js';

/**
 * Label + control wrapper used inside Configuration sections. Optional
 * `restartRequired` flag surfaces a per-field RestartPill so the operator
 * sees which fields will trigger a daemon restart on save.
 */
export interface ConfigFieldProps {
  label: string;
  restartRequired?: boolean;
  helperText?: string;
  children: ReactNode;
}

export function ConfigField({ label, restartRequired, helperText, children }: ConfigFieldProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
        }}
      >
        {label}
        {restartRequired && <RestartPill />}
      </span>
      {children}
      {helperText && (
        <span style={{ fontSize: '11px', color: 'var(--fg-dim)', fontFamily: "'JetBrains Mono', monospace" }}>
          {helperText}
        </span>
      )}
    </div>
  );
}
