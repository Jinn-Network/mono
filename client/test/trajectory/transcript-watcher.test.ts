import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  startTranscriptWatcher,
  shouldWatchDirectoryFile,
  type TranscriptWatcher,
} from '../../src/trajectory/transcript-watcher.js';
import type { TranscriptEvent } from '../../src/trajectory/transcript-parsers/types.js';

describe('TranscriptWatcher', () => {
  let watcher: TranscriptWatcher | undefined;
  let tmpDir: string;
  let collected: { sessionId: string; tool: string; event: TranscriptEvent }[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jinn-watcher-test-'));
    collected = [];
    watcher = undefined;
  });

  afterEach(async () => {
    if (watcher) await watcher.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('dispatches a Claude Code JSONL append to the parser', async () => {
    const session = path.join(tmpDir, 'sess-1.jsonl');
    await fs.writeFile(session, '');

    watcher = await startTranscriptWatcher({
      sources: [{ tool: 'claude-code', path: session, sessionId: 'sess-1' }],
      onEvent: (envelope) => collected.push(envelope),
    });

    // Append one Claude Code record
    await fs.appendFile(
      session,
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-07T00:00:00.000Z',
        message: { content: 'hello' },
      }) + '\n',
    );

    // Wait for chokidar to pick up the change + dispatch
    await waitFor(() => collected.length > 0, 20000);

    expect(collected.length).toBe(1);
    expect(collected[0].sessionId).toBe('sess-1');
    expect(collected[0].tool).toBe('claude-code');
    expect(collected[0].event.kind).toBe('user-message');
  });

  it('dispatches incrementally as new lines arrive', async () => {
    const session = path.join(tmpDir, 'sess-2.jsonl');
    await fs.writeFile(session, '');

    watcher = await startTranscriptWatcher({
      sources: [{ tool: 'claude-code', path: session, sessionId: 'sess-2' }],
      onEvent: (envelope) => collected.push(envelope),
    });

    await fs.appendFile(
      session,
      JSON.stringify({ type: 'user', timestamp: '2026-05-07T00:00:00.000Z', message: { content: 'a' } }) + '\n',
    );
    await waitFor(() => collected.length >= 1, 20000);

    await fs.appendFile(
      session,
      JSON.stringify({ type: 'user', timestamp: '2026-05-07T00:00:01.000Z', message: { content: 'b' } }) + '\n',
    );
    await waitFor(() => collected.length >= 2, 20000);

    expect(collected.length).toBe(2);
  });

  it('dispatches different tools to their respective parsers', async () => {
    const claudeSession = path.join(tmpDir, 'claude.jsonl');
    const codexSession = path.join(tmpDir, 'codex.jsonl');
    await fs.writeFile(claudeSession, '');
    await fs.writeFile(codexSession, '');

    watcher = await startTranscriptWatcher({
      sources: [
        { tool: 'claude-code', path: claudeSession, sessionId: 'claude-sess' },
        { tool: 'codex', path: codexSession, sessionId: 'codex-sess' },
      ],
      onEvent: (envelope) => collected.push(envelope),
    });

    await fs.appendFile(
      claudeSession,
      JSON.stringify({ type: 'user', timestamp: '2026-05-07T00:00:00.000Z', message: { content: 'a' } }) + '\n',
    );
    await fs.appendFile(
      codexSession,
      JSON.stringify({ role: 'user', ts: '2026-05-07T00:00:00.000Z', content: 'b' }) + '\n',
    );
    await waitFor(() => collected.length >= 2, 20000);

    const tools = new Set(collected.map((c) => c.tool));
    expect(tools.has('claude-code')).toBe(true);
    expect(tools.has('codex')).toBe(true);
  });

  it('captures jsonl files created after the watcher starts', async () => {
    const sessionsDir = path.join(tmpDir, 'codex-sessions-new');
    await fs.mkdir(sessionsDir, { recursive: true });

    watcher = await startTranscriptWatcher({
      directories: [
        {
          tool: 'codex',
          directory: sessionsDir,
          sessionIdFromPath: (p) => path.basename(p, '.jsonl'),
        },
      ],
      onEvent: (envelope) => collected.push(envelope),
    });

    await new Promise((r) => setTimeout(r, 150));

    const session = path.join(sessionsDir, 'brand-new.jsonl');
    await fs.writeFile(
      session,
      JSON.stringify({ role: 'user', ts: '2026-05-07T00:00:00.000Z', content: 'hi' }) + '\n',
    );

    await waitFor(() => collected.length > 0, 20000);
    expect(collected[0]?.sessionId).toBe('brand-new');
  });

  // Uses the `watchOptions` polling seam (#832) so the pre-existing-file append
  // (`change`) path is detected deterministically in CI.
  it('registers existing directory jsonl files and tails appends', async () => {
    const sessionsDir = path.join(tmpDir, 'codex-sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const session = path.join(sessionsDir, 'live-session.jsonl');
    await fs.writeFile(session, '');

    watcher = await startTranscriptWatcher({
      directories: [
        {
          tool: 'codex',
          directory: sessionsDir,
          sessionIdFromPath: (p) => path.basename(p, '.jsonl'),
        },
      ],
      onEvent: (envelope) => collected.push(envelope),
      watchOptions: { usePolling: true, interval: 20 },
    });

    await fs.appendFile(
      session,
      JSON.stringify({ role: 'user', ts: '2026-05-07T00:00:00.000Z', content: 'hi' }) + '\n',
    );

    await waitFor(() => collected.length > 0, 20000);
    expect(collected[0]?.sessionId).toBe('live-session');
    expect(collected[0]?.tool).toBe('codex');
  });

  it('shutdown stops further dispatches', async () => {
    const session = path.join(tmpDir, 'sess-3.jsonl');
    await fs.writeFile(session, '');

    watcher = await startTranscriptWatcher({
      sources: [{ tool: 'claude-code', path: session, sessionId: 'sess-3' }],
      onEvent: (envelope) => collected.push(envelope),
    });

    await fs.appendFile(
      session,
      JSON.stringify({ type: 'user', timestamp: '2026-05-07T00:00:00.000Z', message: { content: 'a' } }) + '\n',
    );
    // startTranscriptWatcher now awaits chokidar's `ready`, so the watcher is
    // guaranteed live before this append — detection is deterministic, not a
    // race against fs-watch setup latency. The budget stays generous only to
    // absorb OS-level detection latency under CI load.
    await waitFor(() => collected.length >= 1, 20000);

    await watcher.shutdown();
    watcher = undefined;
    const before = collected.length;

    await fs.appendFile(
      session,
      JSON.stringify({ type: 'user', timestamp: '2026-05-07T00:00:01.000Z', message: { content: 'b' } }) + '\n',
    );

    // Assert the watcher is genuinely quiesced rather than polling for an
    // absence over an arbitrary sleep. `shutdown()` resolves only after
    // chokidar's `close()` and every in-flight handler settle, so a post-
    // shutdown append cannot produce a dispatch. To prove that deterministically
    // we stand up a *fresh* watcher on the same file and wait for it to observe
    // the very append we just made: once the live control has detected the
    // change, fs-watch has demonstrably surfaced it, so any dispatch the dead
    // watcher were going to make would already have happened.
    const controlCollected: typeof collected = [];
    const control = await startTranscriptWatcher({
      sources: [{ tool: 'claude-code', path: session, sessionId: 'sess-3-control' }],
      onEvent: (envelope) => controlCollected.push(envelope),
    });
    try {
      await fs.appendFile(
        session,
        JSON.stringify({ type: 'user', timestamp: '2026-05-07T00:00:02.000Z', message: { content: 'c' } }) + '\n',
      );
      await waitFor(() => controlCollected.length >= 1, 20000);
    } finally {
      await control.shutdown();
    }

    // The dead watcher must not have dispatched the post-shutdown append(s).
    expect(collected.length).toBe(before);
  });

  // Regression for #1422: an operator machine with a large accumulated
  // ~/.claude/projects / ~/.codex/sessions history creates one native
  // FSWatcher handle per historical filesystem entry with no age bound —
  // 15,329 handles observed live (matching the machine's total file+dir count
  // under those two roots almost exactly), starving the daemon's event loop
  // for 70+ minutes across multiple unrelated loops (confirmed live: closing
  // the handles in-process immediately unwedged them). `shouldWatchDirectoryFile`
  // is the predicate both the pre-registration loop and chokidar's `ignored`
  // option share to keep dormant files out of the watch set.
  //
  // Tested as a pure unit here rather than end-to-end: once a chokidar-ignored
  // file is written to, its mtime legitimately becomes recent and chokidar
  // correctly picks it back up (that's desired — a truly reactivated session
  // should be noticed) — so an e2e "append to an old file, expect silence"
  // assertion is untestable by construction, not a property of the fix.
  describe('shouldWatchDirectoryFile', () => {
    const maxAgeMs = 1000;

    it('always allows directories through, regardless of age', () => {
      const old = { isDirectory: () => true, mtimeMs: Date.now() - 10 * maxAgeMs };
      expect(shouldWatchDirectoryFile('/some/dir', old, maxAgeMs)).toBe(true);
    });

    it('allows the pre-stat pass through (stats undefined)', () => {
      expect(shouldWatchDirectoryFile('/some/file.jsonl', undefined, maxAgeMs)).toBe(true);
    });

    it('rejects non-.jsonl files outright', () => {
      const fresh = { isDirectory: () => false, mtimeMs: Date.now() };
      expect(shouldWatchDirectoryFile('/some/notes.txt', fresh, maxAgeMs)).toBe(false);
    });

    it('allows a .jsonl file within the age window', () => {
      const fresh = { isDirectory: () => false, mtimeMs: Date.now() - maxAgeMs / 2 };
      expect(shouldWatchDirectoryFile('/some/session.jsonl', fresh, maxAgeMs)).toBe(true);
    });

    it('rejects a .jsonl file older than the age window', () => {
      const old = { isDirectory: () => false, mtimeMs: Date.now() - maxAgeMs * 10 };
      expect(shouldWatchDirectoryFile('/some/session.jsonl', old, maxAgeMs)).toBe(false);
    });
  });

  it('registers directory-mode sessions within maxDirectoryFileAgeMs and dispatches their appends', async () => {
    const sessionsDir = path.join(tmpDir, 'aged-sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    const freshSession = path.join(sessionsDir, 'fresh.jsonl');
    await fs.writeFile(freshSession, '');

    watcher = await startTranscriptWatcher({
      directories: [
        {
          tool: 'codex',
          directory: sessionsDir,
          sessionIdFromPath: (p) => path.basename(p, '.jsonl'),
        },
      ],
      maxDirectoryFileAgeMs: 24 * 60 * 60 * 1000,
      onEvent: (envelope) => collected.push(envelope),
    });

    await fs.appendFile(
      freshSession,
      JSON.stringify({ role: 'user', ts: '2026-05-07T00:00:00.000Z', content: 'fresh' }) + '\n',
    );
    await waitFor(() => collected.some((c) => c.sessionId === 'fresh'), 20000);

    expect(collected.some((c) => c.sessionId === 'fresh')).toBe(true);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
