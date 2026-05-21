import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OverviewActivityPage } from './OverviewActivity.js';
import { api } from '../api/client.js';

vi.mock('../api/client.js', () => ({
  api: {
    getStatus: vi.fn(),
  },
}));

vi.mock('../api/events.js', () => ({
  useEventStream: vi.fn(() => ({
    events: [],
    connected: false,
  })),
}));

function wrap(ui: JSX.Element, path = '/overview/activity'): void {
  const nav = memoryLocation({ path, record: true });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={nav.hook}>{ui}</Router>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Restore default SSE mock after clearAllMocks resets the implementation.
  const { useEventStream } = await import('../api/events.js');
  vi.mocked(useEventStream).mockReturnValue({ events: [], connected: false });
});

afterEach(() => {
  cleanup();
});

describe('<OverviewActivityPage />', () => {
  it('renders the page header and embeds the LiveNowBand', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      predictionV1: { totals: { activeTaskRuns: 0 }, recentTasks: [] },
    });
    wrap(<OverviewActivityPage pollIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('overview-activity')).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: /Activity/i })).toBeTruthy();
    expect(screen.getByTestId('live-now-band')).toBeTruthy();
    expect(screen.getByTestId('overview-activity-back')).toBeTruthy();
  });

  it('shows in-flight rows from generic taskRuns', async () => {
    const now = Date.now();
    vi.mocked(api.getStatus).mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      taskRuns: {
        totals: { activeTaskRuns: 1 },
        inFlight: [
          {
            requestId: 'req-abc12345',
            taskId: 'task-1',
            taskCid: 'bafkre...',
            solverType: 'swe-rebench-v2.v1',
            state: 'RUNNING',
            taskRole: 'restoration',
            stateUpdatedAt: now - 60_000,
            deliveryTxHash: null,
          },
        ],
      },
      predictionV1: {
        totals: { activeTaskRuns: 0 },
        recentTasks: [
          {
            // terminal state — should be filtered out
            requestId: 'req-zzz',
            taskId: 'task-2',
            taskCid: 'bafkre...',
            state: 'COMPLETE',
            taskRole: 'restoration',
            stateUpdatedAt: now - 120_000,
            deliveryTxHash: '0xabc',
          },
        ],
      },
    });

    wrap(<OverviewActivityPage pollIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('overview-activity-in-flight-row')).toHaveLength(1);
    });
    expect(screen.getByText('RUNNING')).toBeTruthy();
    expect(screen.getByText('restoration')).toBeTruthy();
    expect(screen.getByText(/swe-rebench-v2.v1/)).toBeTruthy();
    // Empty state should not render when we have rows
    expect(screen.queryByTestId('overview-activity-in-flight-empty')).toBeNull();
  });

  it('shows the in-flight empty state when no non-terminal tasks', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      predictionV1: {
        totals: { activeTaskRuns: 0 },
        recentTasks: [
          {
            requestId: 'req-zzz',
            taskId: 'task-2',
            taskCid: 'bafkre...',
            state: 'COMPLETE',
            taskRole: 'restoration',
            stateUpdatedAt: Date.now() - 120_000,
            deliveryTxHash: '0xabc',
          },
        ],
      },
    });
    wrap(<OverviewActivityPage pollIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('overview-activity-in-flight-empty')).toBeTruthy();
    });
  });

  it('renders recent activity rows from SSE events when present', async () => {
    const { useEventStream } = await import('../api/events.js');
    vi.mocked(useEventStream).mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          id: 'evt-2',
          ts: '2026-05-07T13:46:45.710Z',
          kind: 'intent',
          message: 'request claimed',
          requestId: 'req-aaa',
          txHash: '0xabcdefabcdefabcdef',
        },
      ],
      connected: true,
    });
    vi.mocked(api.getStatus).mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      predictionV1: { totals: { activeTaskRuns: 0 }, recentTasks: [] },
    });
    wrap(<OverviewActivityPage pollIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('overview-activity-recent-list')).toBeTruthy();
    });
    expect(screen.getByText(/request claimed/i)).toBeTruthy();
  });

  it('shows the recent empty state when no events', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      predictionV1: { totals: { activeTaskRuns: 0 }, recentTasks: [] },
    });
    wrap(<OverviewActivityPage pollIntervalMs={60_000} />);
    await waitFor(() => {
      const empty = screen.getByTestId('overview-activity-recent-empty');
      expect(empty).toBeTruthy();
      expect(empty.textContent).toMatch(/no recent activity/i);
    });
  });

  it('renders recent events from useEventStream (SSE), not the polled snapshot', async () => {
    const { useEventStream } = await import('../api/events.js');
    vi.mocked(useEventStream).mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          id: 'evt-1',
          ts: '2026-05-20T11:45:38Z',
          kind: 'intent',
          message: 'CLAIMED',
          details: { requestId: '0xabc' },
        },
      ],
      connected: true,
    });

    vi.mocked(api.getStatus).mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      // polled snapshot intentionally empty — SSE should supply the event
      activity: { recent: [] },
      predictionV1: { totals: { activeTaskRuns: 0 }, recentTasks: [] },
    });

    wrap(<OverviewActivityPage pollIntervalMs={60_000} />);
    expect(await screen.findByText(/CLAIMED/i)).toBeTruthy();
  });
});
