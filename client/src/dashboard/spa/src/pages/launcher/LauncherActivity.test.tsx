import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

const fetchLauncherStatusMock = vi.fn();
const fetchLauncherTasksMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    fetchLauncherStatus: () => fetchLauncherStatusMock(),
    fetchLauncherTasks: (opts: unknown) => fetchLauncherTasksMock(opts),
  },
}));

const { LauncherActivity } = await import('./LauncherActivity.js');

function renderWithProviders(node: JSX.Element): void {
  const { hook } = memoryLocation({ path: '/launcher' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>,
  );
}

describe('LauncherActivity', () => {
  it('renders empty generator and task states', async () => {
    fetchLauncherStatusMock.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-05-06T17:30:00.000Z',
      nets: [],
    });
    fetchLauncherTasksMock.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-05-06T17:30:00.000Z',
      tasks: [],
    });

    renderWithProviders(<LauncherActivity />);

    await waitFor(() =>
      expect(screen.getByTestId('launcher-activity-empty')).toBeTruthy(),
    );
    expect(screen.getByTestId('launcher-task-activity-empty')).toBeTruthy();
  });

  it('renders generator loop metrics and recent task posts', async () => {
    fetchLauncherStatusMock.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-05-06T17:30:00.000Z',
      nets: [
        {
          name: 'Prediction Markets',
          generator: {
            state: 'active',
            lastPollAt: '2026-05-06T17:29:00.000Z',
            lastPollSummary: { evaluated: 4, posted: 2, skipped: 1 },
            cadenceMs: 120_000,
            stale: false,
          },
          openTasks: 5,
          budget: {
            safeAddress: '0x1111111111111111111111111111111111111111',
            safeBalanceWei: '1000000000000000000',
            reservedBudgetWei: '0',
            runwayDays: 10,
          },
        },
      ],
    });
    fetchLauncherTasksMock.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-05-06T17:30:00.000Z',
      tasks: [
        {
          taskId: 'task-1',
          taskCid: 'bafybeiaaa',
          solverNet: 'Prediction Markets',
          postedAt: '2026-05-06T17:28:00.000Z',
          state: 'claims-in-flight',
          claims: { current: 1, max: 3 },
          budget: { totalWei: '100', remainingWei: '80' },
          summary: { title: 'BTC above 70k?' },
        },
      ],
    });

    renderWithProviders(<LauncherActivity />);

    await waitFor(() =>
      expect(screen.getByTestId('launcher-process-grid')).toBeTruthy(),
    );
    expect(screen.getAllByTestId('launcher-process-card')).toHaveLength(1);
    expect(screen.getByText('Prediction Markets')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('BTC above 70k?')).toBeTruthy();
    expect(screen.getByText(/claims in flight/i)).toBeTruthy();
    expect(fetchLauncherTasksMock).toHaveBeenCalledWith({ limit: 5 });
  });
});
