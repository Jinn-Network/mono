import { describe, it, expect } from 'vitest';
import { validateSpanProfile, SPAN_PROFILE } from '../../src/trajectory/span-profile.js';
import type { Span } from '../../src/trajectory/schema.js';

function mkSpan(kind: string, attrs: Record<string, unknown>): Span {
  return {
    traceId: '0'.repeat(32),
    spanId: '1'.repeat(16),
    parentSpanId: null,
    name: 'test',
    kind: 'INTERNAL',
    startTimeUnixNano: '1',
    endTimeUnixNano: '2',
    attributes: {
      'jinn.span.kind': kind,
      'jinn.prevSpanHash': '0x' + 'aa'.repeat(32),
      ...attrs,
    },
    events: [],
    status: { code: 'OK' },
  };
}

describe('validateSpanProfile', () => {
  it('accepts jinn.phase with jinn.phase.name', () => {
    const s = mkSpan('jinn.phase', { 'jinn.phase.name': 'design' });
    expect(validateSpanProfile(s)).toEqual({ valid: true });
  });

  it('rejects jinn.phase missing jinn.phase.name', () => {
    const s = mkSpan('jinn.phase', {});
    const r = validateSpanProfile(s);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.missing).toContain('jinn.phase.name');
  });

  it('accepts jinn.llm_call with full gen_ai attrs', () => {
    const s = mkSpan('jinn.llm_call', {
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-opus-4-7',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 50,
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('rejects jinn.llm_call missing gen_ai.request.model', () => {
    const s = mkSpan('jinn.llm_call', { 'gen_ai.system': 'anthropic' });
    expect(validateSpanProfile(s).valid).toBe(false);
  });

  it('accepts jinn.mcp_call with server/tool attrs', () => {
    const s = mkSpan('jinn.mcp_call', {
      'mcp.server.name': 'hyperliquid',
      'mcp.tool.name': 'place_order',
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('accepts jinn.artifact.emit with cid/type/sha256', () => {
    const s = mkSpan('jinn.artifact.emit', {
      'jinn.artifact.cid': 'bafy-x',
      'jinn.artifact.artifactType': 'system_snapshot',
      'jinn.artifact.sha256': 'ab'.repeat(32),
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('accepts jinn.venue_io with net.peer attrs', () => {
    const s = mkSpan('jinn.venue_io', {
      'net.peer.name': 'api.hyperliquid-testnet.xyz',
      'http.request.method': 'POST',
      'http.response.status_code': 200,
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('accepts jinn.state_transition with from/to', () => {
    const s = mkSpan('jinn.state_transition', {
      'jinn.state.from': 'CLAIMED',
      'jinn.state.to': 'PACKAGED',
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('SPAN_PROFILE covers every normative kind', () => {
    for (const k of [
      'jinn.phase',
      'jinn.llm_call',
      'jinn.mcp_call',
      'jinn.artifact.emit',
      'jinn.venue_io',
      'jinn.state_transition',
    ]) {
      expect(SPAN_PROFILE[k]).toBeDefined();
    }
  });
});
