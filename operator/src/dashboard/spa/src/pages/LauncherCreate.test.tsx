import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import {
  LauncherCreatePage,
  LAUNCHER_CREATE_STORAGE_KEY,
} from './LauncherCreate.js';
import { api } from '../api/client.js';
import type {
  DraftSolverNetRecord,
  LaunchedSolverNetRecord,
} from '../../../../api/contract/index.js';

import type { JSX } from 'react';

vi.mock('../api/client.js', () => ({
  api: {
    getBootstrap: vi.fn(),
    getStatus: vi.fn(),
    solvernets: {
      createDraft: vi.fn(),
      getDraft: vi.fn(),
      updateDraft: vi.fn(),
      launch: vi.fn(),
      get: vi.fn(),
    },
  },
}));

function emptyDraft(overrides: Partial<DraftSolverNetRecord> = {}): DraftSolverNetRecord {
  return {
    schemaVersion: 'solvernet.draft.v1',
    draftId: 'd1',
    completedSteps: [],
    createdAt: '2026-05-05T00:00:00Z',
    updatedAt: '2026-05-05T00:00:00Z',
    ...overrides,
  };
}

function wrap(
  ui: JSX.Element,
  initialPath = '/launcher/create',
): { rendered: ReturnType<typeof render>; nav: ReturnType<typeof memoryLocation> } {
  const nav = memoryLocation({ path: initialPath, record: true });
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const rendered = render(
    <QueryClientProvider client={qc}>
      <Router hook={nav.hook}>{ui}</Router>
    </QueryClientProvider>,
  );
  return { rendered, nav };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: well-bootstrapped daemon with a master Safe.
  vi.mocked(api.getBootstrap).mockResolvedValue({
    schemaVersion: 1,
    mode: 'running',
    steps: [],
    currentStep: 'complete',
    services: [],
    master_address: '0xMASTERSAFE',
    chain: 'base-sepolia',
  });
  vi.mocked(api.getStatus).mockResolvedValue({
    masterGas: {
      address: '0xMASTERSAFE',
      balanceWei: '1000000000000000000',
      dailyEstimateWei: '0',
    },
  } as never);
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(LAUNCHER_CREATE_STORAGE_KEY);
  }
});

afterEach(() => {
  cleanup();
});

