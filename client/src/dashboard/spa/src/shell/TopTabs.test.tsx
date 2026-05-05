import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { TopTabs } from './TopTabs.js';

describe('TopTabs', () => {
  it('marks Overview active when location is /overview', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    const overview = screen.getByText('Overview');
    const configuration = screen.getByText('Configuration');
    expect(overview.getAttribute('data-active')).toBe('true');
    expect(configuration.getAttribute('data-active')).toBe('false');
  });

  it('marks Configuration active when location is /configuration', () => {
    const { hook } = memoryLocation({ path: '/configuration' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    const configuration = screen.getByText('Configuration');
    expect(configuration.getAttribute('data-active')).toBe('true');
  });
});
