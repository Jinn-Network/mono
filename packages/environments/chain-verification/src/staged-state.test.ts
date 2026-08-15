// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { outcomeForFailureReason } from "./outcomes.js";
import {
  MAX_INFRASTRUCTURE_ATTEMPTS,
  STAGED_STAGES,
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
const DIGEST_C = `sha256:${"3".repeat(64)}` as const;
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
    expect(twice.jobs[DIGEST_A]!.stage).toBe("discovered");
    expect(twice.jobs[DIGEST_A]!.disposition).toBe("pending");
    expect(Object.keys(empty.jobs)).toHaveLength(0);
  });

  it("exposes the chain verification stage vocabulary", () => {
    expect([...STAGED_STAGES]).toEqual([
      "discovered",
      "resolving",
      "materializing",
      "probing",
      "comparing",
      "attesting",
      "complete",
    ]);
  });

  it("advances stages forward only", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    file = advanceStagedJob(file, DIGEST_A, "resolving", T1);
    expect(file.jobs[DIGEST_A]!.stage).toBe("resolving");
    file = advanceStagedJob(file, DIGEST_A, "materializing", T1);
    expect(file.jobs[DIGEST_A]!.stage).toBe("materializing");
    expect(() => advanceStagedJob(file, DIGEST_A, "resolving", T1))
      .toThrow(ChainVerificationError);
  });

  it("records an attestation as terminal success", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    file = advanceStagedJob(file, DIGEST_A, "attesting", T1);
    file = recordStagedAttested(file, DIGEST_A, DIGEST_B, T1);
    expect(file.jobs[DIGEST_A]!.stage).toBe("complete");
    expect(file.jobs[DIGEST_A]!.disposition).toBe("attested");
    expect(file.jobs[DIGEST_A]!.attestationDigest).toBe(DIGEST_B);
    expect(dueStagedJobs(file, T1)).toHaveLength(0);
  });

  it("retries infrastructure failures up to the cap, then parks them", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    for (let attempt = 1; attempt < MAX_INFRASTRUCTURE_ATTEMPTS; attempt += 1) {
      file = recordStagedFailure(file, DIGEST_A, "materializer-failed", T0, 60_000);
      expect(file.jobs[DIGEST_A]!.disposition).toBe("retrying");
      expect(file.jobs[DIGEST_A]!.attempts).toBe(attempt);
      expect(file.jobs[DIGEST_A]!.nextAttemptAt).toBeDefined();
    }
    file = recordStagedFailure(
      file,
      DIGEST_A,
      "materializer-failed",
      T0,
      60_000,
      DIGEST_C,
    );
    expect(file.jobs[DIGEST_A]!.disposition).toBe("failed_infrastructure");
    expect(file.jobs[DIGEST_A]!.nextAttemptAt).toBeUndefined();
    expect(file.jobs[DIGEST_A]!.attestationDigest).toBe(DIGEST_C);
    expect(outcomeForFailureReason("materializer-failed"))
      .toBe("verification-infrastructure-failure");
  });

  it("parks quarantined and terminal policy failures immediately", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A, DIGEST_B], T0);
    file = recordStagedFailure(
      file,
      DIGEST_A,
      "probe-observation-divergence",
      T0,
      60_000,
      DIGEST_B,
    );
    file = recordStagedFailure(
      file,
      DIGEST_B,
      "resource-digest-mismatch",
      T0,
      60_000,
      DIGEST_C,
    );
    expect(file.jobs[DIGEST_A]!.disposition).toBe("quarantined");
    expect(file.jobs[DIGEST_B]!.disposition).toBe("terminal_policy");
    expect(dueStagedJobs(file, T1)).toHaveLength(0);
  });

  it("records the digest of the attestation every terminal disposition published", () => {
    const cases = [
      { reason: "probe-observation-divergence" as const, disposition: "quarantined" as const },
      { reason: "anchor-root-mismatch" as const, disposition: "awaiting_input" as const },
      { reason: "resource-digest-mismatch" as const, disposition: "terminal_policy" as const },
    ];
    for (const { reason, disposition } of cases) {
      let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
      file = recordStagedFailure(file, DIGEST_A, reason, T1, 60_000, DIGEST_B);
      expect(file.jobs[DIGEST_A]!.disposition).toBe(disposition);
      expect(file.jobs[DIGEST_A]!.attestationDigest).toBe(DIGEST_B);
    }

    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    for (let attempt = 0; attempt < MAX_INFRASTRUCTURE_ATTEMPTS - 1; attempt += 1) {
      file = recordStagedFailure(file, DIGEST_A, "materializer-failed", T0, 60_000);
    }
    file = recordStagedFailure(file, DIGEST_A, "materializer-failed", T1, 60_000, DIGEST_B);
    expect(file.jobs[DIGEST_A]!.disposition).toBe("failed_infrastructure");
    expect(file.jobs[DIGEST_A]!.attestationDigest).toBe(DIGEST_B);
  });

  it("attaches no attestation digest to a job that is still retrying", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    file = recordStagedFailure(file, DIGEST_A, "materializer-failed", T0, 60_000, DIGEST_B);
    expect(file.jobs[DIGEST_A]!.disposition).toBe("retrying");
    expect(file.jobs[DIGEST_A]!.attestationDigest).toBeUndefined();
  });

  it("refuses a timestamp that is not an RFC 3339 UTC instant", () => {
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    expect(() => createStagedStateFile("yesterday")).toThrow(ChainVerificationError);
    expect(() => upsertStagedJobs(file, [DIGEST_B], "2026-07-31 09:00:00"))
      .toThrow(ChainVerificationError);
    expect(() => advanceStagedJob(file, DIGEST_A, "resolving", "2026-02-30T09:00:00.000Z"))
      .toThrow(ChainVerificationError);
    expect(() => dueStagedJobs(file, "soon")).toThrow(ChainVerificationError);
    expect(() => parseStagedStateFile(serializeStagedStateFile({
      ...file,
      jobs: { [DIGEST_A]: { ...file.jobs[DIGEST_A]!, createdAt: "soon" } },
    }))).toThrow(ChainVerificationError);
  });

  it("orders due jobs by key and honors the retry fence", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_B, DIGEST_A], T0);
    expect(dueStagedJobs(file, T0).map((job) => job.key)).toEqual([DIGEST_A, DIGEST_B]);
    file = recordStagedFailure(file, DIGEST_A, "materializer-failed", T0, 600_000);
    expect(dueStagedJobs(file, T1).map((job) => job.key)).toEqual([DIGEST_B]);
    expect(dueStagedJobs(file, "2026-07-31T09:20:00.000Z").map((job) => job.key))
      .toEqual([DIGEST_A, DIGEST_B]);
  });

  it("round-trips through canonical bytes and refuses a corrupt file", () => {
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    const bytes = serializeStagedStateFile(file);
    expect(parseStagedStateFile(bytes)).toEqual(file);
    expect(serializeStagedStateFile(parseStagedStateFile(bytes))).toEqual(bytes);
    expect(() => parseStagedStateFile(new TextEncoder().encode('{"jobs":')))
      .toThrow(ChainVerificationError);
    expect(() => parseStagedStateFile(new TextEncoder().encode('{"schemaVersion":"nope"}')))
      .toThrow(ChainVerificationError);
  });
});