describe('LauncherCreatePage shell', () => {
  it('creates a fresh draft on mount when localStorage is empty', async () => {
    vi.mocked(api.solvernets.createDraft).mockResolvedValue(emptyDraft());
    wrap(<LauncherCreatePage />);
    await waitFor(() => expect(api.solvernets.createDraft).toHaveBeenCalled());
    expect(api.solvernets.getDraft).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LAUNCHER_CREATE_STORAGE_KEY)).toBe('d1');
  });

  it('reuses an existing draft when localStorage has a stored id', async () => {
    window.localStorage.setItem(LAUNCHER_CREATE_STORAGE_KEY, 'existing-draft');
    vi.mocked(api.solvernets.getDraft).mockResolvedValue(
      emptyDraft({ draftId: 'existing-draft', name: 'Polymarket' }),
    );
    wrap(<LauncherCreatePage />);
    await waitFor(() => expect(api.solvernets.getDraft).toHaveBeenCalledWith('existing-draft'));
    expect(api.solvernets.createDraft).not.toHaveBeenCalled();
    // Step 1 pre-fills name from existing draft
    await waitFor(() =>
      expect((screen.getByTestId('launcher-create-name') as HTMLInputElement).value).toBe(
        'Polymarket',
      ),
    );
  });

  it('falls back to createDraft when getDraft 404s', async () => {
    window.localStorage.setItem(LAUNCHER_CREATE_STORAGE_KEY, 'gone');
    vi.mocked(api.solvernets.getDraft).mockRejectedValue(new Error('404 Not Found'));
    vi.mocked(api.solvernets.createDraft).mockResolvedValue(
      emptyDraft({ draftId: 'd-new' }),
    );
    wrap(<LauncherCreatePage />);
    await waitFor(() => expect(api.solvernets.createDraft).toHaveBeenCalled());
    expect(window.localStorage.getItem(LAUNCHER_CREATE_STORAGE_KEY)).toBe('d-new');
  });

  it('renders Step 1 first and progresses through Next + Back', async () => {
    let currentDraft = emptyDraft();
    vi.mocked(api.solvernets.createDraft).mockResolvedValue(currentDraft);
    vi.mocked(api.solvernets.updateDraft).mockImplementation(async (_id, patch) => {
      currentDraft = { ...currentDraft, ...patch, updatedAt: new Date().toISOString() };
      return currentDraft;
    });

    wrap(<LauncherCreatePage />);
    await waitFor(() => expect(screen.getByTestId('launcher-create-step-1')).toBeTruthy());
    expect(screen.getByTestId('launcher-create-step-counter').textContent).toBe('Step 1 of 5');

    fireEvent.change(screen.getByTestId('launcher-create-name'), {
      target: { value: 'Polymarket' },
    });
    fireEvent.change(screen.getByTestId('launcher-create-description'), {
      target: { value: 'Forecast markets' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));

    await waitFor(() => expect(screen.getByTestId('launcher-create-step-2')).toBeTruthy());

    // Back returns to Step 1 with values preserved.
    fireEvent.click(screen.getByTestId('launcher-create-back'));
    await waitFor(() => expect(screen.getByTestId('launcher-create-step-1')).toBeTruthy());
    expect((screen.getByTestId('launcher-create-name') as HTMLInputElement).value).toBe(
      'Polymarket',
    );
  });

  it('full happy-path flow ending at /launcher/launched/:id', async () => {
    let currentDraft = emptyDraft();
    vi.mocked(api.solvernets.createDraft).mockResolvedValue(currentDraft);
    vi.mocked(api.solvernets.updateDraft).mockImplementation(async (_id, patch) => {
      currentDraft = { ...currentDraft, ...patch, updatedAt: new Date().toISOString() };
      return currentDraft;
    });
    vi.mocked(api.solvernets.launch).mockResolvedValue({
      solverNetId: 'sn-final',
      status: 'launching',
      pollUrl: '/v1/solvernets/launched/sn-final',
    });
    const launchedRecord: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: 'sn-final',
      manifestCid: 'bafy...',
      manifestHash: '0xabc',
      launcherAgentId: '5474',
      launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      launchedAt: '2026-05-05T15:00:00Z',
      status: 'launched',
      statusUpdatedAt: '2026-05-05T15:00:00Z',
      generatorEnabled: true,
      registry: {},
      launchProgress: { phase: 'spawning', attemptCount: 1 },
    };
    vi.mocked(api.solvernets.get).mockResolvedValue(launchedRecord);

    const { nav } = wrap(<LauncherCreatePage />);

    // Step 1
    await waitFor(() => screen.getByTestId('launcher-create-step-1'));
    fireEvent.change(screen.getByTestId('launcher-create-name'), {
      target: { value: 'Polymarket' },
    });
    fireEvent.change(screen.getByTestId('launcher-create-description'), {
      target: { value: 'Forecast markets' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));

    // Step 2
    await waitFor(() => screen.getByTestId('launcher-create-step-2'));
    fireEvent.click(screen.getByTestId('launcher-create-next'));

    // Step 3
    await waitFor(() => screen.getByTestId('launcher-create-step-3'));
    fireEvent.click(screen.getByTestId('launcher-create-next'));

    // Step 4
    await waitFor(() => screen.getByTestId('launcher-create-step-4'));
    fireEvent.change(screen.getByTestId('launcher-create-solutionPriceWei'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByTestId('launcher-create-verdictPriceWei'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));

    // Step 5
    await waitFor(() => screen.getByTestId('launcher-create-step-5'));
    fireEvent.click(screen.getByTestId('launcher-create-next'));

    await waitFor(() =>
      expect(nav.history[nav.history.length - 1]).toBe('/launcher/launched/sn-final'),
    );
    expect(api.solvernets.launch).toHaveBeenCalledWith('d1');
  });

  it('surfaces a step error when updateDraft fails and stays on the same step', async () => {
    vi.mocked(api.solvernets.createDraft).mockResolvedValue(emptyDraft());
    vi.mocked(api.solvernets.updateDraft).mockRejectedValue(new Error('boom'));
    wrap(<LauncherCreatePage />);
    await waitFor(() => screen.getByTestId('launcher-create-step-1'));
    fireEvent.change(screen.getByTestId('launcher-create-name'), {
      target: { value: 'Polymarket' },
    });
    fireEvent.change(screen.getByTestId('launcher-create-description'), {
      target: { value: 'Forecast markets' },
    });
    fireEvent.click(screen.getByTestId('launcher-create-next'));
    await waitFor(() =>
      expect(screen.getByTestId('launcher-create-error').textContent).toContain('boom'),
    );
    // still on step 1
    expect(screen.getByTestId('launcher-create-step-1')).toBeTruthy();
  });

  it('renders bootstrap error when createDraft fails', async () => {
    vi.mocked(api.solvernets.createDraft).mockRejectedValue(
      new Error('500 Internal Server Error'),
    );
    wrap(<LauncherCreatePage />);
    await waitFor(() =>
      expect(screen.getByTestId('launcher-create-bootstrap-error')).toBeTruthy(),
    );
    expect(screen.getByText(/500 Internal Server Error/)).toBeTruthy();
  });
});
