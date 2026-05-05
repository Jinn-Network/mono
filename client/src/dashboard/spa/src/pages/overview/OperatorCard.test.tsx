import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OperatorCard } from './OperatorCard.js';

describe('OperatorCard', () => {
  it('renders operator-side state and a deep-link, no public counters', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <OperatorCard
          name="prediction"
          role="solving"
          state="live"
          waitingMessage="Waiting for Tasks. SolverNet active, Harness loaded."
        />
      </Router>,
    );
    expect(screen.getByText(/your prediction/i)).toBeTruthy();
    expect(screen.getByText(/solving/i)).toBeTruthy();
    expect(screen.getByText(/live/i)).toBeTruthy();
    expect(screen.getByText(/waiting for tasks/i)).toBeTruthy();
    const link = screen.getByText(/configure/i).closest('a');
    expect(link?.getAttribute('href')).toBe('/configuration#solvernets/prediction');
  });
});
