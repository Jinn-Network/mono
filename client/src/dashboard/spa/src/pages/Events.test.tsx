import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { EventsPage } from './Events.js';
import { api } from '../api/client.js';
import type { ActivityEventRow, ActivityEventsResponse } from '../../../../api/contract/index.js';

import type { JSX } from 'react';

vi.mock('../api/client.js', () => ({
  api: {
    getActivityEvents: vi.fn(),
  },
}));

function wrap(ui: JSX.Element, path = '/events'): ReturnType<typeof memoryLocation> {
  if (path.includes('?')) {
    window.history.pushState({}, '', path);
  }
  const memory = memoryLocation({ path: path.split('?')[0], record: true });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={0}>
        <Router hook={memory.hook}>{ui}</Router>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return memory;
}

function row(id: number, kind: string, extra: Partial<ActivityEventRow> = {}): ActivityEventRow {
  return {
    id,
    ts: `2026-05-01T00:00:${String(id % 60).padStart(2, '0')}Z`,
    kind,
    requestId: `req-${id}`,
    serviceIndex: null,
    txHash: null,
    solverType: null,
    outcome: 'ok',
    detail: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('<EventsPage />', () => {
  it('renders event rows with human-readable labels', async () => {
    vi.mocked(api.getActivityEvents).mockResolvedValue({
      events: [row(3, 'task_posted'), row(2, 'request_claimed'), row(1, 'reward_claimed')],
      nextCursor: null,
      counts: { task_posted: 1, request_claimed: 1, reward_claimed: 1 },
    } satisfies ActivityEventsResponse);

    wrap(<EventsPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId('events-row')).toHaveLength(3);
    });
    const list = screen.getByTestId('events-list');
    expect(within(list).getByText('Task posted')).toBeTruthy();
    expect(within(list).getByText('Request claimed')).toBeTruthy();
    expect(screen.queryByText('task_posted')).toBeNull();
  });

  it('loads all events across multiple pages', async () => {
    const page1: ActivityEventsResponse = {
      events: Array.from({ length: 50 }, (_, i) => row(100 - i, 'task_posted')),
      nextCursor: 51,
      counts: { task_posted: 60 },
    };
    const page2: ActivityEventsResponse = {
      events: Array.from({ length: 10 }, (_, i) => row(50 - i, 'task_posted')),
      nextCursor: null,
      counts: { task_posted: 60 },
    };
    vi.mocked(api.getActivityEvents).mockImplementation(async (opts) =>
      opts?.beforeId === 51 ? page2 : page1,
    );

    wrap(<EventsPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId('events-row')).toHaveLength(50);
    });
    fireEvent.click(screen.getByTestId('events-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('events-row')).toHaveLength(60);
    });
    expect(screen.queryByTestId('events-load-more')).toBeNull();
  });

  it('applies kind and outcome filters through the API query', async () => {
    vi.mocked(api.getActivityEvents).mockImplementation(async (opts): Promise<ActivityEventsResponse> => {
      if (opts?.kinds?.includes('reward_claimed')) {
        return { events: [row(1, 'reward_claimed')], nextCursor: null, counts: { reward_claimed: 1 } };
      }
      if (opts?.outcome === 'failed') {
        return { events: [row(2, 'tick_error', { outcome: 'failed' })], nextCursor: null, counts: {} };
      }
      return {
        events: [row(3, 'task_posted'), row(2, 'tick_error', { outcome: 'failed' }), row(1, 'reward_claimed')],
        nextCursor: null,
        counts: { task_posted: 1, tick_error: 1, reward_claimed: 1 },
      };
    });

    wrap(<EventsPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId('events-row')).toHaveLength(3);
    });
    fireEvent.click(screen.getByTestId('events-kind-filter-reward_claimed'));
    await waitFor(() => {
      expect(screen.getAllByTestId('events-row')).toHaveLength(1);
    });
    expect(within(screen.getByTestId('events-list')).getByText('Reward claimed')).toBeTruthy();

    fireEvent.click(screen.getByTestId('events-kind-filter-reward_claimed'));
    await waitFor(() => {
      expect(screen.getAllByTestId('events-row')).toHaveLength(3);
    });
    fireEvent.click(screen.getByTestId('events-outcome-failed'));
    await waitFor(() => {
      expect(screen.getAllByTestId('events-row')).toHaveLength(1);
    });
    expect(within(screen.getByTestId('events-list')).getByText('Tick error')).toBeTruthy();
  });

  it('scopes to requestId from the URL and can clear that scope', async () => {
    vi.mocked(api.getActivityEvents).mockResolvedValue({
      events: [row(7, 'delivery_submitted', { requestId: 'req-scoped' })],
      nextCursor: null,
      counts: {},
    });

    const memory = wrap(<EventsPage />, '/events?requestId=req-scoped');

    await waitFor(() => {
      expect(api.getActivityEvents).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-scoped' }));
    });
    expect(screen.getByTestId('events-request-scope').textContent).toContain('req-scoped');
    fireEvent.click(screen.getByTestId('events-clear-request'));
    expect(memory.history.at(-1)).toBe('/events');
  });

  it('links each row to event detail', async () => {
    vi.mocked(api.getActivityEvents).mockResolvedValue({
      events: [row(7, 'delivery_submitted')],
      nextCursor: null,
      counts: {},
    });

    wrap(<EventsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('events-row-link')).toBeTruthy();
    });
    expect(screen.getByTestId('events-row-link').getAttribute('href')).toBe('/events/7');
  });

  it('shows empty and retryable error states', async () => {
    vi.mocked(api.getActivityEvents).mockResolvedValueOnce({
      events: [],
      nextCursor: null,
      counts: {},
    });
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider delayDuration={0}>
          <Router hook={memoryLocation({ path: '/events' }).hook}>
            <EventsPage />
          </Router>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('events-empty')).toBeTruthy();
    });
    unmount();

    vi.mocked(api.getActivityEvents).mockRejectedValueOnce(new Error('events unavailable'));
    wrap(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('events-error')).toBeTruthy();
    });
    expect(screen.getAllByText(/events unavailable/i).length).toBeGreaterThan(0);
    vi.mocked(api.getActivityEvents).mockResolvedValue({ events: [], nextCursor: null, counts: {} });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('events-error')).toBeNull();
    });
  });
});
