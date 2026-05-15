import { render, screen } from '@testing-library/react';
import { HBars } from './HBars';

const FIXTURE = [
  { label: 'mode-a', value: 80, share: 0.8 },
  { label: 'mode-b', value: 15, share: 0.15 },
  { label: 'mode-c', value: 5, share: 0.05 },
];

describe('HBars', () => {
  it('renders each label', () => {
    render(<HBars data={FIXTURE} />);
    expect(screen.getByText('mode-a')).toBeInTheDocument();
    expect(screen.getByText('mode-b')).toBeInTheDocument();
    expect(screen.getByText('mode-c')).toBeInTheDocument();
  });

  it('renders percentage strings', () => {
    render(<HBars data={FIXTURE} />);
    // pct(0.8) → "80.0%", pct(0.15) → "15.0%", etc.
    expect(screen.getByText('80.0%')).toBeInTheDocument();
    expect(screen.getByText('15.0%')).toBeInTheDocument();
  });

  it('renders formatted integer counts', () => {
    render(<HBars data={FIXTURE} />);
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('renders a title when provided', () => {
    render(<HBars data={FIXTURE} title="By mode" />);
    expect(screen.getByText('By mode')).toBeInTheDocument();
  });

  it('renders "No data" for empty data array', () => {
    render(<HBars data={[]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('renders correct number of bar rows', () => {
    const { container } = render(<HBars data={FIXTURE} />);
    // Each entry has a label and a bar track
    const barTracks = container.querySelectorAll('[style*="bg-sunken"]');
    expect(barTracks.length).toBe(FIXTURE.length);
  });
});
