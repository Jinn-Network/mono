import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPanel } from './TasksPanel.js';
import type {
  LaunchedSolverNetRecord,
  LauncherTaskEntry,
  LauncherTasksResponse,
} from '../../api/types.js';

import type { JSX } from 'react';

function buildRecord(): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'sn-1',
    manifestCid: 'bafybeig',
    manifestHash: '0xabc',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    launchedAt: '2026-05-05T15:00:00Z',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    generatorEnabled: true,
    registry: {},
  };
}

function buildTask(
  overrides: Partial<LauncherTaskEntry> = {},
): LauncherTaskEntry {
  return {
    taskId: 't1',
    taskCid: 'bafytask000000000000000000000000aaaaaa',
    solverNet: 'Polymarket',
    postedAt: '2026-05-05T16:00:00Z',
    state: 'open',
    claims: { current: 0, max: 1 },
    budget: { totalWei: '150', remainingWei: '150' },
    ...overrides,
  };
}

function wrap(ui: JSX.Element): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('TasksPanel', () => {
  it('renders the loading state while the fetch is in flight', () => {
    const fetchTasks = vi.fn().mockReturnValue(new Promise(() => undefined));
    wrap(<TasksPanel record={buildRecord()} fetchTasks={fetchTasks} />);
    expect(screen.getByTestId('launcher-launched-tasks-loading')).toBeTruthy();
  });

  it('renders empty-state when the response has zero tasks', async () => {
    const fetchTasks = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '',
      tasks: [],
    } satisfies LauncherTasksResponse);
    wrap(<TasksPanel record={buildRecord()} fetchTasks={fetchTasks} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-tasks-empty')).toBeTruthy(),
    );
    expect(screen.getByText(/Tasks will appear here/i)).toBeTruthy();
  });

  it('renders rows for each task', async () => {
    const fetchTasks = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '',
      tasks: [
        buildTask({ taskId: 't1', state: 'open', summary: { title: 'Will X happen?' } }),
        buildTask({
          taskId: 't2',
          state: 'fully-claimed',
          claims: { current: 3, max: 3 },
          solverType: 'swe-rebench-v2.v1',
        }),
        buildTask({ taskId: 't3', state: 'failed' }),
      ],
    } satisfies LauncherTasksResponse);
    wrap(<TasksPanel record={buildRecord()} fetchTasks={fetchTasks} />);
    await waitFor(() =>
      expect(screen.getAllByTestId('launcher-launched-task-row').length).toBe(3),
    );
    expect(screen.getByText('Will X happen?')).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Claimed')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('swe-rebench-v2.v1')).toBeTruthy();
    expect(screen.getByText('3 / 3')).toBeTruthy();
  });

  it('renders error state when the query rejects', async () => {
    const fetchTasks = vi.fn().mockRejectedValue(new Error('500 boom'));
    wrap(<TasksPanel record={buildRecord()} fetchTasks={fetchTasks} />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-tasks-error')).toBeTruthy(),
    );
    expect(screen.getByText(/500 boom/)).toBeTruthy();
  });

  it('Next button re-fetches with the cursor returned by the previous page', async () => {
    const fetchTasks = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        generatedAt: '',
        cursor: { before: '2026-05-05T15:00:00Z' },
        tasks: [buildTask({ taskId: 'p1' })],
      } satisfies LauncherTasksResponse)
      .mockResolvedValueOnce({
        schemaVersion: 1,
        generatedAt: '',
        tasks: [buildTask({ taskId: 'p2' })],
      } satisfies LauncherTasksResponse);

    wrap(<TasksPanel record={buildRecord()} fetchTasks={fetchTasks} />);
    await waitFor(() =>
      expect(screen.getAllByTestId('launcher-launched-task-row').length).toBe(1),
    );
    expect(fetchTasks).toHaveBeenCalledWith({ cursor: undefined, limit: 5 });

    fireEvent.click(screen.getByTestId('launcher-launched-tasks-next'));
    await waitFor(() => expect(fetchTasks).toHaveBeenCalledTimes(2));
    expect(fetchTasks).toHaveBeenLastCalledWith({
      cursor: '2026-05-05T15:00:00Z',
      limit: 5,
    });
  });

  it('Prev is disabled on the first page', async () => {
    const fetchTasks = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '',
      tasks: [buildTask()],
    } satisfies LauncherTasksResponse);
    wrap(<TasksPanel record={buildRecord()} fetchTasks={fetchTasks} />);
    await waitFor(() =>
      expect(screen.getAllByTestId('launcher-launched-task-row').length).toBe(1),
    );
    const prev = screen.getByTestId('launcher-launched-tasks-prev') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
  });

  it('Next is disabled when the response has no cursor', async () => {
    const fetchTasks = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '',
      tasks: [buildTask()],
    } satisfies LauncherTasksResponse);
    wrap(<TasksPanel record={buildRecord()} fetchTasks={fetchTasks} />);
    await waitFor(() =>
      expect(screen.getAllByTestId('launcher-launched-task-row').length).toBe(1),
    );
    const next = screen.getByTestId('launcher-launched-tasks-next') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });
});
