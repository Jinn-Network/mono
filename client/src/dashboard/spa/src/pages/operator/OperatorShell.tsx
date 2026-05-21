import type { ReactNode } from 'react';
import { OperatorSubNav } from './OperatorSubNav.js';

/**
 * Shell wrapper for /operator/* sub-routes.
 * Renders <OperatorSubNav /> in a left sidebar alongside the page content.
 */
export function OperatorShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      data-testid="operator-shell"
      style={{
        display: 'flex',
        gap: '24px',
        padding: '24px',
        alignItems: 'flex-start',
      }}
    >
      <OperatorSubNav />
      <div style={{ flex: '1 1 0', minWidth: 0 }}>{children}</div>
    </div>
  );
}
