import { describe, expect, it } from 'vitest';
import {
  IdleWindowCaptureDeduper,
  captureBoundaryKey,
  decideCaptureBoundary,
} from '../../src/captures/dedup.js';

describe('capture dedup/session-boundary detection', () => {
  it('builds a stable key from repo, transcript, and session provenance', () => {
    expect(captureBoundaryKey({
      tool: 'claude-code',
      observedAtMs: 1,
      sessionId: 'sess-1',
      repoRemoteUrl: 'git@example.com/repo',
      repoCommitHash: 'a'.repeat(40),
      transcriptPath: '/tmp/transcript.jsonl',
    })).toBe(`claude-code|git@example.com/repo@${'a'.repeat(40)}|/tmp/transcript.jsonl|sess-1`);
  });

  it('keeps nearby events in the same session until an idle window is crossed', () => {
    const previous = { tool: 'codex', observedAtMs: 0, sessionId: 'sess-1' };
    expect(decideCaptureBoundary(previous, {
      tool: 'codex',
      observedAtMs: 1_000,
      sessionId: 'sess-1',
    }).startsNewSession).toBe(false);

    expect(decideCaptureBoundary(previous, {
      tool: 'codex',
      observedAtMs: 5 * 60 * 1000,
      sessionId: 'sess-1',
    })).toMatchObject({ startsNewSession: true, reason: 'idle-window' });
  });

  it('treats explicit stop hooks and transcript changes as hard boundaries', () => {
    const deduper = new IdleWindowCaptureDeduper({ idleWindowMs: 60_000 });
    expect(deduper.observe({
      tool: 'cursor',
      observedAtMs: 0,
      repoRemoteUrl: 'git@example.com/repo',
      transcriptPath: '/tmp/a.jsonl',
    }).reason).toBe('first-event');
    expect(deduper.observe({
      tool: 'cursor',
      observedAtMs: 1,
      repoRemoteUrl: 'git@example.com/repo',
      transcriptPath: '/tmp/b.jsonl',
    })).toMatchObject({ startsNewSession: true, reason: 'transcript-marker' });
    expect(deduper.observe({
      tool: 'cursor',
      observedAtMs: 2,
      repoRemoteUrl: 'git@example.com/repo',
      transcriptPath: '/tmp/b.jsonl',
      explicitStop: true,
    })).toMatchObject({ startsNewSession: true, reason: 'explicit-stop' });
  });
});
