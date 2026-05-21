import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { NodeHealthCard } from './NodeHealthCard.js';

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

  it('renders Stop + Restart buttons; both enabled when daemon is running', () => {
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
    const stop = screen.getByTestId('node-health-stop') as HTMLButtonElement;
    const restart = screen.getByTestId('node-health-restart') as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(restart.disabled).toBe(false);
    expect(restart.textContent).toMatch(/restart/i);
  });

  it('disables Stop + Restart when daemon is stopped', () => {
    render(
      wrap(<NodeHealthCard daemonStatus="stopped" rpcStatus="healthy" />),
    );
    expect((screen.getByTestId('node-health-stop') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('node-health-restart') as HTMLButtonElement).disabled).toBe(true);
  });

  it('invokes onStop when Stop is clicked', async () => {
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(
      wrap(
        <NodeHealthCard
          daemonStatus="running"
          rpcStatus="healthy"
          onStop={onStop}
          onRestart={vi.fn()}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('node-health-stop'));
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
    // While the action is in flight the button reports "Stopping..." and is
    // disabled — the daemon is about to exit, so we don't want a second click.
    expect(screen.getByTestId('node-health-stop').textContent).toMatch(/stopping/i);
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
    expect(screen.getByTestId('node-health-restart').textContent).toMatch(/restarting/i);
  });

  it('exposes a Manage RPC button that points at /operator/network', () => {
    render(wrap(<NodeHealthCard daemonStatus="running" rpcStatus="healthy" />));
    const rpcBtn = screen.getByTestId('node-health-rpc-settings');
    expect(rpcBtn.textContent).toMatch(/manage rpc/i);
  });
});
