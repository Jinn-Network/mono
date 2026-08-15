import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IntroCard } from './IntroCard.js';

describe('IntroCard (hfmf)', () => {
  it('renders the quickstart heading', () => {
    render(<IntroCard />);
    expect(screen.getByRole('heading', { level: 1, name: /build a plug-in/i })).toBeTruthy();
  });

  it('renders the jinn create plugin command in a code block', () => {
    render(<IntroCard />);
    expect(screen.getByText(/jinn create plugin/)).toBeTruthy();
  });

  it('links to the full quickstart doc on github', () => {
    render(<IntroCard />);
    const link = screen.getByRole('link', { name: /full quickstart/i });
    expect(link.getAttribute('href')).toMatch(/docs\/build\/quickstart\.md$/);
  });
});
