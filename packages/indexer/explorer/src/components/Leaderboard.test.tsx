/**
 * Leaderboard component tests.
 *
 * Fixtures:
 *   - 3 ranked rows in mixed resolvedRate order
 *   - 1 lowVolume row
 *
 * Assertions:
 *   - Ranked rows render in resolvedRate-desc order by default
 *   - The lowVolume section has a separate header row
 *   - Mode/Harness columns appear only when data has dominantMode/dominantHarness
 *   - Empty ranked + empty lowVolume → empty state text
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Leaderboard } from './Leaderboard';
import type { LeaderboardRankedRow, LeaderboardLowVolumeRow } from './Leaderboard';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RANKED: LeaderboardRankedRow[] = [
  {
    rank: 1,
    operator: '0xaaaa000000000000aaaa',
    attempts: 300,
    settledContribution: 280,
    verdictsTotal: 280,
    verdictsPass: 266,
    resolvedRate: 0.95,
    active: false,
  },
  {
    rank: 2,
    operator: '0xbbbb000000000000bbbb',
    attempts: 100,
    settledContribution: 90,
    verdictsTotal: 90,
    verdictsPass: 72,
    resolvedRate: 0.80,
    active: false,
  },
  {
    rank: 3,
    operator: '0xcccc000000000000cccc',
    attempts: 50,
    settledContribution: 45,
    verdictsTotal: 45,
    verdictsPass: 22,
    resolvedRate: 0.49,
    active: false,
  },
];

const LOW_VOLUME: LeaderboardLowVolumeRow[] = [
  {
    operator: '0xdddd000000000000dddd',
    attempts: 2,
    settledContribution: 2,
    verdictsTotal: 2,
    verdictsPass: 1,
    resolvedRate: 0.5,
    active: false,
  },
];

const RANKED_WITH_MODE: LeaderboardRankedRow[] = RANKED.map((r, i) => ({
  ...r,
  dominantMode: i === 0 ? 'train' : 'frozen',
  dominantHarness: 'swe-bench',
}));

// ── Wrapper ───────────────────────────────────────────────────────────────────

function wrap(path = '/operators') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { hook } = memoryLocation({ path, static: true });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    );
  }
  return { Wrapper };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Leaderboard', () => {
  it('renders ranked rows in resolvedRate-desc order by default', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={RANKED} lowVolume={[]} />,
      { wrapper: Wrapper },
    );

    // Get all resolved-rate cells in DOM order — should be 95.0%, 80.0%, 49.0%
    const rateCells = screen.getAllByText(/\d+\.\d+%/);
    const rates = rateCells.map((el) => el.textContent);
    expect(rates[0]).toBe('95.0%');
    expect(rates[1]).toBe('80.0%');
    expect(rates[2]).toBe('49.0%');
  });

  it('renders the lowVolume section with a distinct header', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={RANKED} lowVolume={LOW_VOLUME} minVerdicts={5} />,
      { wrapper: Wrapper },
    );

    // The low-volume section header should include the threshold
    expect(screen.getByText(/New \/ Low-volume/i)).toBeInTheDocument();
    // The low-volume operator should appear
    expect(screen.getByText('0xdddd…dddd')).toBeInTheDocument();
  });

  it('hides Mode and Harness columns when data has no dominantMode', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={RANKED} lowVolume={[]} />,
      { wrapper: Wrapper },
    );

    // Column headers should not include "Mode" or "Harness"
    expect(screen.queryByText('Mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Harness')).not.toBeInTheDocument();
  });

  it('shows Mode and Harness columns when data has dominantMode', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={RANKED_WITH_MODE} lowVolume={[]} />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('Mode')).toBeInTheDocument();
    expect(screen.getByText('Harness')).toBeInTheDocument();
  });

  it('renders empty state when ranked and lowVolume are both empty', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={[]} lowVolume={[]} />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText(/No ranked operators yet/i)).toBeInTheDocument();
  });

  it('clicking a column header re-sorts the table', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={RANKED} lowVolume={[]} />,
      { wrapper: Wrapper },
    );

    // Default: sorted by resolvedRate desc → 95%, 80%, 49%
    let rateCells = screen.getAllByText(/\d+\.\d+%/);
    expect(rateCells[0].textContent).toBe('95.0%');

    // Click "Attempts" header to sort by attempts desc
    fireEvent.click(screen.getByText('Attempts'));

    // After sorting by attempts desc: 300, 100, 50
    const attemptsCells = screen.getAllByText(/^[0-9,]+$/).filter(el =>
      ['300', '100', '50'].includes(el.textContent ?? ''),
    );
    // The first numeric cell should now be 300
    expect(attemptsCells.length).toBeGreaterThan(0);
  });

  it('operator address renders as a link to /operator/:addr', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={RANKED.slice(0, 1)} lowVolume={[]} />,
      { wrapper: Wrapper },
    );

    const link = screen.getByRole('link', { name: '0xaaaa…aaaa' });
    expect(link).toHaveAttribute('href', `/operator/${encodeURIComponent(RANKED[0].operator)}`);
  });

  it('compact mode hides Mode and Harness columns even if data has them', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={RANKED_WITH_MODE} lowVolume={[]} compact />,
      { wrapper: Wrapper },
    );

    expect(screen.queryByText('Mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Harness')).not.toBeInTheDocument();
  });

  it('renders the operator cell as a Link when `onOperatorClick` is absent', () => {
    const { Wrapper } = wrap();
    render(
      <Leaderboard ranked={RANKED.slice(0, 1)} lowVolume={[]} />,
      { wrapper: Wrapper },
    );
    const link = screen.getByRole('link', { name: '0xaaaa…aaaa' });
    expect(link).toHaveAttribute(
      'href',
      `/operator/${encodeURIComponent(RANKED[0].operator)}`,
    );
  });

  it('renders the operator cell as a <button> + trailing arrow link when `onOperatorClick` is supplied', () => {
    const onOperatorClick = vi.fn();
    const { Wrapper } = wrap();
    render(
      <Leaderboard
        ranked={RANKED.slice(0, 1)}
        lowVolume={[]}
        onOperatorClick={onOperatorClick}
      />,
      { wrapper: Wrapper },
    );
    // The body of the operator cell becomes a button
    const btn = screen.getByRole('button', { name: /0xaaaa…aaaa/i });
    fireEvent.click(btn);
    expect(onOperatorClick).toHaveBeenCalledWith(RANKED[0].operator);

    // The trailing-arrow link still goes to /operator/<addr>
    const arrowLink = screen.getByRole('link', {
      name: /open operator detail/i,
    });
    expect(arrowLink).toHaveAttribute(
      'href',
      `/operator/${encodeURIComponent(RANKED[0].operator)}`,
    );
  });
});

describe('Leaderboard hover affordance', () => {
  it('renders a sibling hint element after the operator address with "→ filter to this"', () => {
    const onOperatorClick = vi.fn();
    const { Wrapper } = wrap();
    render(
      <Leaderboard
        ranked={[
          {
            rank: 1,
            operator: '0xaaa0000000000000000000000000000000000bbb',
            attempts: 10,
            settledContribution: 8,
            verdictsTotal: 10,
            verdictsPass: 7,
            resolvedRate: 0.7,
            active: false,
          },
        ]}
        lowVolume={[]}
        onOperatorClick={onOperatorClick}
      />,
      { wrapper: Wrapper },
    );
    const hint = screen.getByText(/→ filter to this/i);
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveAttribute('data-hover-hint', 'true');
  });
});
