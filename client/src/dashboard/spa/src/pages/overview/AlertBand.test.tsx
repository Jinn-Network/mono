import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { AlertBand } from './AlertBand.js';

describe('AlertBand', () => {
  it('renders the lead, body, and a deep-link CTA', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <AlertBand
          lead="Needs attention"
          body="Prediction is disabled"
          ctaLabel="Configure prediction"
          ctaHref="/operator#solvernets/prediction"
        />
      </Router>,
    );
    expect(screen.getByText(/needs attention/i)).toBeTruthy();
    expect(screen.getByText(/prediction is disabled/i)).toBeTruthy();
    const cta = screen.getByText(/configure prediction/i).closest('a');
    expect(cta?.getAttribute('href')).toBe('/operator#solvernets/prediction');
  });

  it('renders nothing when not active', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    const { container } = render(
      <Router hook={hook}>
        <AlertBand active={false} lead="" body="" ctaLabel="" ctaHref="" />
      </Router>,
    );
    expect(container.textContent).toBe('');
  });
});
