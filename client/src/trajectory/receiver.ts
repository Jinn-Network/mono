/**
 * Embedded OTLP receiver — accepts OpenTelemetry traces over OTLP/HTTP
 * (`POST /v1/traces`, default JSON encoding from `@opentelemetry/exporter-trace-otlp-http`)
 * and OTLP/gRPC (`/opentelemetry.proto.collector.trace.v1.TraceService/Export`).
 *
 * Decoded spans are converted to `ReadableSpan`-shaped objects and pushed
 * through the configured `SpanProcessor` chain (`onEnd` only — receivers
 * don't observe `onStart`).
 *
 * In production the receiver listens on standard OTel ports (4317 / 4318);
 * in tests pass `grpcPort: 0` / `httpPort: 0` for ephemeral binds.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.1, §4.3.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { SpanKind, SpanStatusCode, type HrTime, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Resource } from '@opentelemetry/resources';
import type { InstrumentationScope } from '@opentelemetry/core';
import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import { resourceFromAttributes } from '@opentelemetry/resources';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReceiverOptions {
  /** TCP port for OTLP/gRPC. `0` = ephemeral (use the resolved value from `Receiver.grpcPort`). */
  grpcPort: number;
  /** TCP port for OTLP/HTTP. `0` = ephemeral. */
  httpPort: number;
  /**
   * Optional processor chain. Each processor's `onEnd(span)` receives every
   * decoded span, in receive order. If omitted, only the test sink is used.
   */
  processors?: SpanProcessor[];
}

export interface TestSink {
  spans: ReadableSpan[];
}

export interface Receiver {
  grpcPort: number;
  httpPort: number;
  /** Always-on test capture of every span the receiver decoded. */
  testSink: TestSink;
  shutdown(): Promise<void>;
}

/** Built-in always-on processor that buffers every span in memory for tests/inspection. */
class TestSinkProcessor implements SpanProcessor, TestSink {
  spans: ReadableSpan[] = [];
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  onStart(): void {
    /* receivers never see onStart */
  }
  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Protobuf schema (ExportTraceServiceRequest)
// ---------------------------------------------------------------------------

// Hand-curated subset of the OTLP trace protocol — sufficient to deserialize
// any conformant `ExportTraceServiceRequest`. The OTel JS SDK does not ship
// these protos as public artifacts (the runtime client uses identity Buffer
// passthrough), so we redeclare the schema here. Kept tight: only fields
// that round-trip into `ReadableSpan` are listed.
const OTLP_TRACE_PROTO = `
syntax = "proto3";
package opentelemetry.proto.collector.trace.v1;

message ExportTraceServiceRequest {
  repeated ResourceSpans resource_spans = 1;
}

message ExportTraceServiceResponse {
  ExportTracePartialSuccess partial_success = 1;
}

message ExportTracePartialSuccess {
  int64 rejected_spans = 1;
  string error_message = 2;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message Resource {
  repeated KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}

message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
  fixed32 flags = 16;

  enum SpanKind {
    SPAN_KIND_UNSPECIFIED = 0;
    SPAN_KIND_INTERNAL = 1;
    SPAN_KIND_SERVER = 2;
    SPAN_KIND_CLIENT = 3;
    SPAN_KIND_PRODUCER = 4;
    SPAN_KIND_CONSUMER = 5;
  }

  message Event {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }

  message Link {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    repeated KeyValue attributes = 4;
    uint32 dropped_attributes_count = 5;
    fixed32 flags = 6;
  }
}

message Status {
  string message = 2;
  StatusCode code = 3;

  enum StatusCode {
    STATUS_CODE_UNSET = 0;
    STATUS_CODE_OK = 1;
    STATUS_CODE_ERROR = 2;
  }
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}
`;

const PROTO_ROOT = protobuf.parse(OTLP_TRACE_PROTO, { keepCase: false }).root;
const ExportTraceServiceRequestType = PROTO_ROOT.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
);
const ExportTraceServiceResponseType = PROTO_ROOT.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse',
);

// gRPC service path used by `@opentelemetry/exporter-trace-otlp-grpc`.
const GRPC_SERVICE_PATH = '/opentelemetry.proto.collector.trace.v1.TraceService/Export';

