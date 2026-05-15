import { render, screen } from '@testing-library/react';
import { LearningCurve } from './LearningCurve';
import type { LearningCurveBucket } from '../lib/api';

// uPlot uses canvas which jsdom doesn't support.
// The component guards against this: it shows "No data yet" for empty data,
// and for non-empty data renders a div container (uPlot init may throw/no-op in jsdom).
// We verify the component mounts cleanly in both cases.

const BUCKETS: LearningCurveBucket[] = [
  { bucketStartBlock: '1000000', total: 20, pass: 15, rate: 0.75 },
  { bucketStartBlock: '1007200', total: 18, pass: 14, rate: 0.78 },
  { bucketStartBlock: '1014400', total: 22, pass: 19, rate: 0.864 },
];

const ROLLING = [0.6, 0.7, 0.75, 0.8, 0.82, 0.85];

describe('LearningCurve', () => {
  it('renders "No data yet" for empty rolling mode', () => {
    render(
      <LearningCurve buckets={[]} rolling={[]} mode="rolling" />,
    );
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('renders "No data yet" for empty buckets mode', () => {
    render(
      <LearningCurve buckets={[]} rolling={[]} mode="buckets" />,
    );
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('renders the plot container for non-empty rolling data without crashing', () => {
    render(
      <LearningCurve buckets={BUCKETS} rolling={ROLLING} mode="rolling" />,
    );
    // The container div should be present (uPlot may or may not render in jsdom)
    expect(screen.getByTestId('learning-curve-plot')).toBeInTheDocument();
  });

  it('renders the plot container for non-empty buckets data without crashing', () => {
    render(
      <LearningCurve buckets={BUCKETS} rolling={ROLLING} mode="buckets" />,
    );
    expect(screen.getByTestId('learning-curve-plot')).toBeInTheDocument();
  });

  it('respects the height prop on the empty state', () => {
    const { container } = render(
      <LearningCurve buckets={[]} rolling={[]} mode="rolling" height={300} />,
    );
    const emptyDiv = container.querySelector('[style*="height"]') as HTMLElement | null;
    expect(emptyDiv).toBeTruthy();
  });

  it('cleans up on unmount without throwing', () => {
    const { unmount } = render(
      <LearningCurve buckets={BUCKETS} rolling={ROLLING} mode="rolling" />,
    );
    expect(() => unmount()).not.toThrow();
  });

  it('switches mode from rolling to buckets without crashing', () => {
    const { rerender } = render(
      <LearningCurve buckets={BUCKETS} rolling={ROLLING} mode="rolling" />,
    );
    expect(() => {
      rerender(
        <LearningCurve buckets={BUCKETS} rolling={ROLLING} mode="buckets" />,
      );
    }).not.toThrow();
  });
});
