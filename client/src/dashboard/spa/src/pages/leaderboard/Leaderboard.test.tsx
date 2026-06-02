import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeaderboardPage } from './Leaderboard.js';

import type { JSX } from 'react';

// Prevent real fetch calls from the useQuery hooks during tests.
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ rollups: [] }),
}));

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('LeaderboardPage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders Train and Frozen tabs', () => {
    render(withQuery(<LeaderboardPage solverNet="prediction" />));
    expect(screen.getByRole('tab', { name: /train/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /frozen/i })).toBeTruthy();
  });

  it('Train tab is selected by default', () => {
    render(withQuery(<LeaderboardPage solverNet="prediction" />));
    const trainTab = screen.getByRole('tab', { name: /train/i });
    expect(trainTab.getAttribute('aria-selected')).toBe('true');
    const frozenTab = screen.getByRole('tab', { name: /frozen/i });
    expect(frozenTab.getAttribute('aria-selected')).toBe('false');
  });

  it('switches to Frozen tab on click', () => {
    render(withQuery(<LeaderboardPage solverNet="prediction" />));
    const frozenTab = screen.getByRole('tab', { name: /frozen/i });
    // Radix Tabs activates on mousedown, not click — fireEvent.click in
    // jsdom does not dispatch a synthesized pointer/mousedown sequence,
    // so we drive the activation explicitly. The real-browser interaction
    // (mouse click) still works because the browser fires mousedown first.
    fireEvent.mouseDown(frozenTab);
    expect(frozenTab.getAttribute('aria-selected')).toBe('true');
    const trainTab = screen.getByRole('tab', { name: /train/i });
    expect(trainTab.getAttribute('aria-selected')).toBe('false');
  });

  it('fetches from train leaderboard endpoint when Train tab active', () => {
    render(withQuery(<LeaderboardPage solverNet="prediction" />));
    // Default is train tab — verify fetch was called with train mode
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('mode=train'),
      expect.any(Object),
    );
  });

  it('fetches from frozen leaderboard endpoint after switching to Frozen', () => {
    render(withQuery(<LeaderboardPage solverNet="prediction" />));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /frozen/i }));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('mode=frozen'),
      expect.any(Object),
    );
  });
});
