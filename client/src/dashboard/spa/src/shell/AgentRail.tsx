import { Agent } from '../regions/Agent.js';

import type { JSX } from 'react';

/**
 * Persistent right-rail Agent panel. Wraps the existing Agent region in a
 * column that flows naturally inside AppShell. The agent stays visible on
 * Overview, Operator, and Launcher so the operator's relationship with
 * Claude is continuous, not gated behind a tab.
 */
export interface AgentRailProps {
  agentGated?: boolean;
}

export function AgentRail({ agentGated }: AgentRailProps): JSX.Element {
  return (
    <div className="agent-rail flex h-full min-w-0 flex-col gap-3 overflow-hidden p-4">
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground [overflow-wrap:anywhere]">
        Claude
      </span>
      <Agent agentGated={agentGated} />
    </div>
  );
}
