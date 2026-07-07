import { render, screen } from '@testing-library/react';
import { StatusBar } from './StatusBar';

describe('StatusBar', () => {
  it('renders the block number', () => {
    render(
      <StatusBar lastIndexedBlock="12456789" lastIndexedAt={new Date(Date.now() - 30_000).toISOString()} />,
    );
    // block("12456789") → "12,456,789"
    expect(screen.getByText('12,456,789')).toBeInTheDocument();
  });

  it('shows — for missing block', () => {
    render(<StatusBar />);
    // Should render without crashing; block(undefined) → '—' (may appear multiple times)
    expect(screen.queryAllByText('—').length).toBeGreaterThan(0);
  });

  it('does not show degraded chip when degraded is false', () => {
    render(<StatusBar degraded={false} />);
    expect(screen.queryByText(/degraded/i)).not.toBeInTheDocument();
  });

  it('shows DEGRADED chip when degraded is true', () => {
    render(<StatusBar degraded />);
    expect(screen.getByLabelText(/discovery degraded/i)).toBeInTheDocument();
  });

  it('shows enrichment percentage when provided', () => {
    render(
      <StatusBar
        enrichmentSharePct={87}
        lastIndexedBlock="1000"
        lastIndexedAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByText('87%')).toBeInTheDocument();
    expect(screen.getByText('enriched')).toBeInTheDocument();
  });

  it('does not show enrichment when prop is absent', () => {
    render(<StatusBar lastIndexedBlock="1000" />);
    expect(screen.queryByText('enriched')).not.toBeInTheDocument();
  });

  it('renders "ago" text once as part of the time string', () => {
    const { container } = render(
      <StatusBar
        lastIndexedBlock="5000"
        lastIndexedAt={new Date(Date.now() - 90_000).toISOString()}
      />,
    );
    // relTime renders e.g. "2m ago" — find by regex
    expect(screen.getByText(/ago$/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/ago ago/i);
  });

  it('shows "blocks behind head" when behindHead > 0', () => {
    render(
      <StatusBar
        lastIndexedBlock="1000"
        lastIndexedAt={new Date().toISOString()}
        behindHead={5}
      />,
    );
    expect(screen.getByLabelText(/5 blocks behind head/i)).toBeInTheDocument();
  });

  it('does not show "blocks behind head" when behindHead is null', () => {
    render(
      <StatusBar
        lastIndexedBlock="1000"
        lastIndexedAt={new Date().toISOString()}
        behindHead={null}
      />,
    );
    expect(screen.queryByText(/blocks behind head/i)).not.toBeInTheDocument();
  });

  it('does not show "blocks behind head" when behindHead is 0', () => {
    render(
      <StatusBar
        lastIndexedBlock="1000"
        lastIndexedAt={new Date().toISOString()}
        behindHead={0}
      />,
    );
    expect(screen.queryByText(/blocks behind head/i)).not.toBeInTheDocument();
  });

  it('shows the Wane chip when behindHead > 100', () => {
    render(
      <StatusBar
        lastIndexedBlock="1000"
        lastIndexedAt={new Date().toISOString()}
        behindHead={150}
      />,
    );
    expect(screen.getByLabelText(/indexer falling behind head/i)).toBeInTheDocument();
  });

  it('does not show the Wane chip when behindHead is 50 (below threshold)', () => {
    render(
      <StatusBar
        lastIndexedBlock="1000"
        lastIndexedAt={new Date().toISOString()}
        behindHead={50}
      />,
    );
    expect(screen.queryByLabelText(/indexer falling behind head/i)).not.toBeInTheDocument();
  });
});
