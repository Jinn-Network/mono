import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RestartPill } from './RestartPill.js';

describe('RestartPill', () => {
  it('renders "restart"', () => {
    render(<RestartPill />);
    expect(screen.getByText(/restart/i)).toBeTruthy();
  });
});
