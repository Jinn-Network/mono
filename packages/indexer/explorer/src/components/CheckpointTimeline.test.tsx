import { render, screen } from '@testing-library/react';
import { CheckpointTimeline } from './CheckpointTimeline';
import type { CheckpointTimelineData } from './CheckpointTimeline';

const FIXTURE: CheckpointTimelineData = {
  checkpoints: [
    {
      cid: 'bafkreiabc12345678xyz',
      agentId: '0xdeadbeefdeadbeef0001',
      publishedAtBlock: '1000000',
    },
    {
      cid: 'bafkreidef87654321abc',
      agentId: '0xdeadbeefdeadbeef0002',
      publishedAtBlock: '1050000',
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
});
