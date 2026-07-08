import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outlineTranscript } from '../src/transcript-outline.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLAUDE = readFileSync(join(FIXTURES, 'claude-code-stdout.fixture.jsonl'), 'utf8');
const CODEX = readFileSync(join(FIXTURES, 'codex-stdout.fixture.jsonl'), 'utf8');

describe('outlineTranscript — claude-code stream-json stdout', () => {
  it('extracts assistant text and tool calls from a REAL fixture', () => {
    const out = outlineTranscript('claude-code', CLAUDE)!;
    expect(out).toBeDefined();
    // real assistant reasoning surfaces
    expect(out).toContain('certificate validation');
    // tool calls surface with their tool name
    expect(out).toMatch(/- tool Edit:/);
    // the final result record surfaces
    expect(out).toMatch(/- result: success/);
  });

  it('skips noise: system records, thinking blocks, non-error tool results', () => {
    const out = outlineTranscript('claude-code', CLAUDE)!;
    expect(out).not.toContain('hook_started');
    expect(out).not.toContain('thinking');
    // the fixture's only tool_result is is_error=false → not in the outline
    expect(out).not.toMatch(/tool_result/);
  });

  it('surfaces an ERROR tool result (the failure signal lessons need)', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'FAILED: 3 tests', is_error: true }] } }),
    ].join('\n');
    const out = outlineTranscript('claude-code', jsonl)!;
    expect(out).toMatch(/- tool_result\[error\]: FAILED: 3 tests/);
  });

  it('collapses multi-line text into one outline line', () => {
    const jsonl = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'line one\nline two\nline three' }] } });
    const out = outlineTranscript('claude-code', jsonl)!;
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('line one line two line three');
  });
});

describe('outlineTranscript — codex exec --json stdout', () => {
  it('extracts agent messages and commands from a REAL fixture', () => {
    const out = outlineTranscript('codex', CODEX)!;
    expect(out).toBeDefined();
    // real agent reasoning surfaces
    expect(out).toContain('learn loop');
    // executed commands surface
    expect(out).toMatch(/- cmd: \/bin\/bash -lc/);
  });

  it('uses item.completed only (no started/completed duplicates)', () => {
    // fixture has item_37 as BOTH item.started and item.completed
    const out = outlineTranscript('codex', CODEX)!;
    const matches = out.split('\n').filter((l) => l.includes("sed -n '1,220p' src/sqlacodegen/generators.py"));
    expect(matches).toHaveLength(1);
  });

  it('flags a non-zero exit code on a command', () => {
    const jsonl = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pytest -x', exit_code: 1 } });
    const out = outlineTranscript('codex', jsonl)!;
    expect(out).toMatch(/- cmd: pytest -x \(exit 1\)/);
  });

  it('names unknown completed item types without crashing', () => {
    const jsonl = JSON.stringify({ type: 'item.completed', item: { type: 'file_change' } });
    const out = outlineTranscript('codex', jsonl)!;
    expect(out).toContain('- file_change');
  });
});

describe('outlineTranscript — robustness', () => {
  it('returns undefined for empty/unparseable input', () => {
    expect(outlineTranscript('claude-code', '')).toBeUndefined();
    expect(outlineTranscript('codex', 'not json\nstill not json')).toBeUndefined();
  });

  it('tolerates malformed lines mixed into a valid transcript', () => {
    const jsonl = ['garbage {', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still works' }] } })].join('\n');
    expect(outlineTranscript('claude-code', jsonl)).toContain('still works');
  });

  it('truncates very long text per line', () => {
    const jsonl = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } });
    const out = outlineTranscript('claude-code', jsonl)!;
    expect(out.length).toBeLessThan(400);
  });
});
