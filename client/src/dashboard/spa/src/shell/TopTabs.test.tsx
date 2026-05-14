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

  it('does not render the Leaderboard tab while the leaderboard surface is disabled', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    expect(screen.queryByText('Leaderboard')).toBeNull();
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

  it('does not expose captures as a top-level tab', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    expect(screen.queryByText('Captures')).toBeNull();
  });

  it('marks Operator active for execution data routes', () => {
    const { hook } = memoryLocation({ path: '/operator/execution-data' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    const operator = screen.getByText('Operator');
    expect(operator.getAttribute('data-active')).toBe('true');
  });

  it('renders the Build tab', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    expect(screen.getByText('Build')).toBeTruthy();
  });

  it('marks Build tab active on /build', () => {
    const { hook } = memoryLocation({ path: '/build' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    expect(screen.getByText('Build').getAttribute('data-active')).toBe('true');
  });
});
