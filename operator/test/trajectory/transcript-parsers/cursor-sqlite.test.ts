import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CursorSqliteParser } from '../../../src/trajectory/transcript-parsers/cursor-sqlite.js';
import { TranscriptEventSchema } from '../../../src/trajectory/transcript-parsers/types.js';

let workDir: string;
let dbPath: string;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'cursor-sqlite-fixture-'));
  dbPath = path.join(workDir, 'state.vscdb');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO ItemTable VALUES (?, ?)');
  // Hand-crafted plausible Cursor chat-data shape: a JSON blob keyed under
  // workbench.panel.aichat.view.aichat.chatdata containing tabs → bubbles.
  const chatData = {
    tabs: [
      {
        tabId: 'tab-1',
        bubbles: [
          {
            type: 'user',
            timestamp: '2026-05-07T00:00:00.000Z',
            text: 'please read the file',
          },
          {
            type: 'ai',
            timestamp: '2026-05-07T00:00:01.000Z',
            text: 'I will read it.',
          },
          {
            type: 'tool_call',
            timestamp: '2026-05-07T00:00:02.000Z',
            toolName: 'read',
            args: { path: 'src/x.ts' },
          },
          {
            type: 'tool_result',
            timestamp: '2026-05-07T00:00:03.000Z',
            toolName: 'read',
            content: 'file contents here',
          },
          {
            type: 'ai',
            timestamp: '2026-05-07T00:00:04.000Z',
            text: 'now editing',
          },
          {
            type: 'tool_call',
            timestamp: '2026-05-07T00:00:05.000Z',
            toolName: 'edit',
            args: { path: 'src/x.ts', old: 'a', new: 'b' },
          },
          {
            type: 'tool_result',
            timestamp: '2026-05-07T00:00:06.000Z',
            toolName: 'edit',
            content: 'edit applied',
          },
        ],
      },
    ],
  };
  insert.run('workbench.panel.aichat.view.aichat.chatdata', JSON.stringify(chatData));
  db.close();
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('CursorSqliteParser', () => {
  it('declares its tool identity', () => {
    const parser = new CursorSqliteParser();
    expect(parser.tool).toBe('cursor');
  });

  it('parses the example fixture into a non-empty TranscriptEvent stream', async () => {
    const parser = new CursorSqliteParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: dbPath });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const result = TranscriptEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it('emits at least one event of each kind we expect from the fixture', async () => {
    const parser = new CursorSqliteParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: dbPath });
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('user-message')).toBe(true);
    expect(kinds.has('assistant-message')).toBe(true);
    expect(kinds.has('tool-call')).toBe(true);
    expect(kinds.has('tool-result')).toBe(true);
  });

  it('parseChunk is a no-op (Cursor stores chat in a polled SQLite store)', () => {
    const parser = new CursorSqliteParser();
    const events = parser.parseChunk({ sessionId: 'sess-1', chunk: 'ignored' });
    expect(events).toEqual([]);
  });

  it('parseFull skips malformed bubbles and returns the rest', async () => {
    const parser = new CursorSqliteParser();
    const dir = mkdtempSync(path.join(tmpdir(), 'cursor-sqlite-malformed-'));
    try {
      const malformedDb = path.join(dir, 'state.vscdb');
      const db = new Database(malformedDb);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
        'workbench.panel.aichat.view.aichat.chatdata',
        JSON.stringify({
          tabs: [
            {
              tabId: 'tab-1',
              bubbles: [
                { type: 'unknown_kind', timestamp: '2026-05-07T00:00:00.000Z' },
                { type: 'user', timestamp: '2026-05-07T00:00:01.000Z', text: 'ok' },
                'not-an-object',
                null,
              ],
            },
          ],
        }),
      );
      db.close();
      const events = await parser.parseFull({ sessionId: 'sess-1', path: malformedDb });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('user-message');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseFull returns empty when the chat key is missing', async () => {
    const parser = new CursorSqliteParser();
    const dir = mkdtempSync(path.join(tmpdir(), 'cursor-sqlite-empty-'));
    try {
      const emptyDb = path.join(dir, 'state.vscdb');
      const db = new Database(emptyDb);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      db.close();
      const events = await parser.parseFull({ sessionId: 'sess-1', path: emptyDb });
      expect(events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tool-call events carry name + args', async () => {
    const parser = new CursorSqliteParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: dbPath });
    const toolCalls = events.filter((e) => e.kind === 'tool-call');
    expect(toolCalls.length).toBeGreaterThan(0);
    const call = toolCalls[0];
    if (call.kind === 'tool-call') {
      expect(call.name).toBe('read');
      expect(call.args).toMatchObject({ path: 'src/x.ts' });
    }
  });

  it('tool-result events carry name + content', async () => {
    const parser = new CursorSqliteParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: dbPath });
    const results = events.filter((e) => e.kind === 'tool-result');
    expect(results.length).toBeGreaterThan(0);
    const result = results[0];
    if (result.kind === 'tool-result') {
      expect(result.name).toBe('read');
      expect(result.content).toBe('file contents here');
    }
  });
});

