import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivitySections } from './ActivitySections.js';
import { api } from '../../api/client.js';

/**
 * Issue #219: ActivitySections is the live activity surface extracted so it
 * can render both as a primary section on /overview (the Dashboard) and on
 * the dedicated /overview/activity drilldown. These tests cover the unit's
 * card states directly.
 */
vi.mock('../../api/client.js', () => ({
  api: {
    getStatus: vi.fn(),
  },
}));

function wrap(ui: JSX.Element): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('<ActivitySections />', () => {
  it('shows the loading state while /v1/status is in flight', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    vi.mocked(api.getStatus).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }) as Promise<unknown>,
    );
    wrap(<ActivitySections pollIntervalMs={60_000} />);
    expect(screen.getByTestId('overview-activity-loading')).toBeTruthy();
    resolve({ activity: { recent: [] } });
    await waitFor(() =>
      expect(screen.queryByTestId('overview-activity-loading')).toBeNull(),
    );
  });

  it('shows the in-flight and recent empty states', async () => {
    vi.mocked(api.getStatus).mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [] },
      taskRuns: { inFlight: [] },
      predictionV1: { recentTasks: [] },
    });
    wrap(<ActivitySections pollIntervalMs={60_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('overview-activity-in-flight-empty')).toBeTruthy(),
    );
    const recentEmpty = screen.getByTestId('overview-activity-recent-empty');
    expect(recentEmpty.textContent).toMatch(/no recent activity/i);
  });

  it('renders in-flight rows and recent rows when present', async () => {
    const now = Date.now();
    vi.mocked(api.getStatus).mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      taskRuns: {
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
      activity: {
        recent: [
          {
            id: 1,
            ts: '2026-05-07T13:46:45.710Z',
            kind: 'request_claimed',
            requestId: 'req-aaa',
            txHash: '0xabcdefabcdefabcdef',
            serviceIndex: 1,
            solverType: 'prediction.v1',
            outcome: 'ok',
          },
        ],
      },
    });
    wrap(<ActivitySections pollIntervalMs={60_000} />);
    await waitFor(() =>
      expect(screen.getAllByTestId('overview-activity-in-flight-row')).toHaveLength(1),
    );
    expect(screen.getByText('RUNNING')).toBeTruthy();
    expect(screen.getAllByTestId('overview-activity-recent-row')).toHaveLength(1);
    expect(screen.getByText(/request claimed/i)).toBeTruthy();
  });

  it('shows an operable error state with a working retry', async () => {
    vi.mocked(api.getStatus).mockRejectedValueOnce(new Error('status unavailable'));
    wrap(<ActivitySections pollIntervalMs={60_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('overview-activity-error')).toBeTruthy(),
    );
    expect(screen.getByText(/status unavailable/i)).toBeTruthy();

    vi.mocked(api.getStatus).mockResolvedValue({ activity: { recent: [] } });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('overview-activity-error')).toBeNull(),
    );
  });
});
