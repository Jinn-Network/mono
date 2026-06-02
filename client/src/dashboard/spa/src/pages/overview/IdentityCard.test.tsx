import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { IdentityCard, type IdentityCardProps } from './IdentityCard.js';

import type { JSX } from 'react';

const retryAgentBindingMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    retryAgentBinding: (opts: { serviceIndex: number }) => retryAgentBindingMock(opts),
  },
}));

function defaultProps(): IdentityCardProps {
  return {
    masterAddress: '0x53e25264C86db85b6168F7824f5c39abd5281787',
    agentAddress: null,
    safeAddress: '0x26e90000000000000000000000000000000000638',
    serviceId: 50,
    agentId: 5879,
    services: [],
  };
}

function wrap(ui: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/overview' });
  return <Router hook={hook}>{ui}</Router>;
}

describe('IdentityCard', () => {
  it('exposes data-testid="identity-card" on the root region', () => {
    render(wrap(<IdentityCard {...defaultProps()} />));
    expect(screen.getByTestId('identity-card')).toBeTruthy();
  });

  it('renders all five identity stats with truncated addresses and #-prefixed ids', () => {
    render(wrap(<IdentityCard {...defaultProps()} />));
    const card = screen.getByTestId('identity-card');
    expect(card.textContent).toMatch(/identity/i);
    expect(card.textContent).toMatch(/service/i);
    expect(card.textContent).toContain('#50');
    expect(card.textContent).toMatch(/agent/i);
    expect(card.textContent).toContain('#5879');
    expect(card.textContent).toMatch(/master/i);
    expect(card.textContent).toContain('0x53e2');
    expect(card.textContent).toContain('1787');
    expect(card.textContent).toMatch(/safe/i);
    expect(card.textContent).toContain('0x26e9');
    expect(card.textContent).toContain('0638');
  });

  it('renders em-dash placeholders when ids or addresses are null', () => {
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          masterAddress={null}
          safeAddress={null}
          serviceId={null}
          agentId={null}
        />,
      ),
    );
    const card = screen.getByTestId('identity-card');
    // Four '—' placeholders, one per missing stat.
    expect(card.querySelectorAll('[data-testid="identity-stat-empty"]').length).toBe(4);
  });

  it('surfaces a binding-pending chip when a service has agentId but is not bound', () => {
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          services={[
            { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: false },
          ]}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /binding pending/i })).toBeTruthy();
  });

  it('does not surface a binding-pending chip when all services are bound', () => {
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          services={[
            { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: true },
          ]}
        />,
      ),
    );
    expect(screen.queryByRole('button', { name: /binding pending/i })).toBeNull();
  });

  it('invokes api.retryAgentBinding with the unbound service index when Retry binding is clicked', async () => {
    retryAgentBindingMock.mockReset();
    retryAgentBindingMock.mockResolvedValue({ attempts: [{ status: 'success' }] });
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          services={[
            { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: false },
          ]}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /binding pending/i }));
    fireEvent.click(screen.getByRole('button', { name: /retry binding/i }));
    await waitFor(() =>
      expect(retryAgentBindingMock).toHaveBeenCalledWith({ serviceIndex: 0 }),
    );
  });

  it('renders the safe-not-bound state-message row when a service is unbound', () => {
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          services={[
            { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: false },
          ]}
        />,
      ),
    );
    expect(screen.getByTestId('identity-state-message-safe-not-bound')).toBeTruthy();
  });

  it('renders the agent-id-not-minted state-message row when agentId is null', () => {
    render(wrap(<IdentityCard {...defaultProps()} agentId={null} />));
    expect(screen.getByTestId('identity-state-message-agent-id-not-minted')).toBeTruthy();
  });
});
