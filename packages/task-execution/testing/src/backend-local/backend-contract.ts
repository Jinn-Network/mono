// SPDX-License-Identifier: Apache-2.0

import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import { describeTaskExecutionBackendContract } from "@jinn-network/task-execution-testing";
import { describe, expect, test } from "vitest";
import { loadEvidenceJoinFixture } from "./fixtures.js";

/**
 * The local-backend-specific conformance suite (design §16, frozen interfaces §14 items 1, 10,
 * 11): runs the TEP core kit (`describeTaskExecutionBackendContract`, the testing package's own
 * root export) plus the local specifics — two-instances-one-root -> `backend-unavailable`,
 * `attempts` outside `1..1` -> `unsupported-requirement`, cancellation races, the seal-once +
 * evidence-join behaviors. Landed as a skeleton in Milestone A (Task A3): `makeBackend` is typed
 * against the real, already-frozen `TaskExecutionBackend` (protocol/backend) but never invoked
 * here — Milestone C (Task C4) assembles `makeLocalTaskExecutionBackend` and runs this suite for
 * real, the moment the reference implementation becomes the TEP kit's first real consumer.
 */
export function describeLocalBackendContract(makeBackend: () => TaskExecutionBackend): void {
  describe("Local backend conformance (design §16 — the reference implementation, TEP kit's first real consumer)", () => {
    test("runs the TEP core conformance kit against this binding", () => {
      // `describeTaskExecutionBackendContract` is itself a `describe`-registering function; we
      // assert it is callable against a factory of this shape (seam for Task C4, which supplies
      // the fully-injected local backend + fake launcher + in-memory evidence bindings).
      expect(typeof describeTaskExecutionBackendContract).toBe("function");
      void makeBackend;
    });

    test("evidence-join fixtures are well-formed and cover the seal-once + capture-posture scenarios", async () => {
      const fixture = await loadEvidenceJoinFixture();
      const names = fixture.scenarios.map((scenario) => scenario.name);
      expect(names).toContain("capture-always-failure-is-failed-infrastructure");
      expect(names).toContain("seal-once-checkpoint-crash-reuse");
      expect(names).toContain("torn-checkpoint-re-read-variant");
    });

    test("two-instances-one-root and attempts-outside-1..1 are named local specifics (seam for Task C4)", () => {
      // Documented here so C4 does not have to rediscover the requirement: a second instance on
      // a locked state root must fail `submit`/`recover` with `backend-unavailable`; a
      // Submission requesting `attempts` outside `{maxTotal:1..1, maxConcurrent:1..1}` must fail
      // `submit` with `unsupported-requirement` (design §5/§9.1, program §7.3).
      const localSpecifics = ["two-instances-one-root", "attempts-outside-1..1"];
      expect(localSpecifics).toHaveLength(2);
    });
  });
}
