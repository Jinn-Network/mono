import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  emitSyntheticSpan,
  startSyntheticSpanProvider,
  type SyntheticSpanProvider,
} from '../../src/trajectory/synthetic-span-builder.js';
import type { TranscriptEvent } from '../../src/trajectory/transcript-parsers/types.js';
import { startReceiver, type Receiver } from '../../src/trajectory/receiver.js';
import { trace } from '@opentelemetry/api';

describe('emitSyntheticSpan', () => {
  let receiver: Receiver;
  let provider: SyntheticSpanProvider;

  beforeEach(async () => {
    receiver = await startReceiver({ grpcPort: 0, httpPort: 0 });
    provider = startSyntheticSpanProvider({
      otlpHttpEndpoint: `http://localhost:${receiver.httpPort}/v1/traces`,
    });
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    await receiver.shutdown();
  });

  async function waitForSpan(name: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (receiver.testSink.spans.some((s) => s.name === name)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for span '${name}'`);
  }

  it('emits a span for a user-message event', async () => {
    const event: TranscriptEvent = {
      kind: 'user-message',
      timestamp: '2026-05-07T00:00:00.000Z',
      content: 'hello world',
    };
    emitSyntheticSpan(provider, { tool: 'claude-code', sessionId: 'sess-1', event });
    await provider.flush();
    await waitForSpan('user-message');

    const matched = receiver.testSink.spans.find((s) => s.name === 'user-message');
    expect(matched).toBeDefined();
    expect(matched?.attributes['jinn.session.id']).toBe('sess-1');
    expect(matched?.attributes['transcript.tool']).toBe('claude-code');
    expect(matched?.attributes['message.content']).toBe('hello world');
  });

  it('emits a span for a tool-call event with args', async () => {
    const event: TranscriptEvent = {
      kind: 'tool-call',
      timestamp: '2026-05-07T00:00:01.000Z',
      name: 'Read',
      args: { path: 'x.ts' },
    };
    emitSyntheticSpan(provider, { tool: 'codex', sessionId: 'sess-2', event });
    await provider.flush();
    await waitForSpan('tool-call');

    const matched = receiver.testSink.spans.find((s) => s.name === 'tool-call');
    expect(matched).toBeDefined();
    expect(matched?.attributes['jinn.session.id']).toBe('sess-2');
    expect(matched?.attributes['transcript.tool']).toBe('codex');
    expect(matched?.attributes['tool.name']).toBe('Read');
    expect(matched?.attributes['tool.args']).toBe(JSON.stringify({ path: 'x.ts' }));
  });

  it('emits a span for a tool-result event', async () => {
    const event: TranscriptEvent = {
      kind: 'tool-result',
      timestamp: '2026-05-07T00:00:02.000Z',
      name: 'Read',
      content: 'file contents',
    };
    emitSyntheticSpan(provider, { tool: 'cursor', sessionId: 'sess-3', event });
    await provider.flush();
    await waitForSpan('tool-result');

    const matched = receiver.testSink.spans.find((s) => s.name === 'tool-result');
    expect(matched?.attributes['tool.name']).toBe('Read');
    expect(matched?.attributes['tool.result']).toBe('file contents');
    expect(matched?.attributes['tool.result.is_error']).toBe(false);
  });

  it('emits a span for a tool-result with isError', async () => {
    const event: TranscriptEvent = {
      kind: 'tool-result',
      timestamp: '2026-05-07T00:00:02.000Z',
      name: 'Bash',
      content: 'command failed',
      isError: true,
    };
    emitSyntheticSpan(provider, { tool: 'aider', sessionId: 'sess-4', event });
    await provider.flush();
    await waitForSpan('tool-result');

    const matched = receiver.testSink.spans.find((s) => s.name === 'tool-result');
    expect(matched?.attributes['tool.result.is_error']).toBe(true);
  });

  it('emits a span for an edit event', async () => {
    const event: TranscriptEvent = {
      kind: 'edit',
      timestamp: '2026-05-07T00:00:03.000Z',
      path: 'src/x.ts',
      diff: '@@ -1,1 +1,2 @@\n a\n+b',
    };
    emitSyntheticSpan(provider, { tool: 'continue', sessionId: 'sess-5', event });
    await provider.flush();
    await waitForSpan('edit');

    const matched = receiver.testSink.spans.find((s) => s.name === 'edit');
    expect(matched?.attributes['edit.path']).toBe('src/x.ts');
    expect(matched?.attributes['edit.diff']).toContain('@@ -1,1 +1,2 @@');
  });

  it('emits a span for an assistant-message event', async () => {
    const event: TranscriptEvent = {
      kind: 'assistant-message',
      timestamp: '2026-05-07T00:00:04.000Z',
      content: 'I will read the file',
    };
    emitSyntheticSpan(provider, { tool: 'gemini-cli', sessionId: 'sess-6', event });
    await provider.flush();
    await waitForSpan('assistant-message');

    const matched = receiver.testSink.spans.find((s) => s.name === 'assistant-message');
    expect(matched?.attributes['message.content']).toBe('I will read the file');
  });

  it('all synthetic spans within a session share a stable traceId', async () => {
    const events: TranscriptEvent[] = [
      { kind: 'user-message', timestamp: '2026-05-07T00:00:00.000Z', content: 'first' },
      { kind: 'assistant-message', timestamp: '2026-05-07T00:00:01.000Z', content: 'second' },
      { kind: 'tool-call', timestamp: '2026-05-07T00:00:02.000Z', name: 'X', args: {} },
    ];
    for (const event of events) {
      emitSyntheticSpan(provider, { tool: 'claude-code', sessionId: 'session-shared', event });
    }
    await provider.flush();
    // wait for all three by polling testSink length
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (receiver.testSink.spans.length >= 3) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const sessionSpans = receiver.testSink.spans.filter(
      (s) => s.attributes['jinn.session.id'] === 'session-shared',
    );
    expect(sessionSpans.length).toBe(3);
    const traceIds = new Set(sessionSpans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });
});
