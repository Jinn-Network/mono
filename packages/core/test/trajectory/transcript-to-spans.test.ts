import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeCodeStreamJsonParser,
  CodexExecJsonParser,
  type TranscriptSpanInput,
} from '../../src/trajectory/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function writeTranscript(rawText: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'core-transcript-spans-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'transcript.jsonl');
  await writeFile(path, rawText);
  return path;
}

function withoutTimestamps(spans: TranscriptSpanInput[]): unknown[] {
  return spans.map(({ startTimeUnixNano: _start, endTimeUnixNano: _end, ...span }) => span);
}

const claudeTranscript = [
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Inspect the failing test.' },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect it.' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'test.ts' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'expect(true).toBe(true)' },
      ],
    },
  }),
].join('\n');

const codexTranscript = [
  JSON.stringify({
    timestamp: '2026-07-20T12:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Inspect the failing test.' }],
    },
  }),
  JSON.stringify({
    timestamp: '2026-07-20T12:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell',
      arguments: '{"command":"yarn test"}',
      call_id: 'call-1',
    },
  }),
  JSON.stringify({
    timestamp: '2026-07-20T12:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'all green',
    },
  }),
].join('\n');

const directCodexExecFixturePath = fileURLToPath(
  new URL(
    '../../../../client/packages/harness-layer/test/fixtures/codex-stdout.fixture.jsonl',
    import.meta.url,
  ),
);
const directCodexExecTranscript = readFileSync(directCodexExecFixturePath, 'utf8');

describe.each([
  ['Claude Code', new ClaudeCodeStreamJsonParser(), claudeTranscript, true],
  ['Codex', new CodexExecJsonParser(), codexTranscript, false],
] as const)('%s in-memory transcript parser', (_label, parser, rawText, hasSyntheticTime) => {
  it('emits typed spans with complete parser provenance', () => {
    const spans = parser.parseText(rawText);

    expect(spans.some((span) => span.attributes['jinn.span.kind'] === 'jinn.agent_turn')).toBe(
      true,
    );
    expect(spans.some((span) => span.attributes['jinn.span.kind'] === 'jinn.tool_call')).toBe(
      true,
    );
    expect(
      spans.every(
        (span) =>
          span.attributes['jinn.transcript.parser'] === parser.parserName &&
          span.attributes['jinn.transcript.parserVersion'] === parser.parserVersion &&
          span.attributes['jinn.transcript.sourceFormat'] === parser.sourceFormat,
      ),
    ).toBe(true);
  });

  it('keeps file and in-memory parsing behavior equivalent', async () => {
    const path = await writeTranscript(rawText);
    const fromFile = await parser.parse(path);
    const fromMemory = parser.parseText(rawText);

    expect(hasSyntheticTime ? withoutTimestamps(fromFile) : fromFile).toEqual(
      hasSyntheticTime ? withoutTimestamps(fromMemory) : fromMemory,
    );
  });
});

describe('Codex direct exec stream', () => {
  it('parses the captured item stream into turns, paired commands, and terminal usage', async () => {
    const parser = new CodexExecJsonParser();
    const spans = await parser.parse(directCodexExecFixturePath);
    const turns = spans.filter(
      (span) => span.attributes['jinn.span.kind'] === 'jinn.agent_turn',
    );
    const toolCalls = spans.filter(
      (span) => span.attributes['jinn.span.kind'] === 'jinn.tool_call',
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]?.attributes['message.content']).toContain(
      'I’m starting with the learn loop',
    );
    expect(turns[1]?.attributes['gen_ai.usage.input_tokens']).toBe(3_679_427);
    expect(turns[1]?.attributes['gen_ai.usage.output_tokens']).toBe(14_552);

    expect(toolCalls).toHaveLength(3);
    expect(
      toolCalls.every((span) => span.attributes['tool.name'] === 'command_execution'),
    ).toBe(true);
    expect(toolCalls[0]?.attributes['tool.args']).toEqual({
      command: '/bin/bash -lc "sed -n \'1,220p\' src/sqlacodegen/generators.py"',
    });
    expect(toolCalls[0]?.events[0]?.attributes?.['tool.result']).toContain(
      'class CodeGenerator',
    );
    expect(toolCalls[0]?.status).toEqual({ code: 'OK' });
    expect(toolCalls[2]?.events).toEqual([]);
    expect(toolCalls[2]?.status).toEqual({ code: 'UNSET' });

    expect(parser.parseText(directCodexExecTranscript)).toEqual(spans);
  });
});
