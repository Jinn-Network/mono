import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentRail } from './AgentRail.js';

vi.mock('../regions/Agent.js', () => ({
  Agent: ({ agentGated }: { agentGated?: boolean }) => (
    <div data-testid="agent-stub" data-agent-gated={String(agentGated ?? false)}>
      agent
    </div>
  ),
}));

describe('AgentRail', () => {
  it('renders the Claude eyebrow + Agent placeholder', () => {
    render(<AgentRail agentGated={false} />);
    const eyebrow = screen.getByText(/claude/i);
    expect(eyebrow).toBeTruthy();
    expect(eyebrow.parentElement?.classList.contains('agent-rail')).toBe(true);
    expect(screen.getByTestId('agent-stub')).toBeTruthy();
  });
});
