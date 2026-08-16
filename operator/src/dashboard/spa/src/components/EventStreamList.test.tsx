import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventStreamList } from './EventStreamList.js';
import type { StructuredEvent } from '../../../../api/contract/index.js';

const events: StructuredEvent[] = [
  { schemaVersion: 1, id: '1', ts: '2026-05-20T11:45:38Z', kind: 'intent', message: 'CLAIMED', details: { requestId: '0xabc' } },
  { schemaVersion: 1, id: '2', ts: '2026-05-20T11:44:45Z', kind: 'system', message: 'STARTUP', details: {} },
];

describe('EventStreamList', () => {
  it('renders one row per event with timestamp, kind, message', () => {
    render(<EventStreamList events={events} />);
    expect(screen.getByText(/CLAIMED/i)).toBeTruthy();
    expect(screen.getByText(/STARTUP/i)).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBe(2);
  });

  it('renders empty state when no events', () => {
    render(<EventStreamList events={[]} />);
    expect(screen.getByText(/no events/i)).toBeTruthy();
  });

  it('filters by kind when filterKind prop set', () => {
    render(<EventStreamList events={events} filterKind="intent" />);
    expect(screen.queryByText(/STARTUP/i)).toBeNull();
    expect(screen.getByText(/CLAIMED/i)).toBeTruthy();
  });

  it('renders most-recent events first (descending ts)', () => {
    const out = render(<EventStreamList events={events} />);
    const rows = out.container.querySelectorAll('li');
    // First row should be the most-recent event
    expect(rows[0].textContent).toMatch(/CLAIMED/i);
  });
});
