/**
 * Normative span profile per scope §3.1 K6 + §4.3.
 *
 * For each jinn.span.kind, declares required attribute keys. Consumers
 * (Plan F conformance suite, manifest-validation layer) call
 * validateSpanProfile to check each span in a trajectory.
 *
 * Required attributes at V1 (all tiers). Attested-tier extensions (TLS
 * transcript CIDs) layer on top in V2.
 */

import type { Span, JinnSpanKind } from './schema.js';

export const SPAN_PROFILE: Record<JinnSpanKind, readonly string[]> = {
  'jinn.phase': ['jinn.phase.name'],
  'jinn.llm_call': [
    'gen_ai.system',
    'gen_ai.request.model',
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
  ],
  'jinn.mcp_call': ['mcp.server.name', 'mcp.tool.name'],
  'jinn.artifact.emit': [
    'jinn.artifact.cid',
    'jinn.artifact.artifactType',
    'jinn.artifact.sha256',
  ],
  'jinn.venue_io': [
    'net.peer.name',
    'http.request.method',
    'http.response.status_code',
  ],
  'jinn.state_transition': ['jinn.state.from', 'jinn.state.to'],
  'jinn.agent_turn': [
    'jinn.turn.role',
    'message.content',
    'jinn.transcript.sourceFormat',
    'jinn.transcript.parser',
    'jinn.transcript.parserVersion',
  ],
  'jinn.tool_call': [
    'tool.name',
    'tool.args',
    'jinn.transcript.sourceFormat',
    'jinn.transcript.parser',
    'jinn.transcript.parserVersion',
  ],
};

export type SpanProfileResult =
  | { valid: true }
  | { valid: false; missing: string[]; kind: string };

export function validateSpanProfile(span: Span): SpanProfileResult {
  const kind = span.attributes['jinn.span.kind'] as JinnSpanKind;
  const required = SPAN_PROFILE[kind];
  if (!required) return { valid: false, missing: ['<unknown-kind>'], kind };
  const missing = required.filter((k) => span.attributes[k] === undefined);
  if (missing.length > 0) return { valid: false, missing, kind };
  return { valid: true };
}

/** Bulk-validate all spans in a trajectory. Returns first failure, or null if all pass. */
export function findFirstProfileViolation(spans: Span[]): {
  span: Span;
  result: Exclude<SpanProfileResult, { valid: true }>;
} | null {
  for (const s of spans) {
    const r = validateSpanProfile(s);
    if (!r.valid) return { span: s, result: r };
  }
  return null;
}
