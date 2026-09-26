import { afterEach, beforeEach } from 'vitest';

/**
 * Isolate `keys` from ambient `process.env` for every test in the calling
 * scope: each key is saved and cleared before the test, then restored after
 * it (or removed again if it was absent).
 */
export function isolateEnv(keys: readonly string[]): void {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
