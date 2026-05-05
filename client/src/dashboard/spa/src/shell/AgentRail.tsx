import { Agent } from '../regions/Agent.js';

/**
 * Persistent right-rail Agent panel. Wraps the existing Agent region in a
 * column that flows naturally inside AppShell. The agent stays visible on
 * both Overview and Configuration so the operator's relationship with
 * Claude is continuous, not gated behind a tab.
 */
export interface AgentRailProps {
  agentGated?: boolean;
}

export function AgentRail({ agentGated }: AgentRailProps): JSX.Element {
  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }}>
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
        Claude
      </span>
      <Agent agentGated={agentGated} />
    </div>
  );
}
