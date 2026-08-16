import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createLlmProxyApp } from '../../src/trajectory/llm-proxy.js';
import { exchangeToSpanAttributes, type LlmProxyExchange } from '../../src/trajectory/llm-proxy-spans.js';

async function startUpstream(handler: Parameters<typeof createServer>[0]): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('upstream did not bind');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('LLM API proxy', () => {
  const upstreams: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(upstreams.splice(0).map((u) => u.close()));
  });

  it('forwards Anthropic-shaped requests and returns upstream bytes unchanged', async () => {
    let upstreamBody = '';
    const upstream = await startUpstream((req, res) => {
      req.setEncoding('utf-8');
      req.on('data', (chunk) => { upstreamBody += chunk; });
      req.on('end', () => {
        expect(req.url).toBe('/v1/messages?beta=true');
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end('{"id":"msg_1","model":"claude-test","content":[{"type":"text","text":"ok"}]}');
      });
    });
    upstreams.push(upstream);

    const exchanges: LlmProxyExchange[] = [];
    const app = createLlmProxyApp({
      provider: 'anthropic',
      upstreamBaseUrl: upstream.url,
      onExchange: (exchange) => exchanges.push(exchange),
    });

    const response = await app.request('http://proxy.local/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-key',
        'x-jinn-session-id': 'sess-proxy-1',
      },
      body: '{"model":"claude-test","messages":[]}',
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe(
      '{"id":"msg_1","model":"claude-test","content":[{"type":"text","text":"ok"}]}',
    );
    expect(upstreamBody).toBe('{"model":"claude-test","messages":[]}');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({
      provider: 'anthropic',
      sessionId: 'sess-proxy-1',
      method: 'POST',
      path: '/v1/messages',
      status: 201,
    });
  });

  it('normalizes OpenAI exchanges into GenAI span attributes', () => {
    const attrs = exchangeToSpanAttributes({
      provider: 'openai',
      sessionId: 'sess-openai',
      method: 'POST',
      path: '/v1/chat/completions',
      status: 200,
      durationMs: 12,
      requestBody: '{"model":"gpt-test","messages":[]}',
      responseBody: '{"id":"chatcmpl_1"}',
    });

    expect(attrs['jinn.capture.path']).toBe('C');
    expect(attrs['jinn.span.kind']).toBe('jinn.llm_call');
    expect(attrs['jinn.session.id']).toBe('sess-openai');
    expect(attrs['gen_ai.system']).toBe('openai');
    expect(attrs['gen_ai.request.model']).toBe('gpt-test');
    expect(attrs['url.path']).toBe('/v1/chat/completions');
  });
});
