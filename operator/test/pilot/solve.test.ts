import { describe, it, expect } from 'vitest';
import { buildSolveArgs, parseSessionTokens, extractSessionId, type Arm } from '../../src/pilot/solve.js';

const armA: Arm = { name: 'A', skills: [] };
const armB: Arm = { name: 'B', skills: ['systematic-debugging'] };

describe('solve driver helpers', () => {
  it('arm A args enforce an empty loadout (--ignore-rules, no -s)', () => {
    const args = buildSolveArgs(armA, 'fix the bug', { maxTurns: 20 });
    expect(args).toEqual([
      'chat', '-q', 'fix the bug', '-Q', '--yolo', '--ignore-rules',
      '--pass-session-id', '--max-turns', '20',
    ]);
    expect(args).not.toContain('-s');
  });

  it('arm B adds exactly the skill loadout via -s', () => {
    const args = buildSolveArgs(armB, 'fix the bug', { maxTurns: 20 });
    expect(args).toContain('-s');
    expect(args[args.indexOf('-s') + 1]).toBe('systematic-debugging');
    // arm B is arm A + the loadout: identical otherwise
    expect(args.slice(0, 7)).toEqual(['chat', '-q', 'fix the bug', '-Q', '--yolo', '--ignore-rules', '-s']);
  });

  it('arm A args pin provider + model when supplied (Codex-subscription run)', () => {
    const args = buildSolveArgs(armA, 'fix the bug', { maxTurns: 20, provider: 'openai-codex', model: 'gpt-5.4-mini' });
    expect(args).toEqual([
      'chat', '-q', 'fix the bug', '-Q', '--yolo', '--ignore-rules',
      '--provider', 'openai-codex', '-m', 'gpt-5.4-mini',
      '--pass-session-id', '--max-turns', '20',
    ]);
  });

  it('parses provider-actual tokens from a session export line (non-reasoning → reasoningTokens 0)', () => {
    const line = JSON.stringify({
      input_tokens: 186114, output_tokens: 6207, cache_read_tokens: 258944,
      estimated_cost_usd: 0.02253, model: 'deepseek-v4-flash', cwd: '/tmp/armA',
    });
    expect(parseSessionTokens(line)).toEqual({ inputTokens: 186114, outputTokens: 6207, cacheReadTokens: 258944, reasoningTokens: 0 });
  });

  it('parses reasoning_tokens from a reasoning-model (Codex) export line', () => {
    const line = JSON.stringify({
      input_tokens: 15107, output_tokens: 102, reasoning_tokens: 17,
      cache_read_tokens: 0, cache_write_tokens: 0, model: 'gpt-5.4-mini',
    });
    expect(parseSessionTokens(line)).toEqual({ inputTokens: 15107, outputTokens: 102, cacheReadTokens: 0, reasoningTokens: 17 });
  });

  it('throws on a session export missing token fields (fail-loud, never silently zero)', () => {
    expect(() => parseSessionTokens(JSON.stringify({ model: 'x' }))).toThrow(/token/);
  });

  it('extracts the session id from the stderr marker', () => {
    expect(extractSessionId('...\nsession_id: 20260707_103508_da8b11\n...')).toBe('20260707_103508_da8b11');
    expect(extractSessionId('no marker here')).toBeNull();
  });
});
