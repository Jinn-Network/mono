import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolateEnv } from './env.js';

const K = 'JINN_TEST_ISOLATE_ENV_K';
const K2 = 'JINN_TEST_ISOLATE_ENV_K2';

beforeAll(() => {
  process.env[K] = 'ambient';
  delete process.env[K2];
});

afterAll(() => {
  delete process.env[K];
  delete process.env[K2];
});

describe('isolateEnv', () => {
  isolateEnv([K, K2]);

  it('clears each key for the test, which may then set it freely', () => {
    expect(process.env[K]).toBeUndefined();
    process.env[K] = 'set-by-test';
    process.env[K2] = 'set-by-test';
  });
});

// Runs after the isolated block: its afterEach must have restored both keys.
describe('after isolateEnv', () => {
  it('restores a present key and removes a key that was absent', () => {
    expect(process.env[K]).toBe('ambient');
    expect(K2 in process.env).toBe(false);
  });
});
