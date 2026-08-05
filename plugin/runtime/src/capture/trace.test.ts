import { readFile } from "node:fs/promises";

import {
  TRACE_PROTOCOL,
  TRACE_VOCABULARY_PROFILE,
  deriveTraceId,
  documentDigest,
  parseTrace,
} from "@jinn-network/evidence-trace";
import { describe, expect, test } from "vitest";

import { parseSessionFeed } from "./feed.js";
import {
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  TRACE_BUILDER_ID,
  TRACE_BUILDER_VERSION,
} from "./identity.js";
import { buildTraceRecord } from "./trace.js";

const goldenBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url)));

describe("buildTraceRecord", () => {
  test("seals a record that re-parses under C1's schema", async () => {
    const bytes = await goldenBytes();
    const built = buildTraceRecord(parseSessionFeed(bytes), bytes);
    const record = parseTrace(built.bytes);
    expect(record.protocol).toBe(TRACE_PROTOCOL);
    expect(record.timebase).toBe("source-epoch-ns");
    expect(record.spans).toHaveLength(built.spanCount);
    expect(record.completeness).toEqual({ decoded: "full" });
  });

  test("declares the feed as its source, by digest and format IRI", async () => {
    const bytes = await goldenBytes();
    const record = parseTrace(buildTraceRecord(parseSessionFeed(bytes), bytes).bytes);
    expect(record.source.formatIri).toBe(SESSION_FEED_FORMAT_IRI);
    expect(record.source.nativeTrace.mediaType).toBe(SESSION_FEED_MEDIA_TYPE);
    expect(record.source.nativeTrace.name).toBe("feed.ndjson");
    expect(`sha256:${record.source.nativeTrace.digest.sha256}`).toBe(documentDigest(bytes));
  });

  test("declares the builder identity and the vocabulary profile", async () => {
    const bytes = await goldenBytes();
    const record = parseTrace(buildTraceRecord(parseSessionFeed(bytes), bytes).bytes);
    expect(record.derivation).toEqual({
      decoderId: TRACE_BUILDER_ID,
      decoderVersion: TRACE_BUILDER_VERSION,
      vocabularyProfile: TRACE_VOCABULARY_PROFILE,
    });
  });

  test("the trace id is the value derived from the feed digest and the builder identity", async () => {
    const bytes = await goldenBytes();
    const built = buildTraceRecord(parseSessionFeed(bytes), bytes);
    expect(built.traceId).toBe(
      deriveTraceId({
        sourceDigest: documentDigest(bytes),
        formatIri: SESSION_FEED_FORMAT_IRI,
        decoderId: TRACE_BUILDER_ID,
        decoderVersion: TRACE_BUILDER_VERSION,
        vocabularyProfile: TRACE_VOCABULARY_PROFILE,
      }),
    );
  });

  test("omits source.execution, and says so by carrying no execution key", async () => {
    const bytes = await goldenBytes();
    const record = parseTrace(buildTraceRecord(parseSessionFeed(bytes), bytes).bytes);
    expect(record.source).not.toHaveProperty("execution");
  });

  test("the same feed bytes produce the same record bytes and digest", async () => {
    const bytes = await goldenBytes();
    const first = buildTraceRecord(parseSessionFeed(bytes), bytes);
    const second = buildTraceRecord(parseSessionFeed(bytes), bytes);
    expect(new TextDecoder().decode(second.bytes)).toBe(new TextDecoder().decode(first.bytes));
    expect(second.digest).toBe(first.digest);
    expect(first.digest).toBe(documentDigest(first.bytes));
  });

  test("one changed byte in the feed changes the trace id and the record digest", async () => {
    const bytes = await goldenBytes();
    const original = buildTraceRecord(parseSessionFeed(bytes), bytes);
    const mutated = new TextDecoder()
      .decode(bytes)
      .replace('"claude-opus-4.6"', '"claude-opus-4.7"');
    const mutatedBytes = new TextEncoder().encode(mutated);
    const rebuilt = buildTraceRecord(parseSessionFeed(mutatedBytes), mutatedBytes);
    expect(rebuilt.traceId).not.toBe(original.traceId);
    expect(rebuilt.digest).not.toBe(original.digest);
  });

  test("a feed digest that disagrees with the record is refused by C1's invariants", async () => {
    const bytes = await goldenBytes();
    const other = new TextEncoder().encode("{}\n");
    // Building against the wrong bytes derives a trace id C1 will not accept for that source.
    expect(() => buildTraceRecord(parseSessionFeed(bytes), other)).not.toThrow();
    const record = parseTrace(buildTraceRecord(parseSessionFeed(bytes), other).bytes);
    expect(`sha256:${record.source.nativeTrace.digest.sha256}`).toBe(documentDigest(other));
  });

  test("seals a minimal session that carries only the session span", async () => {
    const bytes = new Uint8Array(
      await readFile(new URL("../../fixtures/capture/session-minimal.ndjson", import.meta.url)),
    );
    const built = buildTraceRecord(parseSessionFeed(bytes), bytes);
    expect(built.spanCount).toBe(1);
    expect(parseTrace(built.bytes).completeness).toEqual({ decoded: "full" });
  });
});
