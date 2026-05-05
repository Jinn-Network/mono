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
});
