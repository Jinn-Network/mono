import { describe, it, expect } from 'vitest';
import { ClaudeCodeJsonlParser } from '../../../src/trajectory/transcript-parsers/claude-code-jsonl.js';
import { TranscriptEventSchema } from '../../../src/trajectory/transcript-parsers/types.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../fixtures/transcripts/claude-code/example-session.jsonl',
);

describe('ClaudeCodeJsonlParser', () => {
  it('declares its tool identity', () => {
    const parser = new ClaudeCodeJsonlParser();
    expect(parser.tool).toBe('claude-code');
  });

  it('parses the example fixture into a non-empty TranscriptEvent stream', async () => {
    const parser = new ClaudeCodeJsonlParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_PATH });
    expect(events.length).toBeGreaterThan(0);
    // Every emitted event must be valid against the canonical schema
    for (const event of events) {
      const result = TranscriptEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it('emits at least one event of each kind we expect from the fixture', async () => {
    const parser = new ClaudeCodeJsonlParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_PATH });
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('user-message')).toBe(true);
    expect(kinds.has('assistant-message')).toBe(true);
    expect(kinds.has('tool-call')).toBe(true);
    expect(kinds.has('tool-result')).toBe(true);
  });

  it('parseChunk handles a single JSONL line and emits the corresponding event', () => {
    const parser = new ClaudeCodeJsonlParser();
    const line =
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-07T00:00:00.000Z',
        message: { content: 'hello' },
      }) + '\n';
    const events = parser.parseChunk({ sessionId: 'sess-1', chunk: line });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('user-message');
    if (events[0].kind === 'user-message') {
      expect(events[0].content).toBe('hello');
    }
  });

  it('parseChunk preserves an incomplete trailing line for the next call', () => {
    const parser = new ClaudeCodeJsonlParser();
    const part1 =
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-07T00:00:00.000Z',
        message: { content: 'first' },
      }) +
      '\n' +
      '{"type":"user","timesta'; // incomplete
    const part2 =
      'mp":"2026-05-07T00:00:01.000Z","message":{"content":"second"}}\n';

    const e1 = parser.parseChunk({ sessionId: 'sess-1', chunk: part1 });
    expect(e1).toHaveLength(1);
    expect(e1[0].kind).toBe('user-message');

    const e2 = parser.parseChunk({ sessionId: 'sess-1', chunk: part2 });
    expect(e2).toHaveLength(1);
    if (e2[0].kind === 'user-message') {
      expect(e2[0].content).toBe('second');
    }
  });

  it('parseChunk skips records it does not understand', () => {
    const parser = new ClaudeCodeJsonlParser();
    const line =
      JSON.stringify({
        type: 'unknown_kind',
        timestamp: '2026-05-07T00:00:00.000Z',
        foo: 'bar',
      }) + '\n';
    const events = parser.parseChunk({ sessionId: 'sess-1', chunk: line });
    expect(events).toEqual([]);
  });

  it('tool-call event captures name + args from tool_use content block', async () => {
    const parser = new ClaudeCodeJsonlParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_PATH });
    const toolCalls = events.filter((e) => e.kind === 'tool-call');
    expect(toolCalls.length).toBeGreaterThan(0);
    const call = toolCalls[0];
    if (call.kind === 'tool-call') {
      expect(call.name).toBeTruthy();
      expect(typeof call.args).toBe('object');
    }
  });

  it('tool-result event carries content from tool_result content block', async () => {
    const parser = new ClaudeCodeJsonlParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_PATH });
    const results = events.filter((e) => e.kind === 'tool-result');
    expect(results.length).toBeGreaterThan(0);
    const result = results[0];
    if (result.kind === 'tool-result') {
      expect(result.content).toBeTruthy();
      expect(result.name).toBeTruthy();
    }
  });
});
