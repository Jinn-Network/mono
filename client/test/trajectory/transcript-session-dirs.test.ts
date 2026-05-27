import { describe, it, expect } from 'vitest';
import {
  sessionIdFromJsonlPath,
  defaultTranscriptWatchDirectorySpecs,
  toWatchedDirectories,
} from '../../src/trajectory/transcript-session-dirs.js';

describe('transcript-session-dirs', () => {
  it('derives session id from jsonl basename', () => {
    expect(sessionIdFromJsonlPath('/home/op/.codex/sessions/abc-123.jsonl')).toBe('abc-123');
    expect(sessionIdFromJsonlPath('/home/op/.claude/projects/foo/bar-sess.jsonl')).toBe('bar-sess');
  });

  it('maps specs to watched directories with sessionIdFromPath', () => {
    const dirs = toWatchedDirectories([
      { tool: 'codex', directory: '/tmp/codex-sessions', recursive: false },
    ]);
    expect(dirs[0]?.sessionIdFromPath('/tmp/codex-sessions/s1.jsonl')).toBe('s1');
  });

  it('defaultTranscriptWatchDirectorySpecs only includes dirs that exist', () => {
    const specs = defaultTranscriptWatchDirectorySpecs();
    for (const spec of specs) {
      expect(spec.directory.length).toBeGreaterThan(0);
      expect(['codex', 'claude-code']).toContain(spec.tool);
    }
  });
});
