import { describe, expect, it } from 'vitest';
import { configRequiresClaudeAuth } from '../../src/preflight/claude-required.js';

describe('configRequiresClaudeAuth', () => {
  it('requires Claude auth by default because Claude Code remains the fallback harness', () => {
    expect(configRequiresClaudeAuth({})).toBe(true);
  });

  it('skips Claude auth when every Claude-backed harness is disabled', () => {
    expect(configRequiresClaudeAuth({
      harnesses: {
        disabled: [
          'legacy-claude',
          'claude-code',
          'claude-mcp-hyperliquid',
          'claude-mcp-prediction',
          'claude-mcp-prediction-apy',
        ],
      },
    })).toBe(false);
  });

  it('treats learner aliases as the same Claude-backed harness', () => {
    expect(configRequiresClaudeAuth({
      harnesses: {
        disabled: [
          'legacy-claude',
          'claude-code-learner',
          'claude-mcp-hyperliquid',
          'claude-mcp-prediction',
          'claude-mcp-prediction-apy',
        ],
      },
    })).toBe(false);
  });

  it('keeps the preflight for external harnesses because their auth needs are unknown', () => {
    expect(configRequiresClaudeAuth({
      harnesses: {
        disabled: [
          'legacy-claude',
          'claude-code',
          'claude-mcp-hyperliquid',
          'claude-mcp-prediction',
          'claude-mcp-prediction-apy',
        ],
        externalImpls: [{ name: '@example/custom' }],
      },
    })).toBe(true);
  });
});
