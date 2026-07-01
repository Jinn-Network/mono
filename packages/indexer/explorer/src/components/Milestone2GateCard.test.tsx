import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Milestone2GateCard } from './Milestone2GateCard';
import { computeMilestone2Gate } from '../lib/milestone2';

function gateOf(n: number, baseline: number, current: number) {
  const r = new Array(n).fill(0.42);
  if (n >= 130) {
    r[n - 100] = baseline;
    r[n - 1] = current;
  }
  return computeMilestone2Gate(r);
}

describe('Milestone2GateCard', () => {
  it('shows PASS and the signed delta when the gate is cleared', () => {
    const { container } = render(
      <Milestone2GateCard gate={gateOf(140, 0.5, 0.7)} />,
    );
    expect(container.textContent).toContain('PASS');
    expect(container.textContent).toMatch(/\+20\.0/); // delta in pp
  });

  it('shows NOT YET when eligible but below the 10pp gate', () => {
    const { container } = render(
      <Milestone2GateCard gate={gateOf(140, 0.5, 0.55)} />,
    );
    expect(container.textContent).toContain('NOT YET');
    expect(container.textContent).not.toContain('PASS');
  });

  it('shows the 130-verdict floor message when ineligible', () => {
    const { container } = render(
      <Milestone2GateCard gate={gateOf(42, 0, 0)} />,
    );
    expect(container.textContent).toMatch(/130/);
    expect(container.textContent).toMatch(/42/);
  });

  it('renders a skeleton while loading', () => {
    const { container } = render(<Milestone2GateCard gate={null} loading />);
    expect(container.querySelector('[data-testid="m2-skeleton"]')).toBeTruthy();
  });
});
