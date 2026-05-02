import { describe, it, expect } from 'vitest';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { tracedHttpCall } from '../../../src/trajectory/wrappers/http.js';

describe('tracedHttpCall', () => {
  it('emits a jinn.llm_call span for model endpoints', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    await tracedHttpCall({
      collector: c,
      spanKind: 'jinn.llm_call',
      genAi: {
        system: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 40,
      },
      req: { url: 'https://api.anthropic.com/v1/messages', method: 'POST' },
      invoke: async () => ({ status: 200, body: { ok: true } }),
    });
    const snap = c.snapshot();
    expect(snap.spans).toHaveLength(1);
    expect(snap.spans[0].attributes['jinn.span.kind']).toBe('jinn.llm_call');
    expect(snap.spans[0].attributes['gen_ai.request.model']).toBe('claude-opus-4-7');
    expect(snap.spans[0].attributes['gen_ai.usage.input_tokens']).toBe(100);
  });

  it('emits a jinn.venue_io span for non-LLM endpoints', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    await tracedHttpCall({
      collector: c,
      spanKind: 'jinn.venue_io',
      req: { url: 'https://api.hyperliquid-testnet.xyz/info', method: 'POST' },
      invoke: async () => ({ status: 200, body: {} }),
    });
    const s = c.snapshot().spans[0];
    expect(s.attributes['jinn.span.kind']).toBe('jinn.venue_io');
    expect(s.attributes['net.peer.name']).toBe('api.hyperliquid-testnet.xyz');
    expect(s.attributes['http.request.method']).toBe('POST');
    expect(s.attributes['http.response.status_code']).toBe(200);
  });

  it('records ERROR status when invoke throws, and rethrows', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    await expect(
      tracedHttpCall({
        collector: c,
        spanKind: 'jinn.venue_io',
        req: { url: 'https://x.example/api', method: 'GET' },
        invoke: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    const s = c.snapshot().spans[0];
    expect(s.status.code).toBe('ERROR');
  });

  it('scrubs Authorization header before attaching it to the span', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    await tracedHttpCall({
      collector: c,
      spanKind: 'jinn.llm_call',
      genAi: { system: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1 },
      req: {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: { authorization: 'Bearer sk-abc' },
      },
      invoke: async () => ({ status: 200, body: {} }),
    });
    const snap = c.snapshot();
    expect(snap.spans[0].attributes['http.request.header.authorization']).toBe(
      '<redacted:http.request.header.authorization>',
    );
    expect(snap.redactionManifest.totalRedactions).toBe(1);
  });
});
