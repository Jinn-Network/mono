import { render, screen, fireEvent } from '@testing-library/react';
import { CheckpointTimeline } from './CheckpointTimeline';
import type { CheckpointTimelineData } from './CheckpointTimeline';

// ── Base fixture (enriched) ───────────────────────────────────────────────────

const FIXTURE: CheckpointTimelineData = {
  checkpoints: [
    {
      cid: 'bafkreiabc12345678xyz',
      agentId: '0xdeadbeefdeadbeef0001',
      publishedAtBlock: '1000000',
      name: 'claude-code-learner',
      version: '1.0.0',
      codeDigest: 'sha256:' + 'ab'.repeat(32),
      parentCheckpointCid: null,
      implName: 'claude-code-learner',
      implVersion: '1.0.0',
      sourceBundleCid: 'bafyreidummysourcebundle',
      enrichmentStatus: 'ok',
      frozenResolvedRate: 0.85,
      heldOutDelta: null,
      verifiedFrozen: true,
    },
    {
      cid: 'bafkreidef87654321abc',
      agentId: '0xdeadbeefdeadbeef0002',
      publishedAtBlock: '1050000',
      name: '',
      version: '',
      codeDigest: '',
      parentCheckpointCid: null,
      implName: '',
      implVersion: '',
      sourceBundleCid: '',
      enrichmentStatus: 'pending',
      frozenResolvedRate: null,
      heldOutDelta: null,
      verifiedFrozen: false,
    },
  ],
  note: 'Showing last 2 checkpoints.',
};

describe('CheckpointTimeline', () => {
  it('renders the note text', () => {
    render(<CheckpointTimeline data={FIXTURE} />);
    expect(screen.getByText('Showing last 2 checkpoints.')).toBeInTheDocument();
  });

  it('renders empty state when no checkpoints', () => {
    render(
      <CheckpointTimeline
        data={{ checkpoints: [], note: 'No note here.' }}
      />,
    );
    expect(
      screen.getByText('No published checkpoints yet.'),
    ).toBeInTheDocument();
  });

  it('renders the correct number of tick buttons', () => {
    render(<CheckpointTimeline data={FIXTURE} />);
    const ticks = screen.getAllByRole('button');
    expect(ticks).toHaveLength(FIXTURE.checkpoints.length);
  });

  it('renders block numbers as aria-labels on ticks', () => {
    render(<CheckpointTimeline data={FIXTURE} />);
    // block("1000000") → "1,000,000"
    expect(
      screen.getByLabelText(/1,000,000/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/1,050,000/),
    ).toBeInTheDocument();
  });

  it('renders the horizontal hairline track', () => {
    const { container } = render(<CheckpointTimeline data={FIXTURE} />);
    // The hairline is a div with height: 1 and background: var(--border)
    const hairlines = container.querySelectorAll(
      '[style*="background: var(--border)"]',
    );
    expect(hairlines.length).toBeGreaterThan(0);
  });

  it('renders empty-state note when checkpoints is empty', () => {
    render(
      <CheckpointTimeline
        data={{ checkpoints: [], note: 'Some note.' }}
      />,
    );
    // The note is rendered in empty state
    expect(screen.getByText('Some note.')).toBeInTheDocument();
  });

  it('does not show note when note is empty string', () => {
    render(<CheckpointTimeline data={{ checkpoints: FIXTURE.checkpoints, note: '' }} />);
    // The note container should not be rendered when note is empty
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument();
  });
});

// ── #820 AC#2 — held-out delta tooltip line ────────────────────────────────────
//
// The tooltip renders on focus/hover only. We focus the relevant tick, then
// assert the "held-out vs parent" line is present (with the right sign + color)
// when heldOutDelta is set, and absent when it is null.

function withDelta(delta: number | null): CheckpointTimelineData {
  return {
    checkpoints: [
      { ...FIXTURE.checkpoints[0], heldOutDelta: delta },
    ],
    note: '',
  };
}

describe('CheckpointTimeline held-out delta (#820 AC#2)', () => {
  it('renders the held-out line with a signed pct when delta is positive', () => {
    render(<CheckpointTimeline data={withDelta(0.12)} />);
    fireEvent.focus(screen.getByRole('button'));
    const line = screen.getByText(/held-out vs parent/i);
    expect(line).toBeInTheDocument();
    expect(line.textContent).toMatch(/\+12\.0%/);
    // improvement → success token
    expect(line.getAttribute('style')).toContain('var(--success)');
  });

  it('renders a negative signed pct in the regression color', () => {
    render(<CheckpointTimeline data={withDelta(-0.2)} />);
    fireEvent.focus(screen.getByRole('button'));
    const line = screen.getByText(/held-out vs parent/i);
    expect(line.textContent).toMatch(/-20\.0%/);
    expect(line.getAttribute('style')).toContain('var(--danger)');
  });

  it('renders zero delta in a muted color', () => {
    render(<CheckpointTimeline data={withDelta(0)} />);
    fireEvent.focus(screen.getByRole('button'));
    const line = screen.getByText(/held-out vs parent/i);
    expect(line.textContent).toMatch(/0\.0%/);
    expect(line.getAttribute('style')).toContain('var(--fg-dim)');
  });

  it('does not render the held-out line when delta is null', () => {
    render(<CheckpointTimeline data={withDelta(null)} />);
    fireEvent.focus(screen.getByRole('button'));
    expect(screen.queryByText(/held-out vs parent/i)).not.toBeInTheDocument();
  });
});
