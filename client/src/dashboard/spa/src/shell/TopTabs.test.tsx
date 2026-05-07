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
    const operator = screen.getByText('Operator');
    const launcher = screen.getByText('Launcher');
    expect(overview.getAttribute('data-active')).toBe('true');
    expect(operator.getAttribute('data-active')).toBe('false');
    expect(launcher.getAttribute('data-active')).toBe('false');
  });

  it('marks Operator active for operator routes', () => {
    const { hook } = memoryLocation({ path: '/operator/join/bafybeiaaa' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    const operator = screen.getByText('Operator');
    expect(operator.getAttribute('data-active')).toBe('true');
  });

  it('marks Launcher active for launcher routes', () => {
    const { hook } = memoryLocation({ path: '/launcher/create' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    const launcher = screen.getByText('Launcher');
    expect(launcher.getAttribute('data-active')).toBe('true');
  });
});
