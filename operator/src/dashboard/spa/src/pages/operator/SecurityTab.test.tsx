import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecurityTab } from './SecurityTab.js';

vi.mock('../../api/client.js', () => ({
  api: {
    changeKeystorePassword: vi.fn(),
    harnessAuthStatus: vi.fn().mockResolvedValue({ harnesses: [] }),
  },
}));

describe('SecurityTab', () => {
  it('renders the security-tab container', () => {
    render(<SecurityTab />);
    expect(screen.getByTestId('security-tab')).toBeTruthy();
  });

  it('renders the Security section card with danger framing', () => {
    render(<SecurityTab />);
    expect(screen.getByText(/security/i)).toBeTruthy();
    expect(screen.getByText(/danger zone/i)).toBeTruthy();
  });

  it('renders the password rotation form with defaultExpanded=true', () => {
    render(<SecurityTab />);
    // With defaultExpanded=true the body is visible immediately.
    expect(screen.getByText(/current password/i)).toBeTruthy();
    expect(screen.getByText(/new password/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /rotate password/i })).toBeTruthy();
  });
});
