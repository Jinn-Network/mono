import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeStreamJsonParser } from '../../../src/trajectory/transcript-to-spans/claude-code-stream-json.js';

const FIXTURE = fileURLToPath(
  new URL('../../../fixtures/transcripts/claude-code/stream-json-example.jsonl', import.meta.url),
);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-code-stream-json-test-'));
  tmpDirs.push(dir);
  const path = join(dir, 'stdout.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

describe('ClaudeCodeStreamJsonParser', () => {
  it('emits jinn.agent_turn and jinn.tool_call span kinds', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(FIXTURE);
    const kinds = new Set(spans.map((s) => s.attributes['jinn.span.kind']));
    expect(kinds.has('jinn.agent_turn')).toBe(true);
    expect(kinds.has('jinn.tool_call')).toBe(true);
  });

  it('maps a string-content user line to agent_turn(user)', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(FIXTURE);
    const turns = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    const userTurn = turns.find((t) => t.attributes['jinn.turn.role'] === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn!.attributes['message.content']).toContain('Fix the failing test');
  });

  it('drops thinking blocks and maps text blocks to agent_turn(assistant)', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(FIXTURE);
    const turns = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    const assistantTurns = turns.filter((t) => t.attributes['jinn.turn.role'] === 'assistant');
    expect(assistantTurns.length).toBeGreaterThan(0);
    for (const t of assistantTurns) {
      expect(t.attributes['message.content']).not.toContain('Let me look at the file first');
    }
  });

  it('pairs tool_use with tool_result by exact tool_use_id and records args as an object', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(FIXTURE);
    const toolCalls = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(toolCalls).toHaveLength(1);
    const [call] = toolCalls;
    expect(call.attributes['tool.name']).toBe('Read');
    expect(typeof call.attributes['tool.args']).toBe('object');
    expect(call.attributes['tool.args']).toEqual({ path: 'skelebot/components/package.py' });
    expect(call.events).toHaveLength(1);
    expect(call.events[0].name).toBe('tool_result');
    expect(call.status).toEqual({ code: 'OK' });
  });

  it('produces monotonic nanosecond timestamps across lines', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(FIXTURE);
    for (let i = 1; i < spans.length; i++) {
      expect(BigInt(spans[i].startTimeUnixNano) >= BigInt(spans[i - 1].startTimeUnixNano)).toBe(true);
    }
  });

  it('attaches result usage only to the last agent_turn span', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(FIXTURE);
    const turns = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    const last = turns[turns.length - 1];
    expect(last.attributes['gen_ai.usage.input_tokens']).toBe(4200);
    expect(last.attributes['gen_ai.usage.output_tokens']).toBe(380);
    for (const t of turns.slice(0, -1)) {
      expect(t.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    }
  });

  it('skips malformed lines without throwing', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    await expect(parser.parse(FIXTURE)).resolves.not.toThrow();
  });

  it('returns [] for a missing file', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse('/nonexistent/path/does-not-exist.jsonl');
    expect(spans).toEqual([]);
  });

  it('stamps jinn.transcript.sourceFormat on every span', async () => {
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(FIXTURE);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.attributes['jinn.transcript.sourceFormat']).toBe('claude-code-stream-json');
      expect(s.attributes['jinn.transcript.parser']).toBeTruthy();
      expect(s.attributes['jinn.transcript.parserVersion']).toBeTruthy();
    }
  });

  it('emits an unmatched tool_use with empty events and UNSET status', async () => {
    const path = writeTranscript([
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan_1', name: 'Bash', input: { command: 'ls' } }] },
      }),
    ]);
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(path);
    const toolCalls = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].events).toEqual([]);
    expect(toolCalls[0].status).toEqual({ code: 'UNSET' });
  });

  it('truncates an oversized message.content leaf to MAX_ATTR_LENGTH', async () => {
    const huge = 'x'.repeat(20_000);
    const path = writeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: huge } }),
    ]);
    const parser = new ClaudeCodeStreamJsonParser();
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
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_huge', name: 'Read', input: { path: 'x' } }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_huge', content: huge }] },
      }),
    ]);
    const parser = new ClaudeCodeStreamJsonParser();
    const spans = await parser.parse(path);
    const call = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(call).toBeDefined();
    const result = call!.events[0]?.attributes?.['tool.result'] as string;
    expect(result.length).toBeLessThanOrEqual(8000);
    expect(result.length).toBeLessThan(huge.length);
  });
});
