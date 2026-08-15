import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestGeneratorModel, deriveDistributionClass } from '../../../src/harnesses/engine/generator-model.js';

const CLAUDE_CODE_WITH_MODEL_FIXTURE = readFileSync(
  fileURLToPath(new URL('../../../fixtures/transcripts/claude-code/stream-json-with-model.jsonl', import.meta.url)),
  'utf-8',
);
const CLAUDE_CODE_INIT_MODEL_FIXTURE = readFileSync(
  fileURLToPath(new URL('../../../fixtures/transcripts/claude-code/stream-json-example.jsonl', import.meta.url)),
  'utf-8',
);

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'generator-model-test-'));
}

describe('harvestGeneratorModel', () => {
  it('claude-code: harvests the authoritative system init model from a real transcript fixture', () => {
    const workingDir = mkTmp();
    mkdirSync(join(workingDir, '.claude-code'), { recursive: true });
    writeFileSync(join(workingDir, '.claude-code', 'stdout.jsonl'), CLAUDE_CODE_INIT_MODEL_FIXTURE);

    const result = harvestGeneratorModel('claude-code', workingDir, 'claude-haiku-4-5-20251001');

    expect(result).toEqual({
      id: 'claude-opus-4-7',
      provider: 'anthropic',
      source: 'stream',
    });
  });

  it('claude-code: falls back to assistant.message.model when init omits model', () => {
    const workingDir = mkTmp();
    mkdirSync(join(workingDir, '.claude-code'), { recursive: true });
    writeFileSync(join(workingDir, '.claude-code', 'stdout.jsonl'), CLAUDE_CODE_WITH_MODEL_FIXTURE);

    const result = harvestGeneratorModel('claude-code', workingDir, 'claude-haiku-4-5-20251001');

    expect(result).toEqual({
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      source: 'stream',
    });
  });

  it('claude-code: attributes an append-only retry log to the last completed session model', () => {
    const workingDir = mkTmp();
    mkdirSync(join(workingDir, '.claude-code'), { recursive: true });
    writeFileSync(
      join(workingDir, '.claude-code', 'stdout.jsonl'),
      [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-7' }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-7' } }),
        JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
        // A crash can append the beginning of another retry without a terminal
        // result. It must not replace the last completed session's model.
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-7' }),
      ].join('\n'),
    );

    const result = harvestGeneratorModel('claude-code', workingDir, 'claude-opus-4-7');

    expect(result).toEqual({
      id: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      source: 'stream',
    });
  });

  it('claude-code: falls back to configModel with source="config" when the transcript file is absent', () => {
    const workingDir = mkTmp();
    const result = harvestGeneratorModel('claude-code', workingDir, 'claude-haiku-4-5-20251001');
    expect(result).toEqual({ id: 'claude-haiku-4-5-20251001', provider: 'anthropic', source: 'config' });
  });

  it('claude-code: falls back to configModel with source="config" when no assistant record carries message.model', () => {
    const workingDir = mkTmp();
    mkdirSync(join(workingDir, '.claude-code'), { recursive: true });
    writeFileSync(
      join(workingDir, '.claude-code', 'stdout.jsonl'),
      '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}}\n',
    );
    const result = harvestGeneratorModel('claude-code', workingDir, 'claude-haiku-4-5-20251001');
    expect(result).toEqual({ id: 'claude-haiku-4-5-20251001', provider: 'anthropic', source: 'config' });
  });

  it('claude-code: returns id="unknown" with source="config" when neither transcript nor configModel is available', () => {
    const workingDir = mkTmp();
    const result = harvestGeneratorModel('claude-code', workingDir, undefined);
    expect(result).toEqual({ id: 'unknown', source: 'config' });
  });

  it('non-claude-code harness (codex): always falls back to config (no transcript harvest attempted)', () => {
    const workingDir = mkTmp();
    const result = harvestGeneratorModel('codex', workingDir, 'gpt-5-codex');
    expect(result).toEqual({ id: 'gpt-5-codex', provider: 'openai', source: 'config' });
  });

  it('never throws when workingDir does not exist at all', () => {
    expect(() => harvestGeneratorModel('claude-code', '/nonexistent/path/xyz', 'claude-haiku-4-5-20251001'))
      .not.toThrow();
  });
});

describe('deriveDistributionClass', () => {
  it('returns "restricted-tos" for an anthropic-provider generatorModel', () => {
    expect(deriveDistributionClass({ id: 'claude-sonnet-4-6', provider: 'anthropic', source: 'stream' }))
      .toBe('restricted-tos');
  });

  it('returns "restricted-tos" for an openai-provider generatorModel', () => {
    expect(deriveDistributionClass({ id: 'gpt-5-codex', provider: 'openai', source: 'config' }))
      .toBe('restricted-tos');
  });

  it('returns "restricted-tos" for a claude-prefixed id even without an explicit provider', () => {
    expect(deriveDistributionClass({ id: 'claude-haiku-4-5-20251001', source: 'config' }))
      .toBe('restricted-tos');
  });

  it('returns "unknown" for an undeterminable model', () => {
    expect(deriveDistributionClass({ id: 'unknown', source: 'config' })).toBe('unknown');
  });

  it('returns "unknown" when generatorModel is undefined', () => {
    expect(deriveDistributionClass(undefined)).toBe('unknown');
  });

  it('never returns "open" (no source provides an open-weights + license signal yet)', () => {
    const candidates = [
      { id: 'claude-sonnet-4-6', provider: 'anthropic', source: 'stream' as const },
      { id: 'gpt-5-codex', provider: 'openai', source: 'config' as const },
      { id: 'llama-3-70b', openWeights: true, source: 'config' as const },
      { id: 'unknown', source: 'config' as const },
    ];
    for (const c of candidates) {
      expect(deriveDistributionClass(c)).not.toBe('open');
    }
  });
});
