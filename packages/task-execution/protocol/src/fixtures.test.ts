import { describe, expect, test } from "vitest";
import {
  loadEquivalenceExpectedDigest,
  loadEquivalenceTaskBytes,
  loadGoldenConformanceReport,
  loadGoldenDeliveryBytes,
  loadGoldenObservations,
  loadGoldenSubmissionBytes,
  loadGoldenTaskBytes,
  type GoldenScenario,
} from "./fixtures.js";
import { documentDigest } from "./hashing.js";
import { validateDelivery, validateObservation, validateSubmission, validateTask } from "./validators.js";

const SCENARIOS: readonly GoldenScenario[] = ["local", "marketplace"];

describe("golden fixture: task", () => {
  test("validates against the Task schema", async () => {
    const bytes = await loadGoldenTaskBytes();
    const document = JSON.parse(new TextDecoder().decode(bytes));
    expect(validateTask(document).conforms).toBe(true);
  });

  test("the conformance report's taskDigest matches the freshly-hashed bytes (producer-side)", async () => {
    const bytes = await loadGoldenTaskBytes();
    const report = await loadGoldenConformanceReport();
    expect(documentDigest(bytes)).toBe(report.taskDigest);
  });
});

describe.each(SCENARIOS)("golden fixture: %s scenario", (scenario) => {
  test("Submission validates and its digest matches the pinned report entry", async () => {
    const bytes = await loadGoldenSubmissionBytes(scenario);
    const document = JSON.parse(new TextDecoder().decode(bytes));
    expect(validateSubmission(document).conforms).toBe(true);

    const report = await loadGoldenConformanceReport();
    // consumer-side check: hash the exact stored bytes, never re-canonicalize (§6.1).
    expect(documentDigest(bytes)).toBe(report.scenarios[scenario].submissionDigest);
  });

  test("Delivery validates and its digest matches the pinned report entry", async () => {
    const bytes = await loadGoldenDeliveryBytes(scenario);
    const document = JSON.parse(new TextDecoder().decode(bytes));
    expect(validateDelivery(document).conforms).toBe(true);

    const report = await loadGoldenConformanceReport();
    expect(documentDigest(bytes)).toBe(report.scenarios[scenario].deliveryDigest);
  });

  test("the Delivery names the shared golden Task digest (cardinality: one Task per Attempt)", async () => {
    const bytes = await loadGoldenDeliveryBytes(scenario);
    const document = JSON.parse(new TextDecoder().decode(bytes)) as { task: string; attempt: string };
    const report = await loadGoldenConformanceReport();
    expect(document.task).toBe(report.taskDigest);
    expect(document.attempt).toBe(report.scenarios[scenario].attempt);
  });

  test("the observation log validates and ends in an authoritative attempt-terminal", async () => {
    const observations = await loadGoldenObservations(scenario);
    for (const observation of observations) {
      expect(validateObservation(observation).conforms).toBe(true);
    }
    const last = observations.at(-1) as { type: string };
    expect(last.type).toBe("network.jinn.task-execution.attempt-terminal.v1");
  });
});

describe("golden fixture: key-order-sensitive equivalence record", () => {
  test("two key-permuted Task documents seal to the identical pinned digest (consumer-side)", async () => {
    const [a, b, expected] = await Promise.all([
      loadEquivalenceTaskBytes("a"),
      loadEquivalenceTaskBytes("b"),
      loadEquivalenceExpectedDigest(),
    ]);
    // consumer-side: hash the exact stored bytes for each variant, never re-canonicalize.
    expect(documentDigest(a)).toBe(expected);
    expect(documentDigest(b)).toBe(expected);
  });
});
