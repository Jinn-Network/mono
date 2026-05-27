import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  sessionIdFromJsonlPath,
  defaultTranscriptWatchDirectories,
} from '../../src/trajectory/transcript-session-dirs.js';

describe('transcript-session-dirs', () => {
  it('derives session id from jsonl basename', () => {
    expect(sessionIdFromJsonlPath('/home/op/.codex/sessions/abc-123.jsonl')).toBe('abc-123');
    expect(sessionIdFromJsonlPath('/home/op/.claude/projects/foo/bar-sess.jsonl')).toBe('bar-sess');
  });

  it('defaultTranscriptWatchDirectories maps session ids from jsonl paths', () => {
    const dirs = defaultTranscriptWatchDirectories();
    for (const dir of dirs) {
      expect(dir.directory.length).toBeGreaterThan(0);
      expect(['codex', 'claude-code']).toContain(dir.tool);
      expect(dir.sessionIdFromPath(join(dir.directory, 's1.jsonl'))).toBe('s1');
    }
  });
});
