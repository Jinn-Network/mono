import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { ConstructorTokenGate } from "./auth.js";
import { cachePolicyHeaders } from "./freshness.js";
import { healthResponse, readyResponse } from "./health.js";
import { buildOpenApiDocument } from "./openapi.js";
import { SchemaPayload } from "./payload.js";
import { parseLastEventId, sseResumePlan } from "./sse.js";
import { createReadPlaneFake } from "./testing.js";

describe("health/ready", () => {
  it("returns the shallow liveness body", () => {
    expect(healthResponse()).toEqual({ ok: true });
  });

  it("maps ready and degraded to 200 and bootstrapping to 503", () => {
    expect(readyResponse({ reason: "ready" })).toEqual({
      status: 200,
      body: { reason: "ready", accepting_work: true },
    });
    expect(readyResponse({ reason: "degraded", cause: "awaiting_funding" })).toEqual({
      status: 200,
      body: { reason: "degraded", cause: "awaiting_funding", accepting_work: false },
    });
    expect(readyResponse({ reason: "bootstrapping" }).status).toBe(503);
  });
});

describe("freshness", () => {
  it("emits Cache-Control, ETag, and Last-Modified from generatedAt", () => {
    const headers = cachePolicyHeaders({ generatedAt: "2026-08-16T00:00:00.000Z", maxAgeSeconds: 5 });
    expect(headers["Cache-Control"]).toBe("private, max-age=5, must-revalidate");
    expect(headers.ETag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(headers["Last-Modified"]).toContain("2026");
  });
});

describe("SSE resume", () => {
  it("parses Last-Event-ID and distinguishes unknown ids", () => {
    expect(parseLastEventId("12")).toBe(12);
    expect(parseLastEventId("nope")).toBeUndefined();
    expect(sseResumePlan(undefined, () => false)).toEqual({ action: "backfill" });
    expect(sseResumePlan(9, (id) => id === 9)).toEqual({ action: "backfill", afterId: 9 });
    expect(sseResumePlan(9, () => false)).toEqual({ action: "id-not-in-buffer" });
  });
});

describe("constructor token gate", () => {
  it("compares the constructed secret, not a per-call re-read", () => {
    const gate = new ConstructorTokenGate({ token: "abc", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(gate.accept("abc")).toBe(true);
    expect(gate.accept("abd")).toBe(false);
    expect(gate.accept(undefined)).toBe(false);
  });

  it("rejects an expired token", () => {
    const gate = new ConstructorTokenGate(
      { token: "abc", expiresAt: "2020-01-01T00:00:00.000Z" },
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(gate.accept("abc")).toBe(false);
  });
});

describe("payload class + OpenAPI", () => {
  it("round-trips a schema and emits OpenAPI 3.1", () => {
    const schema = z.object({ ok: z.literal(true) });
    const payload = new SchemaPayload(schema);
    expect(payload.json({ ok: true })).toEqual({ ok: true });
    const doc = buildOpenApiDocument({
      info: { title: "kit", version: "1.0" },
      routes: [{ path: "/health", method: "get", summary: "liveness", responseSchema: schema }],
    });
    expect(doc.openapi).toBe("3.1.0");
    expect((doc.paths as Record<string, unknown>)["/health"]).toBeDefined();
  });
});

describe("the in-tree fake", () => {
  it("proves the kit passable without an HTTP server", () => {
    const fake = createReadPlaneFake("secret");
    expect(fake.health()).toEqual({ ok: true });
    expect(fake.ready({ reason: "ready" }).status).toBe(200);
    expect(fake.authorize("secret")).toBe(true);
    expect(fake.authorize("nope")).toBe(false);
    expect(fake.resume("1").action).toBe("backfill");
    expect(fake.resume("99").action).toBe("id-not-in-buffer");
    expect(fake.freshness({ generatedAt: "2026-08-16T00:00:00.000Z" })["Cache-Control"]).toContain("max-age=");
  });
});
