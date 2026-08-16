import { describe, expect, it } from 'vitest';
import { isEmbeddedAgentEnabled } from '../../src/api/server.js';

/**
 * Issue #326 / #367: the embedded Claude agent chat surface is gated behind
 * `JINN_ENABLE_EMBEDDED_AGENT`. `isEmbeddedAgentEnabled` stays a standalone
 * helper because the daemon reads it directly to gate the `/api/agent/ws`
 * bridge (Train 4 retires that socket).
 */
describe('isEmbeddedAgentEnabled', () => {
  it('defaults to false when the env var is unset', () => {
    expect(isEmbeddedAgentEnabled({})).toBe(false);
  });

  it('is true for "1"', () => {
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: '1' })).toBe(true);
  });

  it('is true for "true" (case-insensitive, trimmed)', () => {
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: 'true' })).toBe(true);
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: ' TRUE ' })).toBe(true);
  });

  it('is false for any other value', () => {
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: '0' })).toBe(false);
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: 'yes' })).toBe(false);
    expect(isEmbeddedAgentEnabled({ JINN_ENABLE_EMBEDDED_AGENT: '' })).toBe(false);
  });
});
