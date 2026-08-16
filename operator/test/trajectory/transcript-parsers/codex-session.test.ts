import { describe, it, expect } from 'vitest';
import { CodexSessionParser } from '../../../src/trajectory/transcript-parsers/codex-session.js';
import { TranscriptEventSchema } from '../../../src/trajectory/transcript-parsers/types.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../fixtures/transcripts/codex/example-session.jsonl',
);
const WRAPPED_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../fixtures/transcripts/codex/wrapped-0-129-mcp-tools.jsonl',
);

describe('CodexSessionParser', () => {
  it('declares its tool identity', () => {
    const parser = new CodexSessionParser();
    expect(parser.tool).toBe('codex');
  });

  it('parses the example fixture into a non-empty TranscriptEvent stream', async () => {
    const parser = new CodexSessionParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_PATH });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const result = TranscriptEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it('emits at least one event of each kind we expect from the fixture', async () => {
    const parser = new CodexSessionParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_PATH });
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('user-message')).toBe(true);
    expect(kinds.has('assistant-message')).toBe(true);
    expect(kinds.has('tool-call')).toBe(true);
    expect(kinds.has('tool-result')).toBe(true);
  });

  it('parseChunk handles a single JSONL line and emits the corresponding event', () => {
    const parser = new CodexSessionParser();
    const line =
      JSON.stringify({
        role: 'user',
        ts: '2026-05-07T00:00:00.000Z',
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
    const parser = new CodexSessionParser();
    const part1 =
      JSON.stringify({
        role: 'user',
        ts: '2026-05-07T00:00:00.000Z',
        content: 'first',
      }) +
      '\n' +
      '{"role":"user","ts'; // incomplete
    const part2 = '":"2026-05-07T00:00:01.000Z","content":"second"}\n';

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
    const parser = new CodexSessionParser();
    const events = parser.parseChunk({
      sessionId: 'sess-1',
      chunk: 'not-json\n{"role":"user","ts":"2026-05-07T00:00:00.000Z","content":"ok"}\n',
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('user-message');
  });

  it('maps function-call records to tool-call events with name + args', async () => {
    const parser = new CodexSessionParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_PATH });
    const toolCalls = events.filter((e) => e.kind === 'tool-call');
    expect(toolCalls.length).toBeGreaterThan(0);
    const call = toolCalls[0];
    if (call.kind === 'tool-call') {
      expect(call.name).toBeTruthy();
      expect(typeof call.args).toBe('object');
    }
  });

  it('maps tool-role records to tool-result events with content', async () => {
    const parser = new CodexSessionParser();
    const events = await parser.parseFull({ sessionId: 'sess-1', path: FIXTURE_PATH });
    const results = events.filter((e) => e.kind === 'tool-result');
    expect(results.length).toBeGreaterThan(0);
    const result = results[0];
    if (result.kind === 'tool-result') {
      expect(result.name).toBeTruthy();
      expect(result.content).toBeTruthy();
    }
  });

  it('parses Codex 0.129.0+ wrapped envelopes from the MCP fixture', async () => {
    const parser = new CodexSessionParser();
    const events = await parser.parseFull({ sessionId: 'sess-wrapped', path: WRAPPED_FIXTURE_PATH });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(TranscriptEventSchema.safeParse(event).success).toBe(true);
    }
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('user-message')).toBe(true);
    expect(kinds.has('tool-call')).toBe(true);
    expect(kinds.has('tool-result')).toBe(true);
  });

  it('reproduces search_records then acquire_artifact MCP tool calls from the wrapped fixture', async () => {
    const parser = new CodexSessionParser();
    const events = await parser.parseFull({ sessionId: 'sess-wrapped', path: WRAPPED_FIXTURE_PATH });
    const toolCalls = events.filter((e) => e.kind === 'tool-call');
    const toolResults = events.filter((e) => e.kind === 'tool-result');
    const callNames = toolCalls.map((e) => (e.kind === 'tool-call' ? e.name : ''));
    expect(callNames).toEqual(
      expect.arrayContaining(['search_records', 'acquire_artifact']),
    );
    const searchIdx = callNames.indexOf('search_records');
    const acquireIdx = callNames.indexOf('acquire_artifact');
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(acquireIdx).toBeGreaterThan(searchIdx);

    const searchCall = toolCalls[searchIdx];
    expect(searchCall.kind).toBe('tool-call');
    if (searchCall.kind === 'tool-call') {
      expect(searchCall.args).toMatchObject({
        solverType: 'swe-rebench-v2.v1',
        role: expect.any(String),
      });
    }

    const resultNames = toolResults.map((e) => (e.kind === 'tool-result' ? e.name : ''));
    expect(resultNames).toEqual(
      expect.arrayContaining(['search_records', 'acquire_artifact']),
    );
  });

  it('parseChunk handles wrapped function_call lines', () => {
    const parser = new CodexSessionParser();
    const line =
      JSON.stringify({
        timestamp: '2026-05-25T08:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'search_records',
          arguments: '{"limit":1}',
          call_id: 'call_fixture_1',
        },
      }) + '\n';
    const events = parser.parseChunk({ sessionId: 'sess-1', chunk: line });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool-call',
      name: 'search_records',
      args: { limit: 1 },
    });
  });

  it('parseChunk handles wrapped assistant message blocks', () => {
    const parser = new CodexSessionParser();
    const line =
      JSON.stringify({
        timestamp: '2026-05-25T08:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Searching the corpus next.' }],
        },
      }) + '\n';
    const events = parser.parseChunk({ sessionId: 'sess-1', chunk: line });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'assistant-message',
      content: 'Searching the corpus next.',
    });
  });
});
