import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { NotificationItem } from './NotificationItem.js';
import type { OperatorNotification } from '../taxonomy.js';

import type { JSX } from 'react';

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
      title: 'Harness not ready',
      message: 'Claude not authenticated',
      jumpTo: '/operator/claim-policy',
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
      title: 'Gas runway low',
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
      title: 'Restart required',
      message: 'restart pending',
      jumpTo: '/overview',
    };
    const withoutLink: OperatorNotification = {
      kind: 'update_available',
      severity: 'info',
      title: 'Update available',
      message: 'new version available',
    };

    const { rerender } = render(wrap(<NotificationItem notice={withLink} />));
    expect(screen.getByRole('link', { name: /resolve/i })).toBeTruthy();

    rerender(wrap(<NotificationItem notice={withoutLink} />));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders an unknown kind from envelope title and severity rather than dropping the row', () => {
    const notice: OperatorNotification = {
      kind: 'brand_new_kind_from_newer_daemon',
      severity: 'warning',
      title: 'New daemon notice',
      message: 'A kind this build does not know.',
    };
    const { container } = render(wrap(<NotificationItem notice={notice} />));
    const li = container.querySelector('li');
    expect(li?.getAttribute('data-kind')).toBe('brand_new_kind_from_newer_daemon');
    expect(li?.getAttribute('data-severity')).toBe('warning');
    expect(screen.getByText('New daemon notice')).toBeTruthy();
    expect(screen.getByText('A kind this build does not know.')).toBeTruthy();
  });

  it('carries data-kind and data-severity attributes for styling / test hooks', () => {
    const notice: OperatorNotification = {
      kind: 'rpc_unreachable',
      severity: 'blocking',
      title: 'RPC unreachable',
      message: 'daemon offline',
    };
    const { container } = render(wrap(<NotificationItem notice={notice} />));
    const li = container.querySelector('li');
    expect(li?.getAttribute('data-kind')).toBe('rpc_unreachable');
    expect(li?.getAttribute('data-severity')).toBe('blocking');
  });

  it('tints the row per severity via a left-border colour token (closes #444)', () => {
    const cases: Array<{ severity: OperatorNotification['severity']; expectedClass: string }> = [
      { severity: 'blocking', expectedClass: 'border-l-[var(--severity-blocking-fg)]' },
      { severity: 'warning', expectedClass: 'border-l-[var(--severity-warning-fg)]' },
      { severity: 'info', expectedClass: 'border-l-[var(--severity-info-fg)]' },
    ];
    for (const { severity, expectedClass } of cases) {
      const notice: OperatorNotification = {
        kind: 'restart_required',
        severity,
        title: 'Restart required',
        message: 'severity test',
      };
      const { container, unmount } = render(wrap(<NotificationItem notice={notice} />));
      const li = container.querySelector('li');
      // data-severity is the stable hook for severity-aware styling and tests.
      expect(li?.getAttribute('data-severity')).toBe(severity);
      // The shadcn-aligned implementation tints the left border with the
      // severity colour token via a Tailwind arbitrary value.
      expect(li?.className).toContain(expectedClass);
      unmount();
    }
  });
});
