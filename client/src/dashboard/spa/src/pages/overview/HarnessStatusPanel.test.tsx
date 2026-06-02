import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Toaster } from '../../components/ui/sonner.js';
import { HarnessStatusPanel } from './HarnessStatusPanel.js';
import type { HarnessReadinessEntry } from '../../api/types.js';

import type { JSX } from 'react';

const harnessReadinessMock = vi.fn();
const codexDoctorMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    harnessReadiness: (name: string) => harnessReadinessMock(name),
    codexDoctor: () => codexDoctorMock(),
  },
}));

const READY: HarnessReadinessEntry = {
  harnessName: 'claude-code',
  manifestCids: ['bafkreiswe'],
  ready: true,
};
const NOT_READY_CLI: HarnessReadinessEntry = {
  harnessName: 'codex',
  manifestCids: ['bafkreiswe'],
  ready: false,
  reason: 'CLI not authenticated',
  nextStep: { description: 'Run codex login', cli: 'codex login' },
};
const NOT_READY_URL: HarnessReadinessEntry = {
  harnessName: 'claude-code',
  manifestCids: ['bafkreiswe'],
  ready: false,
  reason: 'subscription expired',
  nextStep: { description: 'Re-authenticate Claude Code', url: 'https://claude.ai/login' },
};

function withProviders(node: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/overview' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
      <Toaster />
    </QueryClientProvider>
  );
}

describe('HarnessStatusPanel', () => {
  beforeEach(() => {
    harnessReadinessMock.mockReset();
    codexDoctorMock.mockReset();
    // Default: codex CLI is within the tested range so the version hint
    // never renders unless a test opts in.
    codexDoctorMock.mockResolvedValue({
      installed: true,
      authenticated: true,
      authStatus: 'ok',
      cliVersion: '0.120.0',
      versionStatus: 'ok',
      exitCode: 0,
      stdout: 'codex 0.120.0',
      stderr: '',
    });
  });

  it('exposes data-testid="harness-status-panel" on the root region', async () => {
    harnessReadinessMock.mockResolvedValue(READY);
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code']} />));
    expect(await screen.findByTestId('harness-status-panel')).toBeTruthy();
  });

  it('renders one row per harness name, with the name in the row header', async () => {
    harnessReadinessMock.mockImplementation((name: string) =>
      Promise.resolve(name === 'claude-code' ? READY : NOT_READY_CLI),
    );
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code', 'codex']} />));
    await waitFor(() => {
      expect(screen.getByTestId('harness-row-claude-code')).toBeTruthy();
      expect(screen.getByTestId('harness-row-codex')).toBeTruthy();
    });
  });

  it('renders ready pill when the harness is ready', async () => {
    harnessReadinessMock.mockResolvedValue(READY);
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code']} />));
    await waitFor(() => {
      const row = screen.getByTestId('harness-row-claude-code');
      expect(row.textContent).toMatch(/ready/i);
    });
  });

  it('renders the nextStep.description and the cli hint when not ready', async () => {
    harnessReadinessMock.mockResolvedValue(NOT_READY_CLI);
    render(withProviders(<HarnessStatusPanel harnessNames={['codex']} />));
    await waitFor(() => {
      const row = screen.getByTestId('harness-row-codex');
      expect(row.textContent).toContain('Run codex login');
      expect(row.textContent).toContain('codex login');
    });
  });

  it('renders a Re-check button per row and refetches readiness when clicked', async () => {
    harnessReadinessMock.mockResolvedValue(NOT_READY_CLI);
    render(withProviders(<HarnessStatusPanel harnessNames={['codex']} />));
    const recheck = await screen.findByTestId('harness-recheck-codex');
    const callsBefore = harnessReadinessMock.mock.calls.length;
    fireEvent.click(recheck);
    await waitFor(() =>
      expect(harnessReadinessMock.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('renders a Re-authenticate button that opens nextStep.url in a new tab when present', async () => {
    harnessReadinessMock.mockResolvedValue(NOT_READY_URL);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code']} />));
    await waitFor(() => screen.getByTestId('harness-reauth-claude-code'));
    fireEvent.click(screen.getByTestId('harness-reauth-claude-code'));
    expect(openSpy).toHaveBeenCalledWith('https://claude.ai/login', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('copies nextStep.cli to clipboard when no url is available', async () => {
    harnessReadinessMock.mockResolvedValue(NOT_READY_CLI);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(withProviders(<HarnessStatusPanel harnessNames={['codex']} />));
    await waitFor(() => screen.getByTestId('harness-reauth-codex'));
    fireEvent.click(screen.getByTestId('harness-reauth-codex'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('codex login'));
  });

  it('renders an empty-state helper row when harnessNames is empty', () => {
    render(withProviders(<HarnessStatusPanel harnessNames={[]} />));
    const panel = screen.getByTestId('harness-status-panel');
    expect(panel.textContent).toMatch(/no solvernets joined/i);
  });

  it('hides Re-check / Re-authenticate buttons when the row is ready', async () => {
    harnessReadinessMock.mockResolvedValue(READY);
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code']} />));
    await waitFor(() => screen.getByTestId('harness-row-claude-code'));
    expect(screen.queryByTestId('harness-reauth-claude-code')).toBeNull();
    expect(screen.queryByTestId('harness-recheck-claude-code')).toBeNull();
  });

  // #675 — yellow hint when the operator's installed codex CLI falls outside
  // the harness's tested range. Scoped to the codex row only.
  it('renders untested-version hint for codex harness row when versionStatus is "untested"', async () => {
    harnessReadinessMock.mockResolvedValue({
      harnessName: 'codex',
      manifestCids: ['bafkreiswe'],
      ready: true,
    });
    codexDoctorMock.mockResolvedValue({
      installed: true,
      authenticated: true,
      authStatus: 'ok',
      cliVersion: '0.200.0',
      versionStatus: 'untested',
      exitCode: 0,
      stdout: 'codex 0.200.0',
      stderr: '',
    });
    render(withProviders(<HarnessStatusPanel harnessNames={['codex']} />));
    const hint = await screen.findByTestId('codex-version-hint-untested');
    expect(hint.textContent).toContain('0.200.0');
    expect(hint.textContent).toMatch(/outside the tested range/i);
  });

  it('does not render the untested-version hint when codex versionStatus is "ok"', async () => {
    harnessReadinessMock.mockResolvedValue({
      harnessName: 'codex',
      manifestCids: ['bafkreiswe'],
      ready: true,
    });
    // beforeEach already mocks codexDoctor with versionStatus='ok'.
    render(withProviders(<HarnessStatusPanel harnessNames={['codex']} />));
    await waitFor(() => screen.getByTestId('harness-row-codex'));
    // Give the codexDoctor query a tick to resolve.
    await waitFor(() => expect(codexDoctorMock).toHaveBeenCalled());
    expect(screen.queryByTestId('codex-version-hint-untested')).toBeNull();
  });
});
