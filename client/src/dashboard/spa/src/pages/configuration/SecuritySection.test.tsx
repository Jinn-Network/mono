import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecuritySection } from './SecuritySection.js';

describe('SecuritySection', () => {
  it('renders the section card with danger framing', () => {
    render(<SecuritySection defaultExpanded={false} />);
    expect(screen.getByText(/security/i)).toBeTruthy();
    expect(screen.getByText(/danger zone/i)).toBeTruthy();
  });
});
