import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OperatorSubNav } from './OperatorSubNav.js';

import type { JSX } from 'react';

function withRouter(path: string, node: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path });
  return <Router hook={hook}>{node}</Router>;
}

describe('OperatorSubNav', () => {
  it('renders one link per tab', () => {
    render(withRouter('/operator/claim-policy', <OperatorSubNav />));
    const nav = screen.getByRole('navigation', { name: /operator sections/i });
    const links = nav.querySelectorAll('a');
    expect(links).toHaveLength(5);
    const labels = Array.from(links).map((l) => l.textContent);
    expect(labels).toContain('Claim policy & wiring');
    expect(labels).not.toContain('Memberships');
    expect(labels).toContain('Registry');
    expect(labels).toContain('Execution data');
    expect(labels).toContain('Network');
    expect(labels).toContain('Security');
  });

  it('sets aria-current="page" on the active link for /operator/claim-policy', () => {
    render(withRouter('/operator/claim-policy', <OperatorSubNav />));
    const active = screen.getByRole('link', { name: 'Claim policy & wiring' });
    expect(active.getAttribute('aria-current')).toBe('page');
    // Other links should NOT have aria-current
    expect(screen.getByRole('link', { name: 'Registry' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Network' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Security' }).getAttribute('aria-current')).toBeNull();
  });

  it('sets aria-current="page" on the active link for /operator/network', () => {
    render(withRouter('/operator/network', <OperatorSubNav />));
    expect(screen.getByRole('link', { name: 'Network' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Claim policy & wiring' }).getAttribute('aria-current')).toBeNull();
  });

  it('sets aria-current="page" on the active link for /operator/security', () => {
    render(withRouter('/operator/security', <OperatorSubNav />));
    expect(screen.getByRole('link', { name: 'Security' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Registry' }).getAttribute('aria-current')).toBeNull();
  });

  it('sets aria-current="page" on the active link for /operator/registry', () => {
    render(withRouter('/operator/registry', <OperatorSubNav />));
    expect(screen.getByRole('link', { name: 'Registry' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Claim policy & wiring' }).getAttribute('aria-current')).toBeNull();
  });

  it('each link points to its canonical href', () => {
    render(withRouter('/operator/claim-policy', <OperatorSubNav />));
    expect(screen.getByRole('link', { name: 'Claim policy & wiring' }).getAttribute('href')).toBe('/operator/claim-policy');
    expect(screen.getByRole('link', { name: 'Registry' }).getAttribute('href')).toBe('/operator/registry');
    expect(screen.getByRole('link', { name: 'Network' }).getAttribute('href')).toBe('/operator/network');
    expect(screen.getByRole('link', { name: 'Security' }).getAttribute('href')).toBe('/operator/security');
  });
});
