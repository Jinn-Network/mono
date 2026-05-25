import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Header } from './Header.js';

describe('Header', () => {
  it('renders the brand and network chip', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Header network="testnet" />
      </Router>,
    );
    expect(screen.getByText(/jinn operator/i)).toBeTruthy();
    expect(screen.getByText(/testnet/i)).toBeTruthy();
  });

  it('does not surface RPC health or the master address — both moved into the right rail cards', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Header network="testnet" />
      </Router>,
    );
    expect(screen.queryByText(/rpc healthy/i)).toBeNull();
    expect(screen.queryByText(/rpc unreachable/i)).toBeNull();
    expect(screen.queryByText(/master /i)).toBeNull();
  });
});
