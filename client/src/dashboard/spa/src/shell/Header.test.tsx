import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Header } from './Header.js';

describe('Header', () => {
  it('renders brand, network chip, RPC health, and master address', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Header
          network="testnet"
          rpcHealthy={true}
          masterAddress="0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF"
        />
      </Router>,
    );
    expect(screen.getByText(/jinn operator/i)).toBeTruthy();
    expect(screen.getByText(/testnet/i)).toBeTruthy();
    expect(screen.getByText(/rpc healthy/i)).toBeTruthy();
    expect(screen.getByText(/0xE64b…B5CF/)).toBeTruthy();
  });

  it('shows rpc unreachable when not healthy', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Header
          network="testnet"
          rpcHealthy={false}
          masterAddress="0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF"
        />
      </Router>,
    );
    expect(screen.getByText(/rpc unreachable/i)).toBeTruthy();
  });
});
