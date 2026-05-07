import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getStatusMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    getStatus: () => getStatusMock(),
  },
}));

const { OperatorActivity } = await import('./OperatorActivity.js');

function renderWithQueryClient(node: JSX.Element): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe('OperatorActivity', () => {
  it('renders the empty activity state', async () => {
    getStatusMock.mockResolvedValueOnce({ activity: { counts: {}, recent: [] } });

    renderWithQueryClient(<OperatorActivity />);

    await waitFor(() =>
      expect(screen.getByTestId('operator-activity-empty')).toBeTruthy(),
    );
  });

  it('renders recent activity rows and count chips from status.activity', async () => {
    getStatusMock.mockResolvedValueOnce({
      daemon: { startedAt: '2026-05-06T17:00:00.000Z' },
      fleet: { services: [{ index: 1, step: 'complete' }], completeCount: 1 },
      activity: {
        counts: { request_claimed: 2, delivery_submitted: 1, reward_claimed: 1 },
        recent: [
          {
            id: 7,
            ts: '2026-05-06T17:30:00.000Z',
            kind: 'request_claimed',
            requestId: 'req-1',
            serviceIndex: 1,
            txHash: '0x1234567890abcdef',
            solverType: 'prediction.v1',
            outcome: 'ok',
          },
          {
            id: 6,
            ts: '2026-05-06T17:25:00.000Z',
            kind: 'reward_claimed',
            requestId: null,
            serviceIndex: 1,
            txHash: '0xabcdef1234567890',
            solverType: null,
            outcome: 'ok',
          },
        ],
      },
      rewards: { lastClaimTickAt: '2026-05-06T17:25:00.000Z', claimLoopIntervalMs: 60_000 },
      predictionV1: { totals: { activeTaskRuns: 3, failed: 0 } },
    });

    renderWithQueryClient(<OperatorActivity />);

    await waitFor(() =>
      expect(screen.getByTestId('operator-activity-list')).toBeTruthy(),
    );
    expect(screen.getByText('Claimed')).toBeTruthy();
    expect(screen.getByText(/request req-1/i)).toBeTruthy();
    expect(screen.getByText(/Claimed 2/i)).toBeTruthy();
    expect(screen.getByTestId('operator-process-grid')).toBeTruthy();
    expect(screen.getAllByTestId('operator-process-card')).toHaveLength(4);
    expect(screen.getByText(/3 active/i)).toBeTruthy();
    expect(screen.getByText(/1 reward claims submitted/i)).toBeTruthy();
  });
});
