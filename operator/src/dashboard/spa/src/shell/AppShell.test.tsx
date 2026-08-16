import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { AppShell } from './AppShell.js';

vi.mock('../notifications/useNotifications.js', () => ({
  useNotifications: vi.fn(() => [
    { kind: 'harness_not_ready', severity: 'blocking', message: 'X', jumpTo: '/operator/claim-policy' },
  ]),
}));

describe('AppShell', () => {
  it('renders header, tabs, main outlet, and rail slots', () => {
    render(
      <AppShell
        header={<div data-testid="header">H</div>}
        tabs={<div data-testid="tabs">T</div>}
        rail={<div data-testid="rail">R</div>}
      >
        <div data-testid="main">M</div>
      </AppShell>,
    );
    expect(screen.getByTestId('header')).toBeTruthy();
    expect(screen.getByTestId('tabs')).toBeTruthy();
    expect(screen.getByTestId('rail')).toBeTruthy();
    expect(screen.getByTestId('main')).toBeTruthy();
  });

  // Issue #326: when the embedded agent surface is hidden the rail prop is
  // omitted; the shell renders no aside and collapses to a single column.
  it('renders no rail aside when the rail prop is omitted', () => {
    render(
      <AppShell
        header={<div data-testid="header">H</div>}
        tabs={<div data-testid="tabs">T</div>}
      >
        <div data-testid="main">M</div>
      </AppShell>,
    );
    expect(screen.getByTestId('header')).toBeTruthy();
    expect(screen.getByTestId('main')).toBeTruthy();
    expect(screen.queryByTestId('rail')).toBeNull();
  });

  it('mounts NotificationsList with derived notices', () => {
    const { hook } = memoryLocation({ path: '/' });
    render(
      <Router hook={hook}>
        <AppShell
          header={<div data-testid="header">H</div>}
          tabs={<div data-testid="tabs">T</div>}
        >
          <div data-testid="main">M</div>
        </AppShell>
      </Router>,
    );
    expect(screen.getByRole('region', { name: /notifications/i })).toBeTruthy();
    expect(screen.getByText('X')).toBeTruthy();
  });
});
