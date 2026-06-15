import { describe, expect, test } from 'vitest';
import { secretlintStage } from '../../../src/trajectory/scrub/secretlint-stage.js';
import type { KeyPolicy } from '../../../src/trajectory/scrub/key-policy.js';

const policy: KeyPolicy = { safe: ['llm.model'], drop: [] };
const GH = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';

describe('secretlintStage', () => {
  test('redacts rule-detected secrets in content values, records secret redactions, skips safe keys', async () => {
    const stage = secretlintStage(policy);
    const result = await stage.scrub({
      'tool.output': `token is ${GH} ok`,
      'llm.model': GH, // safe key — must NOT be scrubbed
    });

    expect(result.attributes['tool.output']).not.toContain(GH);
    expect(result.attributes['tool.output']).toContain('[SECRET:');
    expect(result.attributes['llm.model']).toBe(GH);
    expect(result.redactions.some((r) => r.stage === 'secretlint' && r.kind === 'secret')).toBe(true);
  });

  test('redacts high-entropy tokens no rule matched (entropy fallback)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
    const result = await stage.scrub({ 'tool.output': `value ${blob} end` });

    expect(result.attributes['tool.output']).not.toContain(blob);
    expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  test('leaves ordinary prose untouched', async () => {
    const stage = secretlintStage(policy);
    const result = await stage.scrub({ 'tool.output': 'the quick brown fox jumps over the lazy dog' });

    expect(result.attributes['tool.output']).toBe('the quick brown fox jumps over the lazy dog');
    expect(result.redactions).toEqual([]);
  });
});
