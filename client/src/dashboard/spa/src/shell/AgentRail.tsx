import { Agent } from '../regions/Agent.js';

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
    <div
      className="agent-rail"
      style={{
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        height: '100%',
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          overflowWrap: 'anywhere',
        }}
      >
        Claude
      </span>
      <Agent agentGated={agentGated} />
    </div>
  );
}
