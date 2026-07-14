import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecJsonParser } from '../../../src/trajectory/transcript-to-spans/codex-exec-json.js';

const FIXTURE = fileURLToPath(
  new URL('../../../fixtures/transcripts/codex/exec-json-with-usage.jsonl', import.meta.url),
);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-exec-json-test-'));
  tmpDirs.push(dir);
  const path = join(dir, 'stdout.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

describe('CodexExecJsonParser', () => {
  it('emits jinn.agent_turn and jinn.tool_call span kinds', async () => {
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(FIXTURE);
    const kinds = new Set(spans.map((s) => s.attributes['jinn.span.kind']));
    expect(kinds.has('jinn.agent_turn')).toBe(true);
    expect(kinds.has('jinn.tool_call')).toBe(true);
  });

  it('preserves user and assistant turn roles', async () => {
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(FIXTURE);
    const turns = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    const roles = turns.map((s) => s.attributes['jinn.turn.role']);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('pairs the tool call with its result as a single span with one tool_result event', async () => {
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(FIXTURE);
    const toolCalls = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(toolCalls).toHaveLength(1);
    const [call] = toolCalls;
    expect(call.attributes['tool.name']).toBe('shell');
    expect(call.events).toHaveLength(1);
    expect(call.events[0].name).toBe('tool_result');
    expect(typeof call.events[0].attributes?.['tool.result']).toBe('string');
    expect(call.events[0].attributes?.['tool.result.is_error']).toBe(false);
    expect(call.status).toEqual({ code: 'OK' });
  });

  it('attaches usage only to the last agent_turn span', async () => {
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(FIXTURE);
    const turns = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    expect(turns.length).toBeGreaterThan(1);
    const last = turns[turns.length - 1];
    expect(last.attributes['gen_ai.usage.input_tokens']).toBe(4200);
    expect(last.attributes['gen_ai.usage.output_tokens']).toBe(380);
    for (const t of turns.slice(0, -1)) {
      expect(t.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    }
  });

  it('skips malformed lines without throwing', async () => {
    const parser = new CodexExecJsonParser();
    await expect(parser.parse(FIXTURE)).resolves.not.toThrow();
  });

  it('returns [] for a missing file', async () => {
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse('/nonexistent/path/does-not-exist.jsonl');
    expect(spans).toEqual([]);
  });

  it('stamps jinn.transcript.sourceFormat on every span', async () => {
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(FIXTURE);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.attributes['jinn.transcript.sourceFormat']).toBe('codex-exec-json');
      expect(s.attributes['jinn.transcript.parser']).toBeTruthy();
      expect(s.attributes['jinn.transcript.parserVersion']).toBeTruthy();
    }
  });

  it('emits an unmatched tool call with empty events and UNSET status', async () => {
    const path = writeTranscript([
      JSON.stringify({
        timestamp: '2026-07-14T09:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'call_orphan' },
      }),
    ]);
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(path);
    const toolCalls = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].events).toEqual([]);
    expect(toolCalls[0].status).toEqual({ code: 'UNSET' });
  });

  // #1473 finding 4: nsFromIso does `BigInt(new Date(iso).getTime())`, which
  // throws a RangeError on an invalid date (NaN → BigInt(NaN) throws) — one
  // malformed timestamp among otherwise-valid events used to lose every span
  // in the whole parse (uncaught inside the per-event loop, caught only by
  // the parser's outer try/catch which discards everything and returns []).
  it('does not lose every span when one event has a malformed timestamp', async () => {
    const path = writeTranscript([
      JSON.stringify({
        timestamp: '2026-07-14T09:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'before' }] },
      }),
      JSON.stringify({
        timestamp: 'not-a-real-timestamp',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'malformed' }] },
      }),
      JSON.stringify({
        timestamp: '2026-07-14T09:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after' }] },
      }),
    ]);
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(path);

    // The two well-formed events must survive; the parser must not throw and
    // must not discard everything.
    const turns = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    const contents = turns.map((s) => s.attributes['message.content']);
    expect(contents).toContain('before');
    expect(contents).toContain('after');
    // The malformed-timestamp event itself is guarded (fallback timestamp),
    // not silently dropped — decision-path data (the turn content) survives.
    expect(contents).toContain('malformed');
  });

  it('truncates an oversized message.content leaf to MAX_ATTR_LENGTH', async () => {
    const huge = 'x'.repeat(20_000);
    const path = writeTranscript([
      JSON.stringify({
        timestamp: '2026-07-14T09:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: huge }] },
      }),
    ]);
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(path);
    const turn = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    expect(turn).toBeDefined();
    const content = turn!.attributes['message.content'] as string;
    expect(content.length).toBeLessThanOrEqual(8000);
    expect(content.length).toBeLessThan(huge.length);
  });

  it('truncates an oversized tool.result leaf to MAX_ATTR_LENGTH', async () => {
    const huge = 'y'.repeat(20_000);
    const path = writeTranscript([
      JSON.stringify({
        timestamp: '2026-07-14T09:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'call_huge' },
      }),
      JSON.stringify({
        timestamp: '2026-07-14T09:00:01.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_huge', output: huge },
      }),
    ]);
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(path);
    const call = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(call).toBeDefined();
    const result = call!.events[0]?.attributes?.['tool.result'] as string;
    expect(result.length).toBeLessThanOrEqual(8000);
    expect(result.length).toBeLessThan(huge.length);
  });
});
