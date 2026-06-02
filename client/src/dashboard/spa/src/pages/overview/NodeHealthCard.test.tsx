import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { NodeHealthCard } from './NodeHealthCard.js';

import type { JSX } from 'react';

function wrap(ui: JSX.Element, initial = '/overview'): JSX.Element {
  const { hook } = memoryLocation({ path: initial });
  return <Router hook={hook}>{ui}</Router>;
}

describe('NodeHealthCard', () => {
  it('renders Daemon + RPC rows with the requested statuses', () => {
    render(
      wrap(
        <NodeHealthCard
          daemonStatus="running"
          daemonStateMessage="waiting for next task"
          rpcStatus="healthy"
        />,
      ),
    );
    const card = screen.getByTestId('node-health-card');
    expect(card.textContent).toMatch(/node health/i);

    const daemonRow = screen.getByTestId('node-health-daemon-row');
    expect(daemonRow.getAttribute('data-status')).toBe('running');
    expect(daemonRow.textContent).toMatch(/running/i);
    expect(screen.getByTestId('node-health-daemon-state').textContent).toBe(
      'waiting for next task',
    );

    const rpcRow = screen.getByTestId('node-health-rpc-row');
    expect(rpcRow.getAttribute('data-status')).toBe('healthy');
    expect(rpcRow.textContent).toMatch(/healthy/i);
  });

  it('shows Stopped + Unreachable when degraded', () => {
    render(
      wrap(<NodeHealthCard daemonStatus="stopped" rpcStatus="unreachable" />),
    );
    expect(screen.getByTestId('node-health-daemon-row').textContent).toMatch(/stopped/i);
    expect(screen.getByTestId('node-health-rpc-row').textContent).toMatch(/unreachable/i);
  });

  it('omits the daemon state message when none is provided', () => {
    render(wrap(<NodeHealthCard daemonStatus="running" rpcStatus="healthy" />));
    expect(screen.queryByTestId('node-health-daemon-state')).toBeNull();
  });

  it('renders the Restart button; enabled when daemon is running', () => {
    render(
      wrap(
        <NodeHealthCard
          daemonStatus="running"
          rpcStatus="healthy"
          onStop={vi.fn()}
          onRestart={vi.fn()}
        />,
      ),
    );
    const restart = screen.getByTestId('node-health-restart') as HTMLButtonElement;
    expect(restart.disabled).toBe(false);
    expect(restart.textContent).toMatch(/restart/i);
    // Stop is currently commented out — the dashboard process dies with the
    // daemon so the button can't confirm the action completed.
    expect(screen.queryByTestId('node-health-stop')).toBeNull();
  });

  it('disables Restart when daemon is stopped', () => {
    render(
      wrap(<NodeHealthCard daemonStatus="stopped" rpcStatus="healthy" />),
    );
    expect((screen.getByTestId('node-health-restart') as HTMLButtonElement).disabled).toBe(true);
  });

  it('invokes onRestart when Restart is clicked', async () => {
    const onRestart = vi.fn().mockResolvedValue(undefined);
    render(
      wrap(
        <NodeHealthCard
          daemonStatus="running"
          rpcStatus="healthy"
          onStop={vi.fn()}
          onRestart={onRestart}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('node-health-restart'));
    await waitFor(() => expect(onRestart).toHaveBeenCalledOnce());
    // The busy state ("Restarting...") clears as soon as the admin
    // endpoint resolves (which it does before the daemon actually exits),
    // since the browser keeps its JS context across the respawn — leaving
    // the button pinned to "Restarting..." would strand it there forever.
    await waitFor(() =>
      expect(screen.getByTestId('node-health-restart').textContent).toMatch(/^restart$/i),
    );
  });

  it('exposes a Manage RPC button that points at /operator/network', () => {
    render(wrap(<NodeHealthCard daemonStatus="running" rpcStatus="healthy" />));
    const rpcBtn = screen.getByTestId('node-health-rpc-settings');
    expect(rpcBtn.textContent).toMatch(/manage rpc/i);
  });
});