// ---------------------------------------------------------------------------
// startReceiver
// ---------------------------------------------------------------------------

export async function startReceiver(opts: ReceiverOptions): Promise<Receiver> {
  const testSink = new TestSinkProcessor();
  const processors: SpanProcessor[] = [testSink, ...(opts.processors ?? [])];

  const dispatch = (spans: ReadableSpan[]) => {
    for (const span of spans) {
      for (const proc of processors) {
        try {
          proc.onEnd(span);
        } catch {
          // A misbehaving processor must not block downstream processors or
          // poison the receive path. Swallow and continue.
        }
      }
    }
  };

  const httpServer = await startHttpServer(opts.httpPort, dispatch);
  let grpcServer: ServerHandle;
  try {
    grpcServer = await startGrpcServer(opts.grpcPort, dispatch);
  } catch (err) {
    await httpServer.close().catch(() => undefined);
    throw err;
  }

  return {
    grpcPort: grpcServer.port,
    httpPort: httpServer.port,
    testSink,
    async shutdown() {
      await Promise.all([httpServer.close(), grpcServer.close()]);
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server (OTLP/HTTP, JSON encoding by default)
// ---------------------------------------------------------------------------

interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

async function startHttpServer(
  port: number,
  dispatch: (spans: ReadableSpan[]) => void,
): Promise<ServerHandle> {
  const server: HttpServer = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/traces') {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const contentType = (req.headers['content-type'] ?? '').toLowerCase();

        let spans: ReadableSpan[];
        if (contentType.includes('application/x-protobuf')) {
          const decoded = ExportTraceServiceRequestType.decode(body);
          const obj = ExportTraceServiceRequestType.toObject(decoded, {
            longs: String,
            bytes: Buffer,
            defaults: false,
          });
          spans = decodedRequestToSpans(obj);
        } else {
          // Default to JSON (the default for @opentelemetry/exporter-trace-otlp-http).
          const json = JSON.parse(body.toString('utf8'));
          spans = decodedRequestToSpans(json);
        }

        dispatch(spans);

        res.writeHead(200, { 'Content-Type': contentType.includes('application/x-protobuf') ? 'application/x-protobuf' : 'application/json' });
        if (contentType.includes('application/x-protobuf')) {
          const empty = ExportTraceServiceResponseType.encode(
            ExportTraceServiceResponseType.create({}),
          ).finish();
          res.end(Buffer.from(empty));
        } else {
          res.end('{}');
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    req.on('error', () => {
      res.writeHead(400).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(done, 2_000);
        timer.unref?.();
        // `server.close()` stops accepting new connections but lets keep-alive
        // sockets idle on. Without `closeIdleConnections()` shutdown can hang
        // for the full keep-alive timeout. Available since Node 18.2.
        try {
          server.closeIdleConnections();
          server.closeAllConnections();
          server.close(() => {
            clearTimeout(timer);
            done();
          });
        } catch {
          clearTimeout(timer);
          done();
        }
      }),
  };
}

// ---------------------------------------------------------------------------
// gRPC server
// ---------------------------------------------------------------------------

async function startGrpcServer(
  port: number,
  dispatch: (spans: ReadableSpan[]) => void,
): Promise<ServerHandle> {
  const server = new grpc.Server();

  // Register the TraceService.Export method with identity (Buffer pass-through)
  // serializers — same trick the OTel exporter uses on the client side. We
  // decode the protobuf body manually inside the handler.
  const serviceDefinition: grpc.ServiceDefinition = {
    Export: {
      path: GRPC_SERVICE_PATH,
      requestStream: false,
      responseStream: false,
      requestSerialize: (arg: Buffer): Buffer => arg,
      requestDeserialize: (arg: Buffer): Buffer => arg,
      responseSerialize: (arg: Buffer): Buffer => arg,
      responseDeserialize: (arg: Buffer): Buffer => arg,
    },
  };

  const handler = (
    call: grpc.ServerUnaryCall<Buffer, Buffer>,
    callback: grpc.sendUnaryData<Buffer>,
  ) => {
    try {
      const decoded = ExportTraceServiceRequestType.decode(call.request);
      const obj = ExportTraceServiceRequestType.toObject(decoded, {
        longs: String,
        bytes: Buffer,
        defaults: false,
      });
      const spans = decodedRequestToSpans(obj);
      dispatch(spans);

      const responseBytes = ExportTraceServiceResponseType.encode(
        ExportTraceServiceResponseType.create({}),
      ).finish();
      callback(null, Buffer.from(responseBytes));
    } catch (err) {
      callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: (err as Error).message,
      });
    }
  };

  server.addService(serviceDefinition, { Export: handler });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      `127.0.0.1:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, p) => {
        if (err) return reject(err);
        resolve(p);
      },
    );
  });

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(() => {
          server.forceShutdown();
          done();
        }, 2_000);
        timer.unref?.();
        server.tryShutdown((err) => {
          clearTimeout(timer);
          if (err) {
            // forceShutdown returns void
            server.forceShutdown();
          }
          done();
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// OTLP ExportTraceServiceRequest → ReadableSpan[]
// ---------------------------------------------------------------------------

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: Buffer | string;
}

interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}

interface OtlpEvent {
  timeUnixNano?: string | number;
  name?: string;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
}

interface OtlpLink {
  traceId?: string | Buffer;
  spanId?: string | Buffer;
  traceState?: string;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
  flags?: number;
}

interface OtlpSpan {
  traceId?: string | Buffer;
  spanId?: string | Buffer;
  traceState?: string;
  parentSpanId?: string | Buffer;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
  events?: OtlpEvent[];
  droppedEventsCount?: number;
  links?: OtlpLink[];
  droppedLinksCount?: number;
  status?: { code?: number | string; message?: string };
  flags?: number;
}

interface OtlpScopeSpans {
  scope?: { name?: string; version?: string; attributes?: OtlpKeyValue[] };
  spans?: OtlpSpan[];
  schemaUrl?: string;
}

interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[]; droppedAttributesCount?: number };
  scopeSpans?: OtlpScopeSpans[];
  schemaUrl?: string;
}

interface OtlpExportRequest {
  resourceSpans?: OtlpResourceSpans[];
}

function decodedRequestToSpans(req: OtlpExportRequest): ReadableSpan[] {
  const out: ReadableSpan[] = [];
  for (const rs of req.resourceSpans ?? []) {
    const resource = makeResource(rs.resource?.attributes ?? [], rs.schemaUrl);
    for (const ss of rs.scopeSpans ?? []) {
      const scope: InstrumentationScope = {
        name: ss.scope?.name ?? '',
        version: ss.scope?.version,
        schemaUrl: ss.schemaUrl,
      };
      for (const sp of ss.spans ?? []) {
        out.push(otlpSpanToReadableSpan(sp, resource, scope));
      }
    }
  }
  return out;
}

function otlpSpanToReadableSpan(
  sp: OtlpSpan,
  resource: Resource,
  scope: InstrumentationScope,
): ReadableSpan {
  const traceId = idHexFromAny(sp.traceId, 32);
  const spanId = idHexFromAny(sp.spanId, 16);
  // OTel spec: an all-zero span_id is reserved as the "invalid" sentinel.
  // Protobuf-decoded `parent_span_id` defaults to an 8-byte zero-filled Buffer
  // (not absent); treat that as "no parent" rather than emitting '0000…'.
  const parentHexRaw = sp.parentSpanId ? idHexFromAny(sp.parentSpanId, 16) : undefined;
  const parentHex = parentHexRaw && !/^0+$/.test(parentHexRaw) ? parentHexRaw : undefined;
  const startTime = nanosToHrTime(sp.startTimeUnixNano);
  const endTime = nanosToHrTime(sp.endTimeUnixNano);
  const duration = subtractHrTime(endTime, startTime);

  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: (sp.flags ?? 0) & 0xff,
    isRemote: false,
    traceState: undefined,
  };

  // OTLP encodes SpanKind as enum value with INTERNAL=1; OTel API SpanKind has INTERNAL=0.
  const otlpKind = typeof sp.kind === 'string' ? otlpKindFromName(sp.kind) : (sp.kind ?? 0);
  const apiKind = otlpKindToApiKind(otlpKind);

  const statusCode = decodeStatusCode(sp.status?.code);

  const span: ReadableSpan = {
    name: sp.name ?? '',
    kind: apiKind,
    spanContext: () => spanContext,
    parentSpanContext: parentHex
      ? {
          traceId,
          spanId: parentHex,
          traceFlags: spanContext.traceFlags,
          // See link `isRemote` comment below — must check 0x100 (HAS_IS_REMOTE)
          // guard bit before reading 0x200 (IS_REMOTE) value.
          isRemote: ((sp.flags ?? 0) & 0x100) !== 0 ? ((sp.flags ?? 0) & 0x200) !== 0 : false,
        }
      : undefined,
    startTime,
    endTime,
    status: {
      code: statusCode,
      message: sp.status?.message,
    },
    attributes: kvListToAttributes(sp.attributes ?? []),
    links: (sp.links ?? []).map((l) => ({
      context: {
        traceId: idHexFromAny(l.traceId, 32),
        spanId: idHexFromAny(l.spanId, 16),
        traceFlags: (l.flags ?? 0) & 0xff,
        // OTLP `flags` carries two related bits for parent/link `isRemote`:
        //   0x100 (HAS_IS_REMOTE) — set when the sender knows isRemote
        //   0x200 (IS_REMOTE)     — the value, only meaningful if 0x100 is set
        // If HAS_IS_REMOTE is unset the value is unknown; default to false.
        isRemote: ((l.flags ?? 0) & 0x100) !== 0 ? ((l.flags ?? 0) & 0x200) !== 0 : false,
      },
      attributes: kvListToAttributes(l.attributes ?? []),
      droppedAttributesCount: l.droppedAttributesCount ?? 0,
    })),
    events: (sp.events ?? []).map((e) => ({
      name: e.name ?? '',
      time: nanosToHrTime(e.timeUnixNano),
      attributes: kvListToAttributes(e.attributes ?? []),
      droppedAttributesCount: e.droppedAttributesCount ?? 0,
    })),
    duration,
    ended: true,
    resource,
    instrumentationScope: scope,
    droppedAttributesCount: sp.droppedAttributesCount ?? 0,
    droppedEventsCount: sp.droppedEventsCount ?? 0,
    droppedLinksCount: sp.droppedLinksCount ?? 0,
  };
  return span;
}

function makeResource(attrs: OtlpKeyValue[], schemaUrl?: string): Resource {
  return resourceFromAttributes(kvListToAttributes(attrs), { schemaUrl });
}

function kvListToAttributes(kvs: OtlpKeyValue[]): Record<string, string | number | boolean | string[] | number[] | boolean[] | undefined> {
  const out: Record<string, string | number | boolean | string[] | number[] | boolean[] | undefined> = {};
  for (const kv of kvs) {
    if (!kv.key) continue;
    const v = anyValueToPrimitive(kv.value);
    if (v !== undefined) out[kv.key] = v;
  }
  return out;
}

function anyValueToPrimitive(v: OtlpAnyValue | undefined): string | number | boolean | string[] | number[] | boolean[] | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) {
    const n = typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue;
    return Number.isFinite(n) ? n : undefined;
  }
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.bytesValue !== undefined) {
    return typeof v.bytesValue === 'string' ? v.bytesValue : v.bytesValue.toString('base64');
  }
  if (v.arrayValue?.values) {
    const arr = v.arrayValue.values
      .map((inner) => anyValueToPrimitive(inner))
      .filter((x) => x !== undefined) as Array<string | number | boolean | string[] | number[] | boolean[]>;
    // OTel `AttributeValue` arrays must be homogeneous primitives.
    if (arr.every((x) => typeof x === 'string')) return arr as string[];
    if (arr.every((x) => typeof x === 'number')) return arr as number[];
    if (arr.every((x) => typeof x === 'boolean')) return arr as boolean[];
    return arr.map(String) as string[];
  }
  // kvlistValue not representable as a flat AttributeValue; drop.
  return undefined;
}

/**
 * Convert raw protobuf-decoded bytes (Buffer/Uint8Array) to a lowercase hex
 * string. Used for the gRPC + HTTP-protobuf paths where the wire encoding is
 * always raw bytes. JSON-string OTLP IDs are NOT routed through here — they
 * use {@link idHexFromString} which handles base64 decoding correctly.
 */
function bytesToHex(input: Buffer | Uint8Array | undefined): string {
  if (!input) return '';
  return Buffer.from(input).toString('hex');
}

/**
 * Convert a JSON-encoded OTLP id (`trace_id` / `span_id` / `parent_span_id`)
 * into a lowercase hex string of the expected length.
 *
 * Per OTLP JSON spec §4.3.3 these fields are base64-encoded. However, some
 * older Node-SDK encoders emit hex passthroughs, and a non-trivial number of
 * exporters in the wild still do this. The heuristic in the previous
 * implementation (`/^[0-9a-fA-F]+$/.test(input)`) silently corrupted IDs from
 * other-language SDKs (Go/Java/Python) when the base64 string happened to
 * contain only hex characters — e.g. `'deadbeefcafebabe0102030405060708'`
 * decodes one way as base64, another as hex.
 *
 * We disambiguate by demanding an *exact* length+charset match for the hex
 * fast-path: a 16-byte trace_id is exactly 32 hex chars, a 8-byte span_id is
 * exactly 16. Anything else is base64-decoded. If the resulting hex doesn't
 * match the expected length, the input is malformed; return '' so the caller
 * treats it as missing.
 */
function idHexFromString(input: string, expectedHexChars: 16 | 32): string {
  if (input.length === expectedHexChars && /^[0-9a-fA-F]+$/.test(input)) {
    return input.toLowerCase();
  }
  const hex = Buffer.from(input, 'base64').toString('hex');
  return hex.length === expectedHexChars ? hex : '';
}

/**
 * Bridge helper used by the OTLP-decoder call sites that may receive either
 * a Buffer (protobuf) or a string (JSON). Routes to the right helper so the
 * base64-vs-hex disambiguation only fires when the source is JSON.
 */
function idHexFromAny(
  input: string | Buffer | Uint8Array | undefined,
  expectedHexChars: 16 | 32,
): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return idHexFromString(input, expectedHexChars);
  return bytesToHex(input);
}

function nanosToHrTime(nanos: string | number | undefined): HrTime {
  if (nanos === undefined) return [0, 0];
  const big = typeof nanos === 'string' ? BigInt(nanos) : BigInt(Math.trunc(nanos));
  const seconds = Number(big / 1_000_000_000n);
  const remNanos = Number(big % 1_000_000_000n);
  return [seconds, remNanos];
}

function subtractHrTime(end: HrTime, start: HrTime): HrTime {
  let seconds = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    seconds -= 1;
    nanos += 1_000_000_000;
  }
  return [seconds, nanos];
}

function otlpKindFromName(name: string): number {
  switch (name) {
    case 'SPAN_KIND_INTERNAL':
      return 1;
    case 'SPAN_KIND_SERVER':
      return 2;
    case 'SPAN_KIND_CLIENT':
      return 3;
    case 'SPAN_KIND_PRODUCER':
      return 4;
    case 'SPAN_KIND_CONSUMER':
      return 5;
    default:
      return 0;
  }
}

function otlpKindToApiKind(otlp: number): SpanKind {
  // OTLP enum: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER.
  // OTel API enum: INTERNAL=0, SERVER=1, CLIENT=2, PRODUCER=3, CONSUMER=4 (no UNSPECIFIED).
  switch (otlp) {
    case 2:
      return SpanKind.SERVER;
    case 3:
      return SpanKind.CLIENT;
    case 4:
      return SpanKind.PRODUCER;
    case 5:
      return SpanKind.CONSUMER;
    case 1:
    case 0:
    default:
      return SpanKind.INTERNAL;
  }
}

function decodeStatusCode(code: number | string | undefined): SpanStatusCode {
  if (typeof code === 'string') {
    if (code === 'STATUS_CODE_OK') return SpanStatusCode.OK;
    if (code === 'STATUS_CODE_ERROR') return SpanStatusCode.ERROR;
    return SpanStatusCode.UNSET;
  }
  switch (code) {
    case 1:
      return SpanStatusCode.OK;
    case 2:
      return SpanStatusCode.ERROR;
    default:
      return SpanStatusCode.UNSET;
  }
}
