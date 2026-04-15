import { describe, expect, it, afterEach } from 'vitest';
import { isControlApiEnabled } from 'jinn-node/env/control.js';

describe('isControlApiEnabled', () => {
  const originalEnv = process.env.USE_CONTROL_API;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.USE_CONTROL_API;
    } else {
      process.env.USE_CONTROL_API = originalEnv;
    }
  });

  it('returns true when USE_CONTROL_API is not set (default behavior)', () => {
    delete process.env.USE_CONTROL_API;
    expect(isControlApiEnabled()).toBe(true);
  });

  it('returns true when USE_CONTROL_API is explicitly set to "true"', () => {
    process.env.USE_CONTROL_API = 'true';
    expect(isControlApiEnabled()).toBe(true);
  });

  it('returns true when USE_CONTROL_API is set to "1"', () => {
    process.env.USE_CONTROL_API = '1';
    expect(isControlApiEnabled()).toBe(true);
  });

  it('returns true when USE_CONTROL_API is set to any truthy string', () => {
    process.env.USE_CONTROL_API = 'yes';
    expect(isControlApiEnabled()).toBe(true);
  });

  it('returns false when USE_CONTROL_API is explicitly set to "false"', () => {
    process.env.USE_CONTROL_API = 'false';
    expect(isControlApiEnabled()).toBe(false);
  });

  it('returns true when USE_CONTROL_API is set to empty string', () => {
    process.env.USE_CONTROL_API = '';
    expect(isControlApiEnabled()).toBe(true);
  });
});
