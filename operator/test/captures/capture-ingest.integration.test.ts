import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter as HttpExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, SpanKind } from '@opentelemetry/api';
import { Store } from '../../src/store/store.js';
import { CapturesStore } from '../../src/store/captures.js';
import { startReceiver, type Receiver } from '../../src/trajectory/receiver.js';
import { SqliteExporterProcessor } from '../../src/trajectory/processors/sqlite-exporter.js';
import { ingestStopHookCapture } from '../../src/captures/ingest.js';

const CLAUDE_TRANSCRIPT = fileURLToPath(new URL(
  '../../fixtures/transcripts/claude-code/example-session.jsonl',
  import.meta.url,
));

// End-to-end-ish proof of the capture ingest path: a real OTLP exporter posts a
// span to the in-process receiver (the same startReceiver + SqliteExporterProcessor
// wiring main.ts uses on the public port) and the span lands in capture_spans.
//
// This test wires ONLY the SqliteExporterProcessor. In production main.ts also
// runs hand-rolled ingest scrub processors (credential/identity/path/transcript),
// but those have gaps — e.g. a GitHub PAT survives them (caught only by the
// maintained secretlint stage). The authoritative seller-side scrub is therefore
// applied in-process at publish time (proven by publish-scrub.test.ts), which is
// the architecture: best-effort scrub at ingest, maintained scrub gate at publish.
const GH = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';

describe('capture ingest via the in-process OTLP receiver', () => {
  let store: Store;
  let captures: CapturesStore;
  let receiver: Receiver;
  let sdk: NodeSDK;

  beforeEach(async () => {
    store = new Store(':memory:');
    captures = new CapturesStore(store);
    captures.savePending({
      sessionId: 'sess-int',
      capturedAt: new Date().toISOString(),
      originatingTool: { name: 'claude-code', version: '1.0.0' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 0,
      durationMs: 0,
      redactedSpanCount: 0,
    });
    receiver = await startReceiver({
      grpcPort: 0,
      httpPort: 0,
      processors: [new SqliteExporterProcessor({ captures })],
    });
    sdk = new NodeSDK({
      traceExporter: new HttpExporter({ url: `http://127.0.0.1:${receiver.httpPort}/v1/traces` }),
    });
    sdk.start();
  });

  afterEach(async () => {
    await sdk.shutdown().catch(() => undefined);
    await receiver.shutdown().catch(() => undefined);
    store.close();
  });

  it('ingests a real OTLP span into capture_spans (raw; scrubbed later at publish)', async () => {
    const tracer = trace.getTracer('capture-ingest-test');
    const span = tracer.startSpan('tool-call', { kind: SpanKind.INTERNAL });
    span.setAttribute('jinn.session.id', 'sess-int');
    span.setAttribute('jinn.span.kind', 'tool');
    span.setAttribute('tool.output', `leaked ${GH}`);
    span.end();

    await sdk.shutdown(); // force-flushes the batch exporter and awaits export

    let stored = captures.getSpansBySession('sess-int');
    for (let i = 0; i < 60 && stored.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      stored = captures.getSpansBySession('sess-int');
    }

    expect(stored.length).toBeGreaterThanOrEqual(1);
    // Ingested raw — the receiver does not scrub; publish does.
    expect(JSON.stringify(stored)).toContain(GH);
  });

  it('keeps stop-hook ingestion in SQLite without recreating the retired distiller tee', async () => {
    const legacyCapturesDir = mkdtempSync(join(tmpdir(), 'jinn-retired-distil-tee-'));
    const originalCapturesDir = process.env['JINN_LAYER_CAPTURES_DIR'];
    process.env['JINN_LAYER_CAPTURES_DIR'] = legacyCapturesDir;
    try {
      await ingestStopHookCapture(captures, receiver, {
        tool: 'claude-code',
        sessionId: 'stop-hook-no-tee',
        stoppedAt: '2026-05-07T00:00:00.000Z',
        transcriptPath: CLAUDE_TRANSCRIPT,
      });

      expect(captures.getBySession('stop-hook-no-tee')).toMatchObject({
        capturePath: 'D',
        status: 'pending',
      });
      expect(captures.getSpansBySession('stop-hook-no-tee').length).toBeGreaterThan(0);
      expect(readdirSync(legacyCapturesDir)).toEqual([]);
    } finally {
      if (originalCapturesDir === undefined) delete process.env['JINN_LAYER_CAPTURES_DIR'];
      else process.env['JINN_LAYER_CAPTURES_DIR'] = originalCapturesDir;
      rmSync(legacyCapturesDir, { recursive: true, force: true });
    }
  });
});
