import { describe, expect, test } from "vitest";

import type { RetrievalTelemetryEvent } from "./contracts.js";
import { facadeFixture } from "./test-support.js";

describe("retrieval telemetry", () => {
  test("telemetry contains counts and classifications but no content", async () => {
    const events: RetrievalTelemetryEvent[] = [];
    const privateQuery = "customer-secret-task";
    const maliciousSnippet = "<script>steal()</script>";
    const fixture = await facadeFixture({
      providerData: { snippet: maliciousSnippet },
      telemetry: { emit: (event) => { events.push(event); } },
    });
    await fixture.retrieval.query({
      candidateSource: fixture.source,
      sourceQuery: { text: privateQuery },
      resultLimit: 1,
      candidateBudget: 1,
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(privateQuery);
    expect(serialized).not.toContain(maliciousSnippet);
    expect(serialized).not.toContain("Golden synthetic Execution Evidence");
    expect(events).toContainEqual(expect.objectContaining({
      operation: "query",
      stage: "completed",
      candidateCount: 1,
      resultCount: 1,
    }));
  });

  test("a failing telemetry sink never changes retrieval semantics", async () => {
    const fixture = await facadeFixture({
      telemetry: { emit: () => { throw new Error("sink unavailable"); } },
    });
    await expect(fixture.retrieval.retrieve({ reference: fixture.reference }))
      .resolves.toMatchObject({ status: "validated" });
  });

  test("telemetry is emitted for known-reference retrieval too", async () => {
    const events: RetrievalTelemetryEvent[] = [];
    const fixture = await facadeFixture({
      telemetry: { emit: (event) => { events.push(event); } },
    });
    await fixture.retrieval.retrieve({ reference: fixture.reference });
    expect(events.some(({ operation }) => operation === "retrieve")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      operation: "retrieve",
      stage: "completed",
    }));
  });

  test("without a configured sink, no telemetry work happens and semantics are unchanged", async () => {
    const fixture = await facadeFixture();
    await expect(fixture.retrieval.retrieve({ reference: fixture.reference }))
      .resolves.toMatchObject({ status: "validated" });
  });
});
