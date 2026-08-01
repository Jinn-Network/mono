// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  advanceExtractionJob,
  createExtractionStateFile,
  dueExtractionJobs,
  extractionJobKey,
  parseExtractionStateFile,
  recordExtractionConverged,
  recordExtractionFailure,
  recordExtractionSpend,
  remainingBudget,
  serializeExtractionStateFile,
  upsertExtractionJobs,
} from "./extraction-state.js";
import { fakeExtractionRequest } from "./testing.js";

const T0 = "2026-07-31T09:00:00.000Z";
const T1 = "2026-07-31T09:05:00.000Z";
const KEY = extractionJobKey(fakeExtractionRequest());

describe("the extraction state file", () => {
  it("keys a job by the request identity, so a resume addresses the same job", () => {
    expect(extractionJobKey(fakeExtractionRequest())).toBe(KEY);
    expect(extractionJobKey({ ...fakeExtractionRequest(), anchorBlockNumber: 1 })).not.toBe(KEY);
  });

  it("is idempotent on upsert and resumable at its stage", () => {
    const created = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    const advanced = advanceExtractionJob(created, KEY, "harvest", T1);
    const again = upsertExtractionJobs(advanced, [KEY], T1);
    expect(again.jobs[KEY]?.stage).toBe("harvest");
    expect(again.jobs[KEY]?.createdAt).toBe(T0);
  });

  it("carries spend across a crash, so a resume cannot re-spend the budget", () => {
    let file = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    file = recordExtractionSpend(file, KEY, { calls: 900, bytes: 4_000, limits: { maxCalls: 1_000, maxBytes: 10_000 } }, T1);
    const round = parseExtractionStateFile(serializeExtractionStateFile(file));
    expect(remainingBudget(round.jobs[KEY]!, { maxCalls: 1_000, maxBytes: 10_000 }))
      .toEqual({ maxCalls: 100, maxBytes: 6_000 });
  });

  it("retries infrastructure failures behind a fence, up to the attempt cap", () => {
    let file = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    file = recordExtractionFailure(file, KEY, "runtime-failure", T0, 60_000);
    expect(file.jobs[KEY]?.disposition).toBe("retrying");
    expect(dueExtractionJobs(file, T0)).toEqual([]);
    expect(dueExtractionJobs(file, T1).map((job) => job.key)).toEqual([KEY]);
    file = recordExtractionFailure(file, KEY, "runtime-failure", T1, 60_000);
    file = recordExtractionFailure(file, KEY, "runtime-failure", T1, 60_000);
    expect(file.jobs[KEY]?.disposition).toBe("infrastructure");
    expect(dueExtractionJobs(file, "2026-08-01T00:00:00.000Z")).toEqual([]);
  });

  it("never retries a non-convergent, policy, archive, or disagreement failure", () => {
    let file = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    file = recordExtractionFailure(file, KEY, "widen-bound-exhausted", T0, 60_000);
    expect(file.jobs[KEY]?.disposition).toBe("non-convergent");
    expect(dueExtractionJobs(file, "2026-08-01T00:00:00.000Z")).toEqual([]);
  });

  it("fails loud on a corrupt file rather than resetting it", () => {
    expect(() => parseExtractionStateFile(new TextEncoder().encode("{"))).toThrow(/UTF-8 JSON/u);
  });
});
