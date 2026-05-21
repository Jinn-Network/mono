import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Header } from './Header.js';

describe('Header', () => {
  it('renders brand, network chip, and master address', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Header network="testnet" masterAddress="0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF" />
      </Router>,
    );
    expect(screen.getByText(/jinn operator/i)).toBeTruthy();
    expect(screen.getByText(/testnet/i)).toBeTruthy();
    expect(screen.getByText(/0xE64b…B5CF/)).toBeTruthy();
  });

  it('does not surface RPC health — that has moved to the Node Health card on /overview', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Header network="testnet" masterAddress="0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF" />
      </Router>,
    );
    expect(screen.queryByText(/rpc healthy/i)).toBeNull();
    expect(screen.queryByText(/rpc unreachable/i)).toBeNull();
  });
});
