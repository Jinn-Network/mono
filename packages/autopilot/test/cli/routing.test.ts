import { describe, it, expect } from 'vitest';
import { shouldRouteToSessions } from '../../src/cli/routing.js';

describe('shouldRouteToSessions', () => {
  it('routes when argv[2] is "sessions"', () => {
    expect(shouldRouteToSessions(['node', 'run-autopilot.ts', 'sessions'])).toBe(true);
  });

  it('does not route on dispatcher flags', () => {
    expect(shouldRouteToSessions(['node', 'run-autopilot.ts', '--dry-run'])).toBe(false);
  });

  it('does not route when argv has no third element', () => {
    expect(shouldRouteToSessions(['node', 'run-autopilot.ts'])).toBe(false);
  });

  it('does not route on length-1 argv (defensive against odd invocations)', () => {
    expect(shouldRouteToSessions(['node'])).toBe(false);
  });
});
