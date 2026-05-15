import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';
import { CapturesStore } from '../../src/store/captures.js';

describe('CapturesStore', () => {
  let store: Store;
  let captures: CapturesStore;

  beforeEach(() => {
    store = new Store(':memory:');
    captures = new CapturesStore(store);
  });

  afterEach(() => store.close());

  it('saves and lists pending captures', () => {
    captures.savePending({
      sessionId: 'sess-1',
      capturedAt: '2026-05-07T00:00:00.000Z',
      originatingTool: { name: 'claude-code', version: '1.0.42' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 42,
      durationMs: 60_000,
      redactedSpanCount: 3,
      repoRemoteUrl: 'git@github.com:Jinn-Network/mono.git',
      repoCommitHash: 'abcd1234' + 'e'.repeat(32),
    });
    const pending = captures.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe('sess-1');
    expect(pending[0].status).toBe('pending');
    expect(pending[0].originatingTool.name).toBe('claude-code');
    expect(pending[0].originatingTool.version).toBe('1.0.42');
    expect(pending[0].capturePath).toBe('A');
    expect(pending[0].spanCount).toBe(42);
    expect(pending[0].repoRemoteUrl).toBe('git@github.com:Jinn-Network/mono.git');
  });

  it('lists pending captures sorted by capturedAt descending', () => {
    captures.savePending({
      sessionId: 'older',
      capturedAt: '2026-05-07T00:00:00.000Z',
      originatingTool: { name: 'claude-code' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 1,
      durationMs: 1,
      redactedSpanCount: 0,
    });
    captures.savePending({
      sessionId: 'newer',
      capturedAt: '2026-05-07T01:00:00.000Z',
      originatingTool: { name: 'codex' },
      capturePath: 'B',
      status: 'pending',
      spanCount: 1,
      durationMs: 1,
      redactedSpanCount: 0,
    });
    const list = captures.listPending();
    expect(list[0].sessionId).toBe('newer');
    expect(list[1].sessionId).toBe('older');
  });

  it('marks approved and removes from pending list', () => {
    captures.savePending({
      sessionId: 'sess-2',
      capturedAt: new Date().toISOString(),
      originatingTool: { name: 'codex' },
      capturePath: 'B',
      status: 'pending',
      spanCount: 10,
      durationMs: 5_000,
      redactedSpanCount: 0,
    });
    captures.markApproved('sess-2', {
      envelopeCid: 'bafy123',
      publishedAt: new Date().toISOString(),
    });
    expect(captures.listPending()).toHaveLength(0);
    const approved = captures.getApproved('sess-2');
    expect(approved).not.toBeNull();
    expect(approved!.envelopeCid).toBe('bafy123');
  });

  it('marks skipped (with timestamp for grace deletion)', () => {
    captures.savePending({
      sessionId: 'sess-3',
      capturedAt: new Date().toISOString(),
      originatingTool: { name: 'aider' },
      capturePath: 'B',
      status: 'pending',
      spanCount: 1,
      durationMs: 1_000,
      redactedSpanCount: 0,
    });
    captures.markSkipped('sess-3', { skippedAt: new Date().toISOString() });
    expect(captures.listPending()).toHaveLength(0);
    const skipped = captures.getSkipped('sess-3');
    expect(skipped).not.toBeNull();
    expect(skipped!.status).toBe('skipped');
  });

  it('rejects invalid capturePath values via CHECK constraint', () => {
    expect(() => captures.savePending({
      sessionId: 'sess-bad',
      capturedAt: new Date().toISOString(),
      originatingTool: { name: 'claude-code' },
      capturePath: 'Z' as 'A',  // invalid
      status: 'pending',
      spanCount: 1,
      durationMs: 1,
      redactedSpanCount: 0,
    })).toThrow();
  });

  it('rejects duplicate sessionId on savePending', () => {
    captures.savePending({
      sessionId: 'dup',
      capturedAt: new Date().toISOString(),
      originatingTool: { name: 'claude-code' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 1,
      durationMs: 1,
      redactedSpanCount: 0,
    });
    expect(() => captures.savePending({
      sessionId: 'dup',
      capturedAt: new Date().toISOString(),
      originatingTool: { name: 'claude-code' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 1,
      durationMs: 1,
      redactedSpanCount: 0,
    })).toThrow();
  });

  it('handles getApproved returning null for unknown sessionId', () => {
    expect(captures.getApproved('nope')).toBeNull();
    expect(captures.getSkipped('nope')).toBeNull();
  });
});
