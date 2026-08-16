import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    }
    if (originalExecCommand) {
      Object.defineProperty(document, 'execCommand', originalExecCommand);
    } else {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

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
    expect(screen.queryByTestId('identity-master-address')).toBeNull();
    expect(screen.queryByTestId('identity-safe-address')).toBeNull();
    expect(screen.queryByRole('button', { name: /copy full master address/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /copy full safe address/i })).toBeNull();
  });

  it('copies the full Master address when clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(wrap(<IdentityCard {...defaultProps()} />));
    fireEvent.click(screen.getByRole('button', { name: /copy full master address/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(defaultProps().masterAddress),
    );
  });

  it('copies the full Safe address when clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(wrap(<IdentityCard {...defaultProps()} />));
    fireEvent.click(screen.getByRole('button', { name: /copy full safe address/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(defaultProps().safeAddress),
    );
  });

  it('falls back to execCommand copy when Clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const execCommand = vi.fn(() => {
      expect((document.activeElement as HTMLTextAreaElement).value).toBe(defaultProps().masterAddress);
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(wrap(<IdentityCard {...defaultProps()} />));
    fireEvent.click(screen.getByRole('button', { name: /copy full master address/i }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
  });

  it('falls back to execCommand copy when Clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => {
      expect((document.activeElement as HTMLTextAreaElement).value).toBe(defaultProps().safeAddress);
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(wrap(<IdentityCard {...defaultProps()} />));
    fireEvent.click(screen.getByRole('button', { name: /copy full safe address/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(defaultProps().safeAddress),
    );
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
  });

  it('does not report copied when execCommand fallback fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(wrap(<IdentityCard {...defaultProps()} />));
    fireEvent.click(screen.getByRole('button', { name: /copy full master address/i }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
    expect(screen.queryByText('Copied')).toBeNull();
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
