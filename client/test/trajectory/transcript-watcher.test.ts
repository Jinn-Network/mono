import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  startTranscriptWatcher,
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

  // Quarantined: flaky on CI — chokidar/fs.watch misses appends to a file that
  // existed when the directory watch started (passes locally; the new-file path
  // is fine). Un-skip once watch options are deterministic in tests. See #832.
  it.skip('registers existing directory jsonl files and tails appends', async () => {
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
    await waitFor(() => collected.length >= 1, 20000);

    await watcher.shutdown();
    watcher = undefined;
    const before = collected.length;

    await fs.appendFile(
      session,
      JSON.stringify({ type: 'user', timestamp: '2026-05-07T00:00:01.000Z', message: { content: 'b' } }) + '\n',
    );
    // Should NOT trigger a dispatch
    await new Promise((r) => setTimeout(r, 500));
    expect(collected.length).toBe(before);
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
