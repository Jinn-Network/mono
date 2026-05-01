import { describe, it, expect } from 'vitest';
import { detectAutoModeAvailable } from '../../src/agent/auto-mode-detect.js';

describe('detectAutoModeAvailable', () => {
  it('returns available=false when binary does not exist', async () => {
    const res = await detectAutoModeAvailable('/nonexistent/claude');
    expect(res.available).toBe(false);
    expect(res.reason).toContain('failed');
  });
});
