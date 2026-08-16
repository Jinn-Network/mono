import { afterEach, describe, expect, it } from 'vitest';
import {
  isRestartRequired,
  markRestartRequired,
  resetRestartRequiredForTest,
} from '../../src/api/restart-required-state.js';

describe('restart-required-state (issue #2408 review finding F1)', () => {
  afterEach(() => {
    resetRestartRequiredForTest();
  });

  it('defaults to false (fresh boot)', () => {
    expect(isRestartRequired()).toBe(false);
  });

  it('flips to true once marked, and stays true', () => {
    markRestartRequired();
    expect(isRestartRequired()).toBe(true);
    markRestartRequired(); // idempotent
    expect(isRestartRequired()).toBe(true);
  });

  it('resets to false via the test-only helper', () => {
    markRestartRequired();
    resetRestartRequiredForTest();
    expect(isRestartRequired()).toBe(false);
  });
});
