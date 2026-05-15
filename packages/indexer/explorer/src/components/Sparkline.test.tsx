import { render } from '@testing-library/react';
import { Sparkline } from './Sparkline';

describe('Sparkline', () => {
  it('renders an SVG with a polyline for a 3-point series', () => {
    const { container } = render(<Sparkline data={[0.4, 0.7, 0.9]} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    const polyline = container.querySelector('polyline');
    expect(polyline).toBeTruthy();
    // Points attribute should contain 3 coordinate pairs
    const points = polyline!.getAttribute('points')!;
    const pairs = points.trim().split(' ');
    expect(pairs.length).toBe(3);
  });

  it('renders nothing for an empty data array', () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders nothing for a single-point data array', () => {
    const { container } = render(<Sparkline data={[0.5]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a terminal dot circle for a 2-point series', () => {
    const { container } = render(<Sparkline data={[0.3, 0.8]} />);
    const circle = container.querySelector('circle');
    expect(circle).toBeTruthy();
  });

  it('respects width and height props', () => {
    const { container } = render(<Sparkline data={[0.2, 0.5, 0.8]} width={80} height={24} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('80');
    expect(svg?.getAttribute('height')).toBe('24');
  });

  it('draws a flat line when all values are equal (midpoint)', () => {
    const { container } = render(<Sparkline data={[0.5, 0.5, 0.5]} height={20} />);
    const polyline = container.querySelector('polyline')!;
    const points = polyline.getAttribute('points')!.trim().split(' ');
    // All y-coords should be the midpoint (10 for height=20)
    for (const pt of points) {
      const [, y] = pt.split(',').map(Number);
      expect(y).toBeCloseTo(10);
    }
  });

  it('applies a custom color prop to stroke and fill', () => {
    const { container } = render(<Sparkline data={[0.3, 0.6]} color="#ff0000" />);
    const polyline = container.querySelector('polyline');
    expect(polyline?.getAttribute('stroke')).toBe('#ff0000');
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('fill')).toBe('#ff0000');
  });

  it('does not crash for all-zero data', () => {
    expect(() => render(<Sparkline data={[0, 0, 0, 0]} />)).not.toThrow();
  });

  it('does not crash for all-one data', () => {
    expect(() => render(<Sparkline data={[1, 1, 1]} />)).not.toThrow();
  });
});
