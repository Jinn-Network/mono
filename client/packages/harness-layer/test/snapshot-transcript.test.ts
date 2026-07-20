import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  unwrapDonation,
  untarGz,
  findSolveTranscript,
  extractSnapshotTranscript,
  parseSolveTranscript,
} from '../src/snapshot-transcript.js';
import { makeTar, makeTarGz, wrapDonation as wrap } from './tar-fixture.js';

const CLAUDE_JSONL = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fix the bug' }] } }) + '\n';

describe('unwrapDonation', () => {
  it('decodes base64 data when the declared and computed sha256 match', () => {
    const bytes = Buffer.from('hello world');
    const { wrapper, sha256 } = wrap(bytes);
    expect(unwrapDonation(wrapper, sha256).equals(bytes)).toBe(true);
  });

  it('throws on a declared-sha mismatch (wrong artifact requested)', () => {
    const { wrapper } = wrap(Buffer.from('hello'));
    expect(() => unwrapDonation(wrapper, 'f'.repeat(64))).toThrow(/sha256/);
  });

  it('throws when the decoded bytes do not hash to the declared sha (tampered data)', () => {
    const { wrapper, sha256 } = wrap(Buffer.from('hello'));
    (wrapper as any).data = Buffer.from('tampered').toString('base64');
    expect(() => unwrapDonation(wrapper, sha256)).toThrow(/sha256/);
  });

  it('throws on a non-donation payload shape', () => {
    expect(() => unwrapDonation({ some: 'json' }, 'a'.repeat(64))).toThrow(/encoding/);
    expect(() => unwrapDonation(null, 'a'.repeat(64))).toThrow();
  });
});

describe('untarGz', () => {
  it('lists regular-file entries with their bytes', () => {
    const gz = makeTarGz({ 'a.txt': 'AAA', 'dir/b.txt': 'BBBB' });
    const entries = untarGz(gz);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.txt']);
    expect(entries[0]!.bytes.toString()).toBe('AAA');
    expect(entries[1]!.bytes.toString()).toBe('BBBB');
  });

  it('throws on corrupt gzip', () => {
    expect(() => untarGz(Buffer.from('not gzip at all'))).toThrow();
  });

  it('rejects a decompressed payload over the bomb guard', () => {
    // 64 MiB of zeros compresses to ~64KB — must be rejected by maxOutputLength.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(() => untarGz(bomb)).toThrow();
  });

  it('stops cleanly on a truncated/malformed tar instead of looping', () => {
    const tar = makeTar({ 'a.txt': 'AAA' });
    const truncated = gzipSync(tar.subarray(0, 600)); // header + partial body
    const entries = untarGz(truncated);
    expect(entries.length).toBeLessThanOrEqual(1);
  });
});

describe('findSolveTranscript', () => {
  it('finds the claude-code transcript', () => {
    const entries = untarGz(makeTarGz({ '.claude-code/stdout.jsonl': CLAUDE_JSONL, 'task.json': '{}' }));
    const t = findSolveTranscript(entries)!;
    expect(t.harness).toBe('claude-code');
    expect(t.jsonl).toContain('fix the bug');
  });

  it('finds the codex transcript', () => {
    const entries = untarGz(makeTarGz({ '.codex-code/stdout.jsonl': '{"type":"turn.started"}\n' }));
    expect(findSolveTranscript(entries)!.harness).toBe('codex');
  });

  it('returns null for hermes-only or transcript-less snapshots', () => {
    expect(findSolveTranscript(untarGz(makeTarGz({ '.hermes-agent/stdout.log': 'plain text' })))).toBeNull();
    expect(findSolveTranscript(untarGz(makeTarGz({ 'task.json': '{}' })))).toBeNull();
  });
});

describe('extractSnapshotTranscript (end-to-end helper)', () => {
  it('unwraps + decompresses + finds the transcript from a wrapper', () => {
    const gz = makeTarGz({ '.claude-code/stdout.jsonl': CLAUDE_JSONL });
    const { wrapper, sha256 } = wrap(gz);
    const t = extractSnapshotTranscript(wrapper, sha256)!;
    expect(t.harness).toBe('claude-code');
    expect(t.jsonl).toContain('fix the bug');
  });

  it('returns null (not a throw) when the snapshot has no transcript', () => {
    const gz = makeTarGz({ 'task.json': '{}' });
    const { wrapper, sha256 } = wrap(gz);
    expect(extractSnapshotTranscript(wrapper, sha256)).toBeNull();
  });
});

describe('parseSolveTranscript', () => {
  it('uses the canonical Claude parser and preserves typed-span provenance', () => {
    const spans = parseSolveTranscript({
      harness: 'claude-code',
      jsonl: [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Fix the failing test.' },
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
      ].join('\n'),
    });

    expect(spans.map((span) => span.attributes['jinn.span.kind'])).toEqual(
      expect.arrayContaining(['jinn.agent_turn', 'jinn.tool_call']),
    );
    expect(
      spans.every(
        (span) =>
          span.attributes['jinn.transcript.parser'] === 'claude-code-stream-json' &&
          span.attributes['jinn.transcript.parserVersion'] === '1.0.0',
      ),
    ).toBe(true);
  });

  it('uses the canonical Codex parser', () => {
    const spans = parseSolveTranscript({
      harness: 'codex',
      jsonl: [
        JSON.stringify({
          timestamp: '2026-07-20T12:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Run the tests.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-20T12:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            arguments: '{"command":"pytest -x"}',
            call_id: 'call-1',
          },
        }),
      ].join('\n'),
    });

    expect(spans.some((span) => span.attributes['jinn.span.kind'] === 'jinn.tool_call')).toBe(
      true,
    );
    expect(
      spans.every(
        (span) =>
          span.attributes['jinn.transcript.parser'] === 'codex-exec-json' &&
          span.attributes['jinn.transcript.parserVersion'] === '1.0.0',
      ),
    ).toBe(true);
  });
});
