import { describe, it, expect } from 'vitest';
import {
  SECRET_NAME_PATTERNS,
  isSecretKey,
  scrubAttributes,
  scrubMcpArgs,
} from '../../src/trajectory/secret-scrub.js';

describe('isSecretKey', () => {
  it('matches authorization / apiKey / bearer / password / secret / token / privateKey (case-insensitive)', () => {
    for (const k of [
      'authorization',
      'apiKey',
      'API_KEY',
      'bearer',
      'password',
      'secret',
      'token',
      'privateKey',
      'http.request.header.authorization',
      'some.weird.api_key',
      'x.something.bearer',
    ]) {
      expect(isSecretKey(k)).toBe(true);
    }
  });

  it('does not match non-secret keys', () => {
    for (const k of ['gen_ai.request.model', 'mcp.tool.name', 'net.peer.name', 'jinn.phase.name']) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});

describe('scrubAttributes', () => {
  it('replaces secret values with <redacted:keyname> and records the key', () => {
    const attrs = {
      'gen_ai.request.model': 'claude',
      'http.request.header.authorization': 'Bearer sk-abc',
      'mcp.tool.args.password': 'hunter2',
    };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    expect(scrubbed['gen_ai.request.model']).toBe('claude');
    expect(scrubbed['http.request.header.authorization']).toBe(
      '<redacted:http.request.header.authorization>',
    );
    expect(scrubbed['mcp.tool.args.password']).toBe('<redacted:mcp.tool.args.password>');
    expect(redactedKeys.sort()).toEqual(
      ['http.request.header.authorization', 'mcp.tool.args.password'].sort(),
    );
  });

  it('is a no-op when no secrets are present', () => {
    const attrs = { 'gen_ai.system': 'anthropic' };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    expect(scrubbed).toEqual(attrs);
    expect(redactedKeys).toEqual([]);
  });

  it('does not mutate the input object', () => {
    const attrs = { password: 'x' };
    scrubAttributes(attrs);
    expect(attrs.password).toBe('x');
  });
});

describe('scrubMcpArgs', () => {
  it('redacts values when arg names match secret patterns', () => {
    const args = { symbol: 'BTC', apiKey: 'xyz', notional: 100 };
    const { scrubbed, redactedKeys } = scrubMcpArgs(args);
    expect(scrubbed.symbol).toBe('BTC');
    expect(scrubbed.notional).toBe(100);
    expect(scrubbed.apiKey).toBe('<redacted:apiKey>');
    expect(redactedKeys).toEqual(['apiKey']);
  });

  it('handles nested objects shallowly (only top-level keys)', () => {
    // V1 is top-level only; nested is Plan F tightening.
    const args = { outer: { apiKey: 'x' } };
    const { redactedKeys } = scrubMcpArgs(args);
    expect(redactedKeys).toEqual([]);
  });
});

describe('SECRET_NAME_PATTERNS', () => {
  it('is the exact V1 list', () => {
    expect(SECRET_NAME_PATTERNS.map((p) => p.source)).toEqual([
      '(^|\\.)authorization$',
      '(^|\\.)apikey$',
      '(^|\\.)api[_-]?key$',
      '(^|\\.)bearer$',
      '(^|\\.)password$',
      '(^|\\.)secret$',
      '(^|\\.)token$',
      '(^|\\.)privatekey$',
      '(^|\\.)private[_-]?key$',
    ]);
  });
});
