import { createServer } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startReceiver, type Receiver } from '../../src/trajectory/receiver.js';
import { trace, SpanKind } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter as HttpExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as GrpcExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

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

  async function freeTcpPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to allocate tcp port');
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
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

  it('rejects gRPC port collisions loudly (does not silently remap)', async () => {
    // The receiver's runtime posture (spec §4.1, §4.2 path A) is to bind the
    // canonical OTel ports 4317 (gRPC) / 4318 (HTTP). If another collector is
    // already on those ports, startReceiver MUST throw rather than picking a
    // different port — exporters configured against the canonical address
    // would otherwise silently route into a void.
    const occupiedGrpcPort = receiver.grpcPort;

    let collidingReceiver: Receiver | null = null;
    let collisionError: Error | null = null;
    try {
      collidingReceiver = await startReceiver({
        grpcPort: occupiedGrpcPort,
        httpPort: 0,
      });
    } catch (e) {
      collisionError = e as Error;
    }

    expect(collidingReceiver).toBeNull();
    expect(collisionError).not.toBeNull();
    expect(collisionError!.message).toMatch(/EADDRINUSE|address already in use/i);
  });

  it('closes HTTP listener when gRPC bind fails during startup', async () => {
    const occupiedGrpcPort = receiver.grpcPort;
    const explicitHttpPort = await freeTcpPort();

    await expect(startReceiver({
      grpcPort: occupiedGrpcPort,
      httpPort: explicitHttpPort,
    })).rejects.toThrow(/EADDRINUSE|address already in use/i);

    const recovered = await startReceiver({
      grpcPort: 0,
      httpPort: explicitHttpPort,
    });
    await recovered.shutdown();
  });

  it('isolates per-processor exceptions in dispatch chain', async () => {
    // A misbehaving processor must not block subsequent processors. Wire up a
    // throwing processor before a downstream sink and confirm the downstream
    // still observes the span.
    await receiver.shutdown();

    const downstreamSink = { spans: [] as ReadableSpan[] };
    const throwing: SpanProcessor = {
      onStart() {},
      onEnd() {
        throw new Error('intentional');
      },
      forceFlush() {
        return Promise.resolve();
      },
      shutdown() {
        return Promise.resolve();
      },
    };
    const downstream: SpanProcessor = {
      onStart() {},
      onEnd(span) {
        downstreamSink.spans.push(span);
      },
      forceFlush() {
        return Promise.resolve();
      },
      shutdown() {
        return Promise.resolve();
      },
    };

    receiver = await startReceiver({
      grpcPort: 0,
      httpPort: 0,
      processors: [throwing, downstream],
    });

    const sdk = new NodeSDK({
      traceExporter: new HttpExporter({
        url: `http://localhost:${receiver.httpPort}/v1/traces`,
      }),
    });
    sdk.start();

    const tracer = trace.getTracer('test-isolation');
    const span = tracer.startSpan('test-isolation-span', { kind: SpanKind.INTERNAL });
    span.end();

    await sdk.shutdown();
    await waitForSpan('test-isolation-span');

    expect(downstreamSink.spans.some((s) => s.name === 'test-isolation-span')).toBe(true);
  });
});
