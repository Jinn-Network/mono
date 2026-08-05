import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { NotificationsList } from './NotificationsList.js';
import type { OperatorNotification } from '../taxonomy.js';

import type { JSX } from 'react';

const notices: OperatorNotification[] = [
  { kind: 'harness_not_ready', severity: 'blocking', title: 'Harness not ready', message: 'Claude not authenticated', jumpTo: '/operator/memberships' },
  { kind: 'funding_low', severity: 'warning', title: 'Gas runway low', message: '1 day runway' },
  { kind: 'no_solvernets_joined', severity: 'info', title: 'No SolverNets joined', message: 'No SolverNets joined' },
];

function MemoryRouter({ children }: { children: React.ReactNode }): JSX.Element {
  const { hook } = memoryLocation({ path: '/' });
  return <Router hook={hook}>{children}</Router>;
}

describe('NotificationsList', () => {
  it('renders nothing when there are no notices', () => {
    const { container } = render(<NotificationsList notices={[]} />, { wrapper: MemoryRouter });
    expect(container.firstChild).toBeNull();
  });

  it('renders one item per notice, grouped by severity', () => {
    render(<NotificationsList notices={notices} />, { wrapper: MemoryRouter });
    expect(screen.getByText(/claude not authenticated/i)).toBeTruthy();
    expect(screen.getByText(/1 day runway/i)).toBeTruthy();
    expect(screen.getByText(/no solvernets joined/i)).toBeTruthy();
  });

  it('renders the jump-to link only when jumpTo is set', () => {
    render(<NotificationsList notices={notices} />, { wrapper: MemoryRouter });
    expect(screen.getAllByRole('link').length).toBe(1);
  });
});
