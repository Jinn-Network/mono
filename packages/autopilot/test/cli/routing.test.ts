import { describe, it, expect } from 'vitest';
import {
  shouldRouteToSession,
  shouldRouteToSessions,
} from '../../src/cli/routing.js';

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

describe('shouldRouteToSession', () => {
  it('routes only the singular internal session subcommand', () => {
    expect(shouldRouteToSession(['node', 'run-autopilot.ts', 'session', 'checkpoint']))
      .toBe(true);
    expect(shouldRouteToSession(['node', 'run-autopilot.ts', 'sessions']))
      .toBe(false);
    expect(shouldRouteToSession(['node', 'run-autopilot.ts', '--once']))
      .toBe(false);
  });
});
