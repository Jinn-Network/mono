// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { EnvironmentVerificationError } from "./errors.js";
import {
  MAX_INFRASTRUCTURE_ATTEMPTS,
  advanceStagedJob,
  createStagedStateFile,
  dueStagedJobs,
  parseStagedStateFile,
  recordStagedAttested,
  recordStagedFailure,
  serializeStagedStateFile,
  upsertStagedJobs,
} from "./staged-state.js";

const DIGEST_A = `sha256:${"1".repeat(64)}` as const;
const DIGEST_B = `sha256:${"2".repeat(64)}` as const;
const T0 = "2026-07-31T09:00:00.000Z";
const T1 = "2026-07-31T09:05:00.000Z";

describe("staged state algebra", () => {
  it("upserts idempotently and leaves the input untouched", () => {
    const empty = createStagedStateFile(T0);
    const once = upsertStagedJobs(empty, [DIGEST_A, DIGEST_B], T0);
    const twice = upsertStagedJobs(once, [DIGEST_A], T1);
    expect(Object.keys(once.jobs)).toHaveLength(2);
    expect(Object.keys(twice.jobs)).toHaveLength(2);
    expect(twice.jobs[DIGEST_A]!.createdAt).toBe(T0);
    expect(Object.keys(empty.jobs)).toHaveLength(0);
  });

  it("advances stages and records an attestation as terminal", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    file = advanceStagedJob(file, DIGEST_A, "running", T1);
    expect(file.jobs[DIGEST_A]!.stage).toBe("running");
    file = recordStagedAttested(file, DIGEST_A, DIGEST_B, T1);
    expect(file.jobs[DIGEST_A]!.stage).toBe("complete");
    expect(file.jobs[DIGEST_A]!.disposition).toBe("attested");
    expect(file.jobs[DIGEST_A]!.attestationDigest).toBe(DIGEST_B);
    expect(dueStagedJobs(file, T1)).toHaveLength(0);
  });

  it("retries infrastructure failures up to the cap, then parks them", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    for (let attempt = 1; attempt < MAX_INFRASTRUCTURE_ATTEMPTS; attempt += 1) {
      file = recordStagedFailure(file, DIGEST_A, "image-unresolvable", T0, 60_000);
      expect(file.jobs[DIGEST_A]!.disposition).toBe("retrying");
    }
    file = recordStagedFailure(file, DIGEST_A, "image-unresolvable", T0, 60_000);
    expect(file.jobs[DIGEST_A]!.disposition).toBe("failed_infrastructure");
    expect(file.jobs[DIGEST_A]!.nextAttemptAt).toBeUndefined();
  });

  it("parks divergence as quarantined and a wrong digest as terminal policy at once", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A, DIGEST_B], T0);
    file = recordStagedFailure(file, DIGEST_A, "outcome-set-divergence", T0, 60_000);
    file = recordStagedFailure(file, DIGEST_B, "image-digest-mismatch", T0, 60_000);
    expect(file.jobs[DIGEST_A]!.disposition).toBe("quarantined");
    expect(file.jobs[DIGEST_B]!.disposition).toBe("terminal_policy");
    expect(dueStagedJobs(file, T1)).toHaveLength(0);
  });

  it("orders due jobs by creation time then key, and honors the retry fence", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_B, DIGEST_A], T0);
    expect(dueStagedJobs(file, T0).map((job) => job.key)).toEqual([DIGEST_A, DIGEST_B]);
    file = recordStagedFailure(file, DIGEST_A, "run-command-failed", T0, 600_000);
    expect(dueStagedJobs(file, T1).map((job) => job.key)).toEqual([DIGEST_B]);
    expect(dueStagedJobs(file, "2026-07-31T09:20:00.000Z").map((job) => job.key))
      .toEqual([DIGEST_A, DIGEST_B]);
  });

  it("round-trips through canonical bytes and refuses a corrupt file", () => {
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    expect(parseStagedStateFile(serializeStagedStateFile(file))).toEqual(file);
    expect(() => parseStagedStateFile(new TextEncoder().encode('{"jobs":')))
      .toThrow(EnvironmentVerificationError);
    expect(() => parseStagedStateFile(new TextEncoder().encode('{"schemaVersion":"nope"}')))
      .toThrow(EnvironmentVerificationError);
  });
});
