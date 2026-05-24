import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TopTabs } from './TopTabs.js';

const listLaunchedMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    solvernets: {
      listLaunched: () => listLaunchedMock(),
    },
  },
}));

beforeEach(() => {
  listLaunchedMock.mockReset();
  listLaunchedMock.mockResolvedValue({ records: [] });
});

afterEach(() => {
  delete (window as { __JINN_FEATURES__?: unknown }).__JINN_FEATURES__;
});

function renderTabs(path: string): void {
  const { hook } = memoryLocation({ path });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <TopTabs />
      </Router>
    </QueryClientProvider>,
  );
}

describe('TopTabs', () => {
  it('marks Dashboard active when location is /overview', () => {
    renderTabs('/overview');
    const dashboard = screen.getByText('Dashboard');
    const events = screen.getByText('Events');
    const settings = screen.getByText('Settings');
    expect(dashboard.getAttribute('data-active')).toBe('true');
    expect(events.getAttribute('data-active')).toBe('false');
    expect(settings.getAttribute('data-active')).toBe('false');
  });

  it('marks Events active for event log routes', () => {
    renderTabs('/events/42');
    expect(screen.getByText('Events').getAttribute('data-active')).toBe('true');
  });

  it('marks Events active for request-scoped event log URLs', () => {
    renderTabs('/events?requestId=req-1');
    expect(screen.getByText('Events').getAttribute('data-active')).toBe('true');
  });

  it('does not render the Leaderboard tab while the leaderboard surface is disabled', () => {
    renderTabs('/overview');
    expect(screen.queryByText('Leaderboard')).toBeNull();
  });

  it('marks Settings active for operator routes', () => {
    renderTabs('/operator/join/bafybeiaaa');
    const settings = screen.getByText('Settings');
    expect(settings.getAttribute('data-active')).toBe('true');
  });

  it('marks Launcher active for launcher routes', () => {
    renderTabs('/launcher/create');
    const launcher = screen.getByText('Launcher');
    expect(launcher.getAttribute('data-active')).toBe('true');
    expect(listLaunchedMock).not.toHaveBeenCalled();
  });

  it('hides Launcher until there are owned launched records', async () => {
    renderTabs('/overview');
    expect(screen.queryByText('Launcher')).toBeNull();
    await waitFor(() => expect(listLaunchedMock).toHaveBeenCalledOnce());
    expect(screen.queryByText('Launcher')).toBeNull();
  });

  it('shows Launcher when owned launched records exist', async () => {
    listLaunchedMock.mockResolvedValue({ records: [{ solverNetId: 'sn-1' }] });
    renderTabs('/overview');
    await waitFor(() => expect(screen.getByText('Launcher')).toBeTruthy());
    expect(screen.getByText('Launcher').getAttribute('data-active')).toBe('false');
  });

  it('does not expose captures as a top-level tab', () => {
    renderTabs('/overview');
    expect(screen.queryByText('Captures')).toBeNull();
  });

  it('marks Settings active for execution data routes', () => {
    renderTabs('/operator/execution-data');
    const settings = screen.getByText('Settings');
    expect(settings.getAttribute('data-active')).toBe('true');
  });

  it('hides the Build tab when the pluginBuilderUi flag is off (default)', () => {
    renderTabs('/overview');
    expect(screen.queryByText('Build')).toBeNull();
  });

  it('renders the Build tab when the pluginBuilderUi flag is on', () => {
    window.__JINN_FEATURES__ = { pluginBuilderUi: true };
    renderTabs('/overview');
    expect(screen.getByText('Build')).toBeTruthy();
  });

  it('marks Build tab active on /build when the pluginBuilderUi flag is on', () => {
    window.__JINN_FEATURES__ = { pluginBuilderUi: true };
    renderTabs('/build');
    expect(screen.getByText('Build').getAttribute('data-active')).toBe('true');
  });
});
