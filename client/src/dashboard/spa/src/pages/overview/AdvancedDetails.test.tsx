import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdvancedDetails } from './AdvancedDetails.js';

describe('AdvancedDetails', () => {
  it('renders the eyebrow', () => {
    render(<AdvancedDetails />);
    expect(screen.getByText(/advanced details/i)).toBeTruthy();
  });
});
