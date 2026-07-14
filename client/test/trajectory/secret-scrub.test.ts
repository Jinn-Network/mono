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

  it('recurses into nested objects — a nested secret-named key is redacted (#1473 finding 2)', () => {
    // Tightened from the original V1 top-level-only behaviour: a low-entropy
    // secret under a secret-named NESTED key (e.g. tool.args: { apiKey: ... })
    // was surviving both the add-time and emit-time scrub layers. Deep
    // recursion here closes the add-time side of that gap.
    const args = { outer: { apiKey: 'x' } };
    const { scrubbed, redactedKeys } = scrubMcpArgs(args);
    expect((scrubbed.outer as Record<string, unknown>).apiKey).toBe('<redacted:outer.apiKey>');
    expect(redactedKeys).toEqual(['outer.apiKey']);
  });
});

describe('scrubAttributes deep recursion (#1473 finding 2)', () => {
  it('redacts a secret-named key nested one level inside an object value', () => {
    const attrs = { 'tool.args': { apiKey: 'hunter2', command: 'echo hi' } };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    const nested = scrubbed['tool.args'] as Record<string, unknown>;
    expect(nested.apiKey).toBe('<redacted:tool.args.apiKey>');
    expect(nested.command).toBe('echo hi');
    expect(redactedKeys).toEqual(['tool.args.apiKey']);
  });

  it('redacts a secret-named key nested inside an array of objects', () => {
    const attrs = { 'tool.args': { headers: [{ name: 'x' }, { token: 'abc123' }] } };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    const headers = (scrubbed['tool.args'] as Record<string, unknown>).headers as Array<
      Record<string, unknown>
    >;
    expect(headers[0].name).toBe('x');
    expect(headers[1].token).toBe('<redacted:tool.args.headers.token>');
    expect(redactedKeys).toContain('tool.args.headers.token');
  });

  it('leaves non-secret nested keys untouched', () => {
    const attrs = { 'tool.args': { symbol: 'BTC', nested: { notional: 100 } } };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    expect(scrubbed['tool.args']).toEqual({ symbol: 'BTC', nested: { notional: 100 } });
    expect(redactedKeys).toEqual([]);
  });

  it('redacts at arbitrary depth (object under an object under an object)', () => {
    const attrs = { a: { b: { c: { secret: 'deep-value' } } } };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    expect(((scrubbed.a as Record<string, unknown>).b as Record<string, unknown>).c).toEqual({
      secret: '<redacted:a.b.c.secret>',
    });
    expect(redactedKeys).toEqual(['a.b.c.secret']);
  });

  it('replaces the whole value when a top-level key itself is secret-named, even if the value is an object', () => {
    const attrs = { password: { anything: 'goes-here' } };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    expect(scrubbed.password).toBe('<redacted:password>');
    expect(redactedKeys).toEqual(['password']);
  });

  it('does not mutate the input object on nested redaction', () => {
    const attrs = { 'tool.args': { apiKey: 'x' } };
    scrubAttributes(attrs);
    expect(attrs['tool.args']).toEqual({ apiKey: 'x' });
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
