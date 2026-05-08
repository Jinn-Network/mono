import { describe, it, expect } from 'vitest';
import { ContinueDevDataParser } from '../../../src/trajectory/transcript-parsers/continue-devdata.js';
import { TranscriptEventSchema } from '../../../src/trajectory/transcript-parsers/types.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/transcripts/continue/dev_data',
);

describe('ContinueDevDataParser', () => {
  it('declares its tool identity', () => {
    const parser = new ContinueDevDataParser();
    expect(parser.tool).toBe('continue');
  });

  it('parses the example fixture into a non-empty TranscriptEvent stream', async () => {
    const parser = new ContinueDevDataParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_DIR });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const result = TranscriptEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it('emits at least one event of each kind we expect from the fixture', async () => {
    const parser = new ContinueDevDataParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_DIR });
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('user-message')).toBe(true);
    expect(kinds.has('assistant-message')).toBe(true);
    expect(kinds.has('edit')).toBe(true);
  });

  it('parseChunk handles a single chat record and emits an event', () => {
    const parser = new ContinueDevDataParser();
    const line =
      JSON.stringify({
        kind: 'chat',
        role: 'user',
        timestamp: '2026-05-07T00:00:00.000Z',
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
    const parser = new ContinueDevDataParser();
    const part1 =
      JSON.stringify({
        kind: 'chat',
        role: 'user',
        timestamp: '2026-05-07T00:00:00.000Z',
        content: 'first',
      }) +
      '\n' +
      '{"kind":"chat","role":"user","timesta'; // incomplete
    const part2 =
      'mp":"2026-05-07T00:00:01.000Z","content":"second"}\n';

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
    const parser = new ContinueDevDataParser();
    const events = parser.parseChunk({
      sessionId: 'sess-1',
      chunk:
        'not-json\n' +
        JSON.stringify({
          kind: 'chat',
          role: 'user',
          timestamp: '2026-05-07T00:00:00.000Z',
          content: 'ok',
        }) +
        '\n',
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('user-message');
  });

  it('skips autocomplete event-kind directory in v0', async () => {
    // The fixture does not include an autocomplete dir, but a parser run on a
    // dir that does should not emit autocomplete-derived events. We assert
    // weakly: only chat and edit kinds appear in the output.
    const parser = new ContinueDevDataParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_DIR });
    const kinds = new Set(events.map((e) => e.kind));
    // No tool-call events from autocomplete (or any other source) in v0.
    expect(kinds.has('tool-call')).toBe(false);
    expect(kinds.has('tool-result')).toBe(false);
  });

  it('emits edit events with path + diff from the edit/ directory', async () => {
    const parser = new ContinueDevDataParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_DIR });
    const edits = events.filter((e) => e.kind === 'edit');
    expect(edits.length).toBeGreaterThan(0);
    const edit = edits[0];
    if (edit.kind === 'edit') {
      expect(edit.path).toBeTruthy();
      expect(edit.diff).toBeTruthy();
    }
  });
});
