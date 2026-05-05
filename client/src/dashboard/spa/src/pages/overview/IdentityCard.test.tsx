import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IdentityCard } from './IdentityCard.js';

vi.mock('../../api/client.js', () => ({
  api: { retryAgentBinding: vi.fn(async () => ({ ok: true, attempts: [] })) },
}));

describe('IdentityCard', () => {
  it('renders agent number, chain, and Safe', () => {
    render(
      <IdentityCard
        agentId={5474}
        chain="Base Sepolia"
        safeAddress="0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC"
      />,
    );
    expect(screen.getByText(/identity/i)).toBeTruthy();
    expect(screen.getByText('#5474')).toBeTruthy();
    expect(screen.getByText('Base Sepolia')).toBeTruthy();
    expect(screen.getByText(/0x0e76…24FC/)).toBeTruthy();
  });

  it('shows binding pending chip + retry when a service has agentId set but safeBoundToAgent=false', () => {
    render(
      <IdentityCard
        agentId={5474}
        chain="Base Sepolia"
        safeAddress="0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC"
        services={[
          { index: 1, safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC', agentId: 5474, safeBoundToAgent: false },
        ]}
      />,
    );
    expect(screen.getByText(/binding pending/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/binding pending/i));
    expect(screen.getByRole('button', { name: /retry binding/i })).toBeTruthy();
  });

  it('omits the chip when all services are bound', () => {
    render(
      <IdentityCard
        agentId={5474}
        chain="Base Sepolia"
        safeAddress="0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC"
        services={[
          { index: 1, safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC', agentId: 5474, safeBoundToAgent: true },
        ]}
      />,
    );
    expect(screen.queryByText(/binding pending/i)).toBeNull();
  });
});
