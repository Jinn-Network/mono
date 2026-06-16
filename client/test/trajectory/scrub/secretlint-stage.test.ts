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

  // Recall improvement (A1): secret-shaped tokens in the 16–19 char band that
  // the old 20-char entropy floor never considered are now caught, gated on the
  // secret charset + ≥2 character classes so legit identifiers/words are spared.
  test('catches secret-shaped tokens in the 16-19 char band (charset + mixed classes)', async () => {
    const stage = secretlintStage(policy);
    for (const tok of ['aB3dE6gH9jK2mN5p', 'x7y2z9w4v1u8t3s6', 'aB3dE6gH9jK2mN5pQ8']) {
      const result = await stage.scrub({ 'tool.output': `value ${tok} end` });
      expect(result.attributes['tool.output'], `expected ${tok} (len ${tok.length}) redacted`).not.toContain(tok);
      expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
    }
  });

  // Guardrail (A1): the recall improvement must not widen the blast radius onto
  // clearly-legitimate content. Ordinary prose AND representative legit tokens —
  // a long English word, a dictionary word + numeric suffix, a snake_case
  // identifier, a long camelCase type name — survive untouched.
  test('legitimate content survives (no over-redaction from the 16-19 band rule)', async () => {
    const stage = secretlintStage(policy);
    const legit =
      'the authentication subsystem validates incoming requests; ' +
      'supercalifragilistic authentication123 config_value_set_42 AbstractSingletonFactory';
    const result = await stage.scrub({ 'tool.output': legit });
    expect(result.attributes['tool.output']).toBe(legit);
    expect(result.redactions).toEqual([]);
  });

  // A pure-digit run (no letters) is NOT secret-shaped under this rule even at
  // ≥16 chars — it has a single character class. Such numeric runs (phone/card-
  // shaped) are openredaction's job, not the entropy fallback's; leaving them
  // here avoids redacting benign long integers.
  test('does not redact a pure-digit run via the shape gate', async () => {
    const stage = secretlintStage(policy);
    const result = await stage.scrub({ 'tool.output': 'count 1234567890123456 done' });
    expect(result.attributes['tool.output']).toBe('count 1234567890123456 done');
    expect(result.redactions).toEqual([]);
  });
});
