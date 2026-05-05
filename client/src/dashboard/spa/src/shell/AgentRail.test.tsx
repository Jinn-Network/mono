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
    expect(screen.getByText(/claude/i)).toBeTruthy();
    expect(screen.getByTestId('agent-stub')).toBeTruthy();
  });
});
