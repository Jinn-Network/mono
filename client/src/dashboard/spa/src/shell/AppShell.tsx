import type { ReactNode } from 'react';

/**
 * Three-region grid for the running-mode operator dashboard. The header +
 * tabs span both columns; the main outlet flows in the left column; the
 * agent rail is sticky on the right. Onboarding still owns the screen
 * before bootstrap completes.
 */
export interface AppShellProps {
  header: ReactNode;
  tabs: ReactNode;
  rail: ReactNode;
  children: ReactNode;
}

export function AppShell({ header, tabs, rail, children }: AppShellProps): JSX.Element {
  return (
    <div
      className="w-full"
      style={{
        background: 'var(--bg)',
        color: 'var(--fg)',
        display: 'grid',
        gridTemplateRows: 'auto auto minmax(0, 1fr)',
        gridTemplateColumns: '1fr 320px',
        // Lock the outer shell to the viewport so internal regions (main,
        // aside) can scroll independently. Without this, the agent rail's
        // xterm scrollback expands the document height past 800kpx and the
        // page becomes unscrollable in any meaningful way.
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--border)' }}>
        {header}
      </div>
      <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--border)' }}>
        {tabs}
      </div>
      <main style={{ overflowY: 'auto', minHeight: 0 }}>{children}</main>
      <aside
        style={{
          borderLeft: '1px solid var(--border)',
          overflowY: 'auto',
          minHeight: 0,
          height: '100%',
        }}
      >
        {rail}
      </aside>
    </div>
  );
}
