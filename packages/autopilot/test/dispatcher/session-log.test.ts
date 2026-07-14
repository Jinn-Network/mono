import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SESSIONS_LOG_DIR, sessionLogPath } from '../../src/dispatcher/session-log.js';

describe('session-log path scheme', () => {
  it('SESSIONS_LOG_DIR is ~/.jinn-client/autopilot/sessions resolved from homedir', () => {
    expect(SESSIONS_LOG_DIR).toBe(join(homedir(), '.jinn-client', 'autopilot', 'sessions'));
    // Absolute path so tail -f works from any cwd (AC#3).
    expect(SESSIONS_LOG_DIR).toMatch(/^\//);
  });

  it('sessionLogPath(N) is <dir>/<N>.log — stable + deterministic (AC#1, AC#4)', () => {
    expect(sessionLogPath(418)).toBe(join(SESSIONS_LOG_DIR, '418.log'));
    // Deterministic: same input → same output (stable path, not timestamped).
    expect(sessionLogPath(418)).toBe(sessionLogPath(418));
  });

  it('uses the numeric issue number verbatim in the filename', () => {
    expect(sessionLogPath(7)).toBe(join(SESSIONS_LOG_DIR, '7.log'));
    expect(sessionLogPath(1234)).toBe(join(SESSIONS_LOG_DIR, '1234.log'));
  });
});
