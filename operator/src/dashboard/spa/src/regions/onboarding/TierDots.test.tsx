import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TierDots } from './TierDots.js';

describe('TierDots', () => {
  it('renders three tier indicators', () => {
    render(<TierDots protocol node machine />);
    expect(screen.getByTestId('tier-dots').querySelectorAll('[data-tier]')).toHaveLength(3);
  });

  it('marks the machine tier inactive when not installed', () => {
    render(<TierDots protocol node machine={false} />);
    const machineDot = screen
      .getByTestId('tier-dots')
      .querySelector('[data-tier="machine"]');
    expect(machineDot?.getAttribute('data-active')).toBe('false');
  });
});
