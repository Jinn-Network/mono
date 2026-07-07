import { describe, it, expect } from 'vitest';
import { findTraceSourceCid, decodeDonationArtifact, parseTraceEnvelope } from './corpus-trace';

describe('findTraceSourceCid', () => {
  it('returns the ipfs source cid of a trace artifact', () => {
    const manifest = {
      artifacts: [
        { artifactType: 'jinn.trace-envelope.v0', sources: [{ kind: 'ipfs', cid: 'bafTRACE' }] },
      ],
    };
    expect(findTraceSourceCid(manifest)).toBe('bafTRACE');
  });

  it('prefers the trace-typed artifact over a non-trace one', () => {
    const manifest = {
      artifacts: [
        { artifactType: 'jinn.skill.v1', sources: [{ kind: 'ipfs', cid: 'bafSKILL' }] },
        { artifactType: 'jinn.trace-envelope.v0', sources: [{ kind: 'ipfs', cid: 'bafTRACE' }] },
      ],
    };
    expect(findTraceSourceCid(manifest)).toBe('bafTRACE');
  });

  it('returns null when there is no public ipfs source', () => {
    const manifest = {
      artifacts: [{ artifactType: 'jinn.trace-envelope.v0', sources: [{ kind: 'http', cid: 'x' }] }],
    };
    expect(findTraceSourceCid(manifest)).toBeNull();
  });

  it('returns null on a malformed manifest', () => {
    expect(findTraceSourceCid(null)).toBeNull();
    expect(findTraceSourceCid({})).toBeNull();
    expect(findTraceSourceCid({ artifacts: 'nope' })).toBeNull();
  });
});

describe('decodeDonationArtifact', () => {
  it('base64-decodes the inner JSON', () => {
    const inner = { steps: [], task: { summary: 'hi' } };
    const artifact = { data: Buffer.from(JSON.stringify(inner)).toString('base64') };
    expect(decodeDonationArtifact(artifact)).toEqual(inner);
  });

  it('throws when the artifact has no base64 data field', () => {
    expect(() => decodeDonationArtifact({})).toThrow(/base64/);
    expect(() => decodeDonationArtifact(null)).toThrow();
  });
});

describe('parseTraceEnvelope', () => {
  it('projects steps to { name, args, result, redactedKeyCount }', () => {
    const inner = {
      environment: { model: 'm', harness: { name: 'h' } },
      steps: [
        {
          name: 'tool:terminal',
          attributes: { 'tool.args': { command: 'ls' }, 'tool.result': 'out' },
          redactedKeys: ['k1', 'k2'],
        },
      ],
    };
    const trace = parseTraceEnvelope(inner);
    expect(trace.model).toBe('m');
    expect(trace.harness).toBe('h');
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toEqual({
      name: 'tool:terminal',
      args: { command: 'ls' },
      result: 'out',
      redactedKeyCount: 2,
    });
  });

  it('coerces a non-string result to formatted JSON', () => {
    const inner = { steps: [{ name: 's', attributes: { 'tool.result': { code: 0 } } }] };
    const trace = parseTraceEnvelope(inner);
    expect(trace.steps[0].result).toBe(JSON.stringify({ code: 0 }, null, 2));
  });

  it('is defensive against missing steps / attributes', () => {
    expect(parseTraceEnvelope({}).steps).toEqual([]);
    expect(parseTraceEnvelope({ steps: 'nope' }).steps).toEqual([]);
    const trace = parseTraceEnvelope({ steps: [{ name: 'bare' }, 'garbage'] });
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toEqual({ name: 'bare', args: null, result: '', redactedKeyCount: 0 });
  });
});
