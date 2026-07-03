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

  // #1348: slug-like `owner/repo/path` identifiers (seed-import task summaries)
  // are paths, not secrets — path length inflates entropy past 4.0 bits/char
  // even though every segment is a human-readable slug. They must survive.
  test('slug-like path summaries survive verbatim (#1348)', async () => {
    const stage = secretlintStage(policy);
    for (const summary of [
      'Seed import: obra/superpowers/skills/test-driven-development',
      'Seed import: agentspace-so/runcomfy-agent-skills/video-edit',
    ]) {
      const result = await stage.scrub({ 'tool.output': summary });
      expect(result.attributes['tool.output']).toBe(summary);
      expect(result.redactions).toEqual([]);
    }
  });

  // #1348 review finding: trailing prose punctuation must not defeat the path
  // carve-out. `api/v1/<secret>.` (sentence full stop) qualifies as PATH_SHAPED
  // (segment charset includes `.`), but the strict per-segment gate uses
  // SECRET_CHARSET (which excludes `.`) — so the dot poisoned the final segment
  // and the secret escaped, even though it redacted bare. Trailing dots are
  // stripped before the per-segment gate.
  test('trailing punctuation does not un-redact a path-embedded secret (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
    const result = await stage.scrub({ 'tool.output': `see api/v1/${blob}. done` });

    expect(result.attributes['tool.output']).not.toContain(blob);
    expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  // #1348 review finding guardrail: the trailing-dot strip must not sweep in a
  // slug path ending with a sentence full stop — the stripped segment is a
  // single character class and stays below the gate.
  test('slug path with trailing full stop survives verbatim (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const summary = 'Seed import: obra/superpowers/skills/test-driven-development.';
    const result = await stage.scrub({ 'tool.output': summary });

    expect(result.attributes['tool.output']).toBe(summary);
    expect(result.redactions).toEqual([]);
  });

  // #1348 review finding: the PATH_SHAPED carve-out must not un-redact a
  // genuine secret that merely contains slashes. A canonical AWS secret key
  // has `/` in its base64 alphabet, qualifies as PATH_SHAPED, and — judged
  // per-segment — escaped because no single `/`-run passed the strict gate.
  // The whole token mixes 3 character classes; real slugs don't.
  test('AWS secret key with interior slashes still redacts (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const result = await stage.scrub({ 'tool.output': `the deploy used ${awsSecret} and completed` });

    expect(result.attributes['tool.output']).not.toContain(awsSecret);
    expect(result.redactions.some((r) => r.kind === 'secret')).toBe(true);
  });

  // #1348 review finding: same escape class, generic shape — a high-entropy
  // 3-class secret with interior slashes must redact exactly like the same
  // string without slashes.
  test('high-entropy secret with interior slashes still redacts (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2/sT8yU1nB6mC4/dF0gH5jL';
    const result = await stage.scrub({ 'tool.output': `value ${blob} end` });

    expect(result.attributes['tool.output']).not.toContain(blob);
    expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  // #1348 review finding: a secret used as a filename with an extension —
  // `download/<blob>.tar.gz` — escaped because interior dots poisoned the
  // SECRET_CHARSET per-segment check (only trailing dots were stripped).
  // Candidate segments must be split on dots as well as slashes so the blob
  // between dots gates on its own.
  test('secret as filename with extension still redacts (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
    const result = await stage.scrub({ 'tool.output': `fetch download/${blob}.tar.gz now` });

    expect(result.attributes['tool.output']).not.toContain(blob);
    expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  // #1348 guardrail: the path carve-out must NOT weaken genuine secret
  // coverage — a secret embedded as a path segment still redacts.
  test('path-embedded secrets still redact (#1348 guardrail)', async () => {
    const stage = secretlintStage(policy);

    const ghPath = `api/v1/${GH}`;
    const ghResult = await stage.scrub({ 'tool.output': `fetching ${ghPath} now` });
    expect(ghResult.attributes['tool.output']).not.toContain(GH);
    expect(ghResult.redactions.some((r) => r.kind === 'secret')).toBe(true);

    const akiaPath = 'creds/AKIAIOSFODNN7EXAMPLE1234/live';
    const akiaResult = await stage.scrub({ 'tool.output': `reading ${akiaPath} in prose` });
    expect(akiaResult.attributes['tool.output']).not.toContain('AKIAIOSFODNN7EXAMPLE1234');
    expect(akiaResult.redactions.some((r) => r.kind === 'secret')).toBe(true);
  });
});
