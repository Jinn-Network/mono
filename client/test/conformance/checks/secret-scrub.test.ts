import { describe, it, expect } from 'vitest';
import { checkSecretScrub } from '../../../src/conformance/checks/secret-scrub.js';
import type { ConformanceContext } from '../../../src/conformance/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(spans: Array<{
  spanId: string;
  attributes: Record<string, unknown>;
  events?: Array<{ attributes?: Record<string, unknown> }>;
}>): ConformanceContext {
  return {
    trajectory: { spans } as unknown,
    envelopeCid: 'bafy-test',
    options: {},
  };
}

function spanWith(
  attrs: Record<string, unknown>,
  events?: Array<{ attributes?: Record<string, unknown> }>,
) {
  return {
    spanId: '1'.repeat(16),
    attributes: {
      'jinn.span.kind': 'jinn.llm_call',
      'jinn.prevSpanHash': '0x' + 'aa'.repeat(32),
      ...attrs,
    },
    events: events ?? [],
  };
}

// ─── Span attribute tests ─────────────────────────────────────────────────────

describe('checkSecretScrub — span attributes', () => {
  it('passes when no sensitive attributes are present', () => {
    const ctx = makeCtx([spanWith({ 'gen_ai.system': 'anthropic' })]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('secret-scrub.compliance');
    expect(result.layer).toBe(1);
  });

  it('skips when no trajectory is present', () => {
    const ctx: ConformanceContext = { envelopeCid: 'bafy-test', options: {} };
    const result = checkSecretScrub(ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('passes when sensitive attributes use redacted markers', () => {
    const ctx = makeCtx([
      spanWith({
        'http.request.header.authorization': '<redacted:authorization>',
        'mcp.arg.apiKey': '<redacted:apiKey>',
      }),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(true);
  });

  it('passes when sensitive attribute value is an empty string', () => {
    const ctx = makeCtx([spanWith({ 'http.request.header.authorization': '' })]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(true);
  });

  it('fails on raw Bearer token in *.authorization', () => {
    const ctx = makeCtx([
      spanWith({
        'http.request.header.authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
      }),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/authorization/);
  });

  it('fails on JWT in *.authorization', () => {
    const ctx = makeCtx([
      spanWith({
        'http.request.header.authorization': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      }),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/authorization/);
  });

  it('fails on raw Anthropic API key in *.apiKey', () => {
    const ctx = makeCtx([
      spanWith({
        'gen_ai.apiKey': 'sk-ant-api03-abcdefghij1234567890abcdef1234567890abcdef',
      }),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/apiKey/);
  });

  it('fails on raw private key in *.privateKey', () => {
    const ctx = makeCtx([spanWith({ 'wallet.privateKey': '0x' + 'a'.repeat(64) })]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/privateKey/);
  });

  it('passes when a 64-hex value is in a non-privateKey attribute (hashes are legitimate)', () => {
    const ctx = makeCtx([
      // A tx hash in a non-secret attribute — should not trigger
      spanWith({ 'jinn.phase.name': 'design', 'tx.hash': '0x' + 'a'.repeat(64) }),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(true);
  });

  it('reports at most 5 failures per run', () => {
    const spans = Array.from({ length: 10 }, (_, i) =>
      spanWith({
        [`http.span${i}.authorization`]: `Bearer eyJhbGciOiJIUzI1NiJ9.abc${i}.def`,
      }),
    );
    const ctx = makeCtx(spans);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(false);
    const count = (result.detail?.split('; ') ?? []).length;
    expect(count).toBeLessThanOrEqual(5);
  });
});

// ─── Event attribute tests ────────────────────────────────────────────────────

describe('checkSecretScrub — event attributes', () => {
  it('passes when event attributes contain no sensitive keys', () => {
    const ctx = makeCtx([
      spanWith({ 'gen_ai.system': 'anthropic' }, [
        { attributes: { 'subprocess.stdout.len': 42 } },
      ]),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(true);
  });

  it('fails when an event attribute contains a raw API key', () => {
    // Simulates the pre-fix leaky path: subprocess output with an API key
    // echoed back through event attributes (now prevented by subprocess.ts,
    // but caught as a defence-in-depth check).
    const ctx = makeCtx([
      spanWith({ 'jinn.span.kind': 'jinn.state_transition' }, [
        {
          attributes: {
            'mcp.response.token': 'sk-ant-api03-supersecret1234567890abcdef',
          },
        },
      ]),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/event attr/);
    expect(result.detail).toMatch(/token/);
  });

  it('fails when an event attribute contains a raw Bearer token', () => {
    const ctx = makeCtx([
      spanWith({}, [
        {
          attributes: {
            'response.authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
          },
        },
      ]),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/event attr/);
  });

  it('passes when event attribute secret key is properly redacted', () => {
    const ctx = makeCtx([
      spanWith({}, [
        {
          attributes: {
            'response.authorization': '<redacted:response.authorization>',
          },
        },
      ]),
    ]);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(true);
  });

  it('passes when span has no events array', () => {
    // Spans without events field should not throw
    const ctx = {
      trajectory: {
        spans: [{ spanId: '1'.repeat(16), attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.prevSpanHash': '0x' + 'aa'.repeat(32) } }],
      },
      envelopeCid: 'bafy-test',
      options: {},
    } as ConformanceContext;
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(true);
  });

  it('caps at 5 total failures across span + event attributes', () => {
    // 3 span attr failures + 3 event attr failures → only 5 reported
    const spans = [
      spanWith(
        {
          'http.span1.authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
          'http.span2.authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
          'http.span3.authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
        },
        [
          { attributes: { 'event1.token': 'sk-ant-api03-abcdefghij1234567890abcdef1234567890abcdef' } },
          { attributes: { 'event2.token': 'sk-ant-api03-abcdefghij1234567890abcdef1234567890abcdef' } },
          { attributes: { 'event3.token': 'sk-ant-api03-abcdefghij1234567890abcdef1234567890abcdef' } },
        ],
      ),
    ];
    const ctx = makeCtx(spans);
    const result = checkSecretScrub(ctx);
    expect(result.passed).toBe(false);
    const count = (result.detail?.split('; ') ?? []).length;
    expect(count).toBeLessThanOrEqual(5);
  });
});
