import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeUsage, parseCodexUsage, harvestHarnessUsage } from '../../src/spend/usage.js';

describe('parseClaudeCodeUsage', () => {
  it('extracts total_cost_usd from the result line', () => {
    const jsonl = [
      '{"type":"assistant","message":{}}',
      '{"type":"result","total_cost_usd":0.42,"usage":{"input_tokens":1000,"output_tokens":200}}',
    ].join('\n');
    expect(parseClaudeCodeUsage(jsonl)).toEqual({ costUsd: 0.42, inputTokens: 1000, outputTokens: 200 });
  });

  it('returns null when there is no result line', () => {
    expect(parseClaudeCodeUsage('{"type":"assistant"}')).toBeNull();
  });

  it('ignores malformed lines', () => {
    const jsonl = 'not json\n{"type":"result","total_cost_usd":1.5}';
    expect(parseClaudeCodeUsage(jsonl)).toEqual({ costUsd: 1.5, inputTokens: undefined, outputTokens: undefined });
  });
});

describe('parseCodexUsage', () => {
  it('extracts tokens from the last turn.completed event', () => {
    const jsonl = [
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
      '{"type":"turn.completed","usage":{"input_tokens":4547,"output_tokens":120}}',
    ].join('\n');
    expect(parseCodexUsage(jsonl)).toEqual({ inputTokens: 4547, outputTokens: 120 });
  });

  it('returns null when there is no turn.completed event', () => {
    expect(parseCodexUsage('{"type":"turn.started"}')).toBeNull();
  });
});

describe('harvestHarnessUsage', () => {
  it('reads observed cost for claude-code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-cc-'));
    mkdirSync(join(dir, '.claude-code'));
    writeFileSync(join(dir, '.claude-code', 'stdout.jsonl'), '{"type":"result","total_cost_usd":0.7}');
    const usage = harvestHarnessUsage('claude-code', dir, 'claude-opus-4-7');
    expect(usage.costUsd).toBe(0.7);
    expect(usage.estimated).toBe(false);
  });

  it('reads observed cost for codex via tokenlens pricing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-codex-'));
    mkdirSync(join(dir, '.codex-code'));
    writeFileSync(join(dir, '.codex-code', 'stdout.jsonl'),
      '{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":500}}');
    const usage = harvestHarnessUsage('codex', dir, 'gpt-4o');
    expect(usage.estimated).toBe(false);
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it('falls back to an estimate when the output file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-miss-'));
    const usage = harvestHarnessUsage('claude-code', dir, 'claude-opus-4-7');
    expect(usage.estimated).toBe(true);
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it('falls back to the unknown-model constant for an unpriceable model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-unk-'));
    const usage = harvestHarnessUsage('hermes-agent', dir, undefined);
    expect(usage.estimated).toBe(true);
    expect(usage.costUsd).toBe(1.0);
  });
});
