import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentActivity } from './RecentActivity.js';

describe('RecentActivity', () => {
  it('renders the eyebrow', () => {
    render(<RecentActivity events={[]} />);
    expect(screen.getByText(/recent activity/i)).toBeTruthy();
  });
});
