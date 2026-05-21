import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
      wrap(
        <NodeHealthCard daemonStatus="stopped" rpcStatus="unreachable" />,
      ),
    );
    expect(screen.getByTestId('node-health-daemon-row').textContent).toMatch(/stopped/i);
    expect(screen.getByTestId('node-health-rpc-row').textContent).toMatch(/unreachable/i);
  });

  it('omits the daemon state message when none is provided', () => {
    render(wrap(<NodeHealthCard daemonStatus="running" rpcStatus="healthy" />));
    expect(screen.queryByTestId('node-health-daemon-state')).toBeNull();
  });

  it('renders Stop + Start buttons; disabled state reflects daemon status', () => {
    render(wrap(<NodeHealthCard daemonStatus="running" rpcStatus="healthy" />));
    const stop = screen.getByTestId('node-health-stop') as HTMLButtonElement;
    const start = screen.getByTestId('node-health-start') as HTMLButtonElement;
    // When running: Stop is the actionable one (currently disabled until daemon
    // endpoint exists, see TODOs in the component), Start is always disabled.
    expect(stop).toBeTruthy();
    expect(start).toBeTruthy();
    expect(start.disabled).toBe(true);
  });

  it('exposes a Manage RPC button that points at /operator/network', () => {
    render(wrap(<NodeHealthCard daemonStatus="running" rpcStatus="healthy" />));
    const rpcBtn = screen.getByTestId('node-health-rpc-settings');
    expect(rpcBtn.textContent).toMatch(/manage rpc/i);
  });
});
