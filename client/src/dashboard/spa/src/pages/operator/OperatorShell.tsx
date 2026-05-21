import type { ReactNode } from 'react';

/**
 * Shell wrapper for /operator/* sub-routes.
 * Task 5.1 stub — renders children only.
 * Task 5.2 will add <OperatorSubNav /> and the sidebar layout.
 */
export function OperatorShell({ children }: { children: ReactNode }): JSX.Element {
  return <div data-testid="operator-shell">{children}</div>;
}
