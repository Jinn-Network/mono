import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
