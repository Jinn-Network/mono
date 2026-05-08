import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startReceiver, type Receiver } from '../../src/trajectory/receiver.js';
import { trace, SpanKind } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter as HttpExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as GrpcExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

describe('embedded OTLP receiver', () => {
  let receiver: Receiver;

  beforeEach(async () => {
    receiver = await startReceiver({ grpcPort: 0, httpPort: 0 });
  });

  afterEach(async () => {
    // Disable global tracer provider to avoid leaking between tests; the
    // NodeSDK in each test registers a provider globally on `start()`.
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

  it('receives a span from a remote OTLP/HTTP exporter', async () => {
    const sdk = new NodeSDK({
      traceExporter: new HttpExporter({
        url: `http://localhost:${receiver.httpPort}/v1/traces`,
      }),
    });
    sdk.start();

    const tracer = trace.getTracer('test-http');
    const span = tracer.startSpan('test-http-span', { kind: SpanKind.INTERNAL });
    span.setAttribute('test.key', 'test-value-http');
    span.end();

    // sdk.shutdown() force-flushes the BatchSpanProcessor and awaits export.
    await sdk.shutdown();
    await waitForSpan('test-http-span');

    const matched = receiver.testSink.spans.find((s) => s.name === 'test-http-span');
    expect(matched).toBeDefined();
    expect(matched?.attributes['test.key']).toBe('test-value-http');
  });

  it('receives a span from a remote OTLP/gRPC exporter', async () => {
    const sdk = new NodeSDK({
      traceExporter: new GrpcExporter({
        url: `http://localhost:${receiver.grpcPort}`,
      }),
    });
    sdk.start();

    const tracer = trace.getTracer('test-grpc');
    const span = tracer.startSpan('test-grpc-span', { kind: SpanKind.INTERNAL });
    span.setAttribute('test.key', 'test-value-grpc');
    span.end();

    await sdk.shutdown();
    await waitForSpan('test-grpc-span');

    const matched = receiver.testSink.spans.find((s) => s.name === 'test-grpc-span');
    expect(matched).toBeDefined();
    expect(matched?.attributes['test.key']).toBe('test-value-grpc');
  });
});
