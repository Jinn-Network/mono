import type { ReactNode, JSX } from 'react';
import { OperatorSubNav } from './OperatorSubNav.js';

/**
 * Shell wrapper for /operator/* sub-routes.
 * Renders <OperatorSubNav /> in a left sidebar alongside the page content.
 */
export function OperatorShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-testid="operator-shell" className="flex items-start gap-6 p-6">
      <OperatorSubNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
