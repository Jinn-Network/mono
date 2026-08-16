import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emitClaudeBinaryPreflightFailure,
  sanitizedClaudeAttemptedForEnvelope,
} from '../../src/preflight/claude-invocation-envelope.js';

describe('emitClaudeBinaryPreflightFailure', () => {
  it('writes invalid_invocation with exit 11 and claude_binary details', () => {
    const writes: string[] = [];
    const exits: number[] = [];
    emitClaudeBinaryPreflightFailure("claude binary 'claude' not found on PATH", 'claude', {
      writer: {
        write: (s: string) => {
          writes.push(s);
          return true;
        },
      },
      exit: (c: number) => {
        exits.push(c);
      },
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]!) as Record<string, unknown>;
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(JSON.stringify(parsed)).not.toMatch(/JINN_/);
    expect(parsed.details).toEqual({
      field: 'claude_binary',
      expected: 'executable claude binary',
      attempted: 'claude',
    });
    expect(exits).toEqual([11]);
  });

  it('redacts ~/.jinn-client paths from message and attempted', () => {
    const sensitive = join(homedir(), '.jinn-client', 'bin', 'claude');
    const detail = `claude binary not found at ${sensitive}`;

    expect(sanitizedClaudeAttemptedForEnvelope(sensitive)).toBe('configured path');

    const writes: string[] = [];
    emitClaudeBinaryPreflightFailure(detail, sensitive, {
      writer: {
        write: (s: string) => {
          writes.push(s);
          return true;
        },
      },
      exit: () => {
        /* no-op */
      },
    });

    const parsed = JSON.parse(writes[0]!) as { message: string; details?: { attempted?: string } };
    expect(parsed.message).not.toContain('.jinn-client');
    expect(parsed.message).not.toContain(sensitive);
    expect(parsed.details?.attempted).toBe('configured path');
  });
});
