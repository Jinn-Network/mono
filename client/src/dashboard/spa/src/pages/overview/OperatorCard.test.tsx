import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OperatorCard } from './OperatorCard.js';

describe('OperatorCard', () => {
  it('renders operator-side state with a single Solver role and a deep-link', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <OperatorCard
          name="prediction"
          configId="prediction"
          roles={['solving']}
          state="live"
          waitingMessage="Waiting for Tasks. SolverNet active, Harness loaded."
        />
      </Router>,
    );
    expect(screen.getByText(/your prediction/i)).toBeTruthy();
    expect(screen.getByText(/^solver$/i)).toBeTruthy();
    expect(screen.queryByText(/^evaluator$/i)).toBeNull();
    expect(screen.getByText(/live/i)).toBeTruthy();
    expect(screen.getByText(/waiting for tasks/i)).toBeTruthy();
    const link = screen.getByText(/configure/i).closest('a');
    expect(link?.getAttribute('href')).toBe('/operator#solvernets/prediction');
  });

  it('renders both Solver and Evaluator pills when both roles are active', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <OperatorCard
          name="prediction"
          roles={['solving', 'evaluating']}
          state="live"
        />
      </Router>,
    );
    expect(screen.getByText(/^solver$/i)).toBeTruthy();
    expect(screen.getByText(/^evaluator$/i)).toBeTruthy();
    // Plural label when more than one role is active.
    expect(screen.getByText(/^roles$/i)).toBeTruthy();
  });

  it('uses the stable config id for joined SolverNet deep-links', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <OperatorCard
          name="SWE-rebench v2"
          configId="bafkreiswe"
          roles={['solving', 'evaluating']}
          state="live"
        />
      </Router>,
    );
    const link = screen.getByText(/configure/i).closest('a');
    expect(link?.getAttribute('href')).toBe('/operator#solvernets/bafkreiswe');
  });
});
