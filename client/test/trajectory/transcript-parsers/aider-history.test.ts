import { describe, it, expect } from 'vitest';
import { AiderHistoryParser } from '../../../src/trajectory/transcript-parsers/aider-history.js';
import { TranscriptEventSchema } from '../../../src/trajectory/transcript-parsers/types.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ANALYTICS_FIXTURE = path.resolve(
  __dirname,
  '../../../fixtures/transcripts/aider/example-analytics.jsonl',
);
const MARKDOWN_FIXTURE = path.resolve(
  __dirname,
  '../../../fixtures/transcripts/aider/example-chat-history.md',
);

describe('AiderHistoryParser', () => {
  it('declares its tool identity', () => {
    const parser = new AiderHistoryParser();
    expect(parser.tool).toBe('aider');
  });

  it('parses the analytics-jsonl fixture into a non-empty TranscriptEvent stream', async () => {
    const parser = new AiderHistoryParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: ANALYTICS_FIXTURE });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const result = TranscriptEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it('analytics fixture covers user-message, assistant-message, and edit kinds', async () => {
    const parser = new AiderHistoryParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: ANALYTICS_FIXTURE });
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('user-message')).toBe(true);
    expect(kinds.has('assistant-message')).toBe(true);
    expect(kinds.has('edit')).toBe(true);
  });

  it('parseChunk handles a single analytics-jsonl line and emits an event', () => {
    const parser = new AiderHistoryParser();
    const line =
      JSON.stringify({
        event: 'message_send',
        ts: '2026-05-07T00:00:00.000Z',
        role: 'user',
        content: 'hello',
      }) + '\n';
    const events = parser.parseChunk({ sessionId: 'sess-1', chunk: line });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('user-message');
    if (events[0].kind === 'user-message') {
      expect(events[0].content).toBe('hello');
    }
  });

  it('parseChunk preserves an incomplete trailing line for the next call', () => {
    const parser = new AiderHistoryParser();
    const part1 =
      JSON.stringify({
        event: 'message_send',
        ts: '2026-05-07T00:00:00.000Z',
        role: 'user',
        content: 'first',
      }) +
      '\n' +
      '{"event":"message_send","ts'; // incomplete
    const part2 =
      '":"2026-05-07T00:00:01.000Z","role":"user","content":"second"}\n';

    const e1 = parser.parseChunk({ sessionId: 'sess-1', chunk: part1 });
    expect(e1).toHaveLength(1);
    expect(e1[0].kind).toBe('user-message');

    const e2 = parser.parseChunk({ sessionId: 'sess-1', chunk: part2 });
    expect(e2).toHaveLength(1);
    if (e2[0].kind === 'user-message') {
      expect(e2[0].content).toBe('second');
    }
  });

  it('parseChunk skips malformed records', () => {
    const parser = new AiderHistoryParser();
    const events = parser.parseChunk({
      sessionId: 'sess-1',
      chunk:
        'not-json\n' +
        JSON.stringify({
          event: 'message_send',
          ts: '2026-05-07T00:00:00.000Z',
          role: 'user',
          content: 'ok',
        }) +
        '\n',
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('user-message');
  });

  it('emits edit events with path + diff from analytics edit records', async () => {
    const parser = new AiderHistoryParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: ANALYTICS_FIXTURE });
    const edits = events.filter((e) => e.kind === 'edit');
    expect(edits.length).toBeGreaterThan(0);
    const edit = edits[0];
    if (edit.kind === 'edit') {
      expect(edit.path).toBeTruthy();
      expect(edit.diff).toBeTruthy();
    }
  });

  it('parses the markdown chat-history fallback when given a .md file', async () => {
    const parser = new AiderHistoryParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: MARKDOWN_FIXTURE });
    expect(events.length).toBeGreaterThan(0);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('user-message')).toBe(true);
    expect(kinds.has('assistant-message')).toBe(true);
    for (const event of events) {
      const result = TranscriptEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });
});
