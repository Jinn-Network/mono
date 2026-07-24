import { describe, expect, test } from 'vitest';
import { classifyKey, keyPolicyStage, type KeyPolicy } from '../../../src/trajectory/scrub/key-policy.js';
import { DEFAULT_KEY_POLICY } from '../../../src/trajectory/scrub/build.js';

const policy: KeyPolicy = {
  safe: ['llm.model', 'duration.ms', 'jinn.span.*'],
  drop: ['http.request.header.authorization', 'env.*'],
};

describe('classifyKey', () => {
  test('exact safe key → safe', () => {
    expect(classifyKey('llm.model', policy)).toBe('safe');
  });

  test('wildcard safe key → safe', () => {
    expect(classifyKey('jinn.span.kind', policy)).toBe('safe');
  });

  test('exact drop key → drop', () => {
    expect(classifyKey('http.request.header.authorization', policy)).toBe('drop');
  });

  test('wildcard drop key → drop', () => {
    expect(classifyKey('env.OPENAI_API_KEY', policy)).toBe('drop');
  });

  test('drop wins when a key matches both safe and drop', () => {
    const p: KeyPolicy = { safe: ['x.*'], drop: ['x.secret'] };
    expect(classifyKey('x.secret', p)).toBe('drop');
  });

  test('unknown key → content', () => {
    expect(classifyKey('tool.output', policy)).toBe('content');
  });
});

describe('DEFAULT_KEY_POLICY', () => {
  // The production default must drop the spec stage-1 high-confidence keys
  // (auth headers, cookies, env dumps) — not ship an inert empty drop list.
  test.each([
    'http.request.header.authorization',
    'http.response.header.authorization',
    'http.request.header.cookie',
    'http.response.header.set-cookie',
    'env.OPENAI_API_KEY',
    'env.AWS_SECRET_ACCESS_KEY',
  ])('drops %s', (key) => {
    expect(classifyKey(key, DEFAULT_KEY_POLICY)).toBe('drop');
  });

  test.each(['host', 'hostname', 'attempt.host', 'os.hostname'])(
    'machine-identity drops %s (D3 carrier)',
    (key) => {
      expect(classifyKey(key, DEFAULT_KEY_POLICY)).toBe('machine-identity');
    },
  );

  test('keeps jinn.* attributes safe', () => {
    expect(classifyKey('jinn.span.kind', DEFAULT_KEY_POLICY)).toBe('safe');
  });
});

describe('keyPolicyStage', () => {
  test('deletes drop keys (with redaction records), keeps safe + content', () => {
    const stage = keyPolicyStage(policy);
    const result = stage.scrub({
      'llm.model': 'claude',
      'http.request.header.authorization': 'Bearer sk-xxx',
      'env.OPENAI_API_KEY': 'sk-yyy',
      'tool.output': 'some text',
    });

    expect(result.attributes).toEqual({
      'llm.model': 'claude',
      'tool.output': 'some text',
    });
    expect(result.redactions).toEqual([
      { key: 'http.request.header.authorization', stage: 'key-policy', kind: 'dropped-key' },
      { key: 'env.OPENAI_API_KEY', stage: 'key-policy', kind: 'dropped-key' },
    ]);
  });

  test('stage exposes name + version for local pipeline-profile inspection', () => {
    const stage = keyPolicyStage(policy);
    expect(stage.name).toBe('key-policy');
    expect(typeof stage.version).toBe('string');
  });
});
