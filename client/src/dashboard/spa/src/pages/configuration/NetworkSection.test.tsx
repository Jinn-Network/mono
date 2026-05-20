import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NetworkSection } from './NetworkSection.js';

describe('NetworkSection', () => {
  it('shows current chain (locked) and rpc URL (editable)', () => {
    render(
      <NetworkSection
        chain="base-sepolia"
        rpcUrl="https://my-tenderly.example/abc"
        defaultRpcUrl="https://sepolia.base.org"
        rpcHealthy={true}
        onRestartPending={() => undefined}
      />,
    );
    expect(screen.getByText(/network/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/network/i));
    expect(screen.getByDisplayValue('https://my-tenderly.example/abc')).toBeTruthy();
    expect(screen.getByText(/locked/i)).toBeTruthy();
  });

  it('expands by default and shows the shared-RPC warning when on the shared default', () => {
    // jinn-mono #325: a first-run operator on the shared default RPC should
    // see the BYO-RPC nudge without having to click the section open.
    render(
      <NetworkSection
        chain="base-sepolia"
        rpcUrl="https://sepolia.base.org"
        defaultRpcUrl="https://sepolia.base.org"
        rpcHealthy={true}
        onRestartPending={() => undefined}
      />,
    );
    // Body is expanded without a click — the RPC input is visible.
    expect(screen.getByDisplayValue('https://sepolia.base.org')).toBeTruthy();
    const warning = screen.getByTestId('network-shared-rpc-warning');
    expect(warning.textContent).toMatch(/shared rpc/i);
    expect(warning.textContent).toMatch(/your own free key/i);
  });

  it('does not show the shared-RPC warning when a custom RPC is configured', () => {
    render(
      <NetworkSection
        chain="base-sepolia"
        rpcUrl="https://my-own-key.example/rpc"
        defaultRpcUrl="https://sepolia.base.org"
        rpcHealthy={true}
        onRestartPending={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText(/network/i));
    expect(screen.queryByTestId('network-shared-rpc-warning')).toBeNull();
  });
});
