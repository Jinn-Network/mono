import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesSessionJsonParser } from '../../../src/trajectory/transcript-to-spans/hermes-session-json.js';

const FIXTURE = fileURLToPath(
  new URL('../../../fixtures/transcripts/hermes-agent/session-example.json', import.meta.url),
);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Writes a single Hermes session JSON object (the on-disk `session_*.json` shape). */
function writeSession(record: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-session-json-test-'));
  tmpDirs.push(dir);
  const path = join(dir, 'session.json');
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record));
  return path;
}

describe('HermesSessionJsonParser', () => {
  it('emits jinn.agent_turn and jinn.tool_call span kinds', async () => {
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(FIXTURE);
    const kinds = new Set(spans.map((s) => s.attributes['jinn.span.kind']));
    expect(kinds.has('jinn.agent_turn')).toBe(true);
    expect(kinds.has('jinn.tool_call')).toBe(true);
  });

  it('maps a role:"user" message to agent_turn(user)', async () => {
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(FIXTURE);
    const turns = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    const userTurn = turns.find((t) => t.attributes['jinn.turn.role'] === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn!.attributes['message.content']).toContain('Fix the failing test');
  });

  it('maps role:"assistant" content to agent_turn(assistant) and drops reasoning', async () => {
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(FIXTURE);
    const turns = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    const assistantTurns = turns.filter((t) => t.attributes['jinn.turn.role'] === 'assistant');
    expect(assistantTurns.length).toBeGreaterThan(0);
    for (const t of assistantTurns) {
      expect(t.attributes['message.content']).not.toContain('Let me look at the file first');
    }
  });

  it('pairs tool_calls with the role:"tool" result by exact tool_call_id and records args as an object', async () => {
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(FIXTURE);
    const toolCalls = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(toolCalls).toHaveLength(1);
    const [call] = toolCalls;
    expect(call.attributes['tool.name']).toBe('read_file');
    expect(typeof call.attributes['tool.args']).toBe('object');
    // Proves `function.arguments` (a JSON *string* per the OpenAI contract) was parsed.
    expect(call.attributes['tool.args']).toEqual({ path: 'pkg/foo.py' });
    expect(call.events).toHaveLength(1);
    expect(call.events[0].name).toBe('tool_result');
    expect(call.status).toEqual({ code: 'OK' });
  });

  it('produces monotonic nanosecond timestamps across messages', async () => {
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(FIXTURE);
    for (let i = 1; i < spans.length; i++) {
      expect(BigInt(spans[i].startTimeUnixNano) >= BigInt(spans[i - 1].startTimeUnixNano)).toBe(true);
    }
  });

  it('stamps jinn.transcript provenance on every span', async () => {
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(FIXTURE);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.attributes['jinn.transcript.sourceFormat']).toBe('hermes-session-json');
      expect(s.attributes['jinn.transcript.parser']).toBeTruthy();
      expect(s.attributes['jinn.transcript.parserVersion']).toBeTruthy();
    }
  });

  it('returns [] for a missing file', async () => {
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse('/nonexistent/path/does-not-exist.json');
    expect(spans).toEqual([]);
  });

  it('returns [] (no throw) for a malformed/non-JSON file', async () => {
    const path = writeSession('this is not json {');
    const parser = new HermesSessionJsonParser();
    await expect(parser.parse(path)).resolves.toEqual([]);
  });

  it('returns [] for a JSON object with no messages array', async () => {
    const path = writeSession({ session_id: 'x', model: 'y' });
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(path);
    expect(spans).toEqual([]);
  });

  it('emits an unmatched tool_call with empty events and UNSET status', async () => {
    const path = writeSession({
      messages: [
        {
          role: 'assistant',
          content: 'calling a tool',
          tool_calls: [
            { id: 'orphan_1', type: 'function', function: { name: 'run', arguments: '{"cmd":"ls"}' } },
          ],
        },
      ],
    });
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(path);
    const toolCalls = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].events).toEqual([]);
    expect(toolCalls[0].status).toEqual({ code: 'UNSET' });
  });

  it('degrades a non-JSON function.arguments to an empty object without throwing', async () => {
    const path = writeSession({
      messages: [
        {
          role: 'assistant',
          content: 'calling a tool',
          tool_calls: [
            { id: 'call_bad', type: 'function', function: { name: 'run', arguments: 'not-json' } },
          ],
        },
      ],
    });
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(path);
    const call = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(call).toBeDefined();
    expect(call!.attributes['tool.args']).toEqual({});
  });

  it('truncates an oversized message.content leaf to MAX_ATTR_LENGTH', async () => {
    const huge = 'x'.repeat(20_000);
    const path = writeSession({ messages: [{ role: 'user', content: huge }] });
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(path);
    const turn = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.agent_turn');
    expect(turn).toBeDefined();
    const content = turn!.attributes['message.content'] as string;
    expect(content.length).toBeLessThanOrEqual(8000);
    expect(content.length).toBeLessThan(huge.length);
  });

  it('truncates an oversized tool.result leaf to MAX_ATTR_LENGTH', async () => {
    const huge = 'y'.repeat(20_000);
    const path = writeSession({
      messages: [
        {
          role: 'assistant',
          content: 'reading',
          tool_calls: [
            { id: 'call_huge', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_huge', content: huge },
      ],
    });
    const parser = new HermesSessionJsonParser();
    const spans = await parser.parse(path);
    const call = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.tool_call');
    expect(call).toBeDefined();
    const result = call!.events[0]?.attributes?.['tool.result'] as string;
    expect(result.length).toBeLessThanOrEqual(8000);
    expect(result.length).toBeLessThan(huge.length);
  });
});
