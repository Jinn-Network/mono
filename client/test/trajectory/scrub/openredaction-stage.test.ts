import { describe, expect, test } from 'vitest';
import { openredactionStage } from '../../../src/trajectory/scrub/openredaction-stage.js';
import type { KeyPolicy } from '../../../src/trajectory/scrub/key-policy.js';

const policy: KeyPolicy = { safe: ['llm.model'], drop: [] };

describe('openredactionStage', () => {
  test('redacts structured PII in content values and records pii redactions', async () => {
    const stage = openredactionStage(policy);
    const result = await stage.scrub({
      'tool.output': 'call 555-123-4567 or use card 4111 1111 1111 1111',
      'llm.model': 'claude-555-123-4567', // safe key — must NOT be scrubbed
    });

    expect(result.attributes['tool.output']).not.toContain('555-123-4567');
    expect(result.attributes['tool.output']).not.toContain('4111 1111 1111 1111');
    // safe key passes through untouched even though its value looks like a phone
    expect(result.attributes['llm.model']).toBe('claude-555-123-4567');

    expect(result.redactions.length).toBeGreaterThanOrEqual(2);
    expect(result.redactions.every((r) => r.stage === 'openredaction' && r.kind === 'pii')).toBe(true);
  });

  test('passes through non-string and clean values unchanged, no redactions', async () => {
    const stage = openredactionStage(policy);
    const result = await stage.scrub({ count: 42, flag: true, note: 'nothing sensitive here' });

    expect(result.attributes).toEqual({ count: 42, flag: true, note: 'nothing sensitive here' });
    expect(result.redactions).toEqual([]);
  });
});
