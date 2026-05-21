import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { NotificationItem } from './NotificationItem.js';
import type { OperatorNotification } from '../taxonomy.js';

function wrap(ui: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/' });
  // wouter <Link> requires Router context.
  return <Router hook={hook}><ul>{ui}</ul></Router>;
}

describe('NotificationItem', () => {
  it('exposes severity to screen readers via aria-label on the li (a11y per code-review of #426)', () => {
    const notice: OperatorNotification = {
      kind: 'harness_not_ready',
      severity: 'blocking',
      message: 'Claude not authenticated',
      jumpTo: '/operator/memberships',
    };
    const { container } = render(wrap(<NotificationItem notice={notice} />));
    const li = container.querySelector('li');
    expect(li).toBeTruthy();
    expect(li?.getAttribute('aria-label')).toMatch(/blocking notice/i);
    expect(li?.getAttribute('aria-label')).toMatch(/claude not authenticated/i);
  });

  it('marks the visible severity chip as aria-hidden so SR users get the aria-label only', () => {
    const notice: OperatorNotification = {
      kind: 'funding_low',
      severity: 'warning',
      message: 'Top up gas',
    };
    render(wrap(<NotificationItem notice={notice} />));
    // The visible "WARNING" chip on the left should be aria-hidden so SR users
    // hear the aria-label ("warning notice: Top up gas") once, not twice.
    const chip = screen.getByText(/warning/i, { selector: 'span[aria-hidden="true"]' });
    expect(chip).toBeTruthy();
  });

  it('renders the jump-to link only when jumpTo is set', () => {
    const withLink: OperatorNotification = {
      kind: 'restart_required',
      severity: 'warning',
      message: 'restart pending',
      jumpTo: '/overview',
    };
    const withoutLink: OperatorNotification = {
      kind: 'update_available',
      severity: 'info',
      message: 'new version available',
    };

    const { rerender } = render(wrap(<NotificationItem notice={withLink} />));
    expect(screen.getByRole('link', { name: /resolve/i })).toBeTruthy();

    rerender(wrap(<NotificationItem notice={withoutLink} />));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('carries data-kind and data-severity attributes for styling / test hooks', () => {
    const notice: OperatorNotification = {
      kind: 'rpc_unreachable',
      severity: 'blocking',
      message: 'daemon offline',
    };
    const { container } = render(wrap(<NotificationItem notice={notice} />));
    const li = container.querySelector('li');
    expect(li?.getAttribute('data-kind')).toBe('rpc_unreachable');
    expect(li?.getAttribute('data-severity')).toBe('blocking');
  });
});
