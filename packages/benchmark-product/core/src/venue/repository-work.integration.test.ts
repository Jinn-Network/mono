/**
 * The repository-work solve leg on the real local venue (P1 acceptance 1, 2 and 5): a
 * repository-work Task resolves, selects the worktree provisioner, dispatches to the hermetic
 * `sample-repository-work` arm, and delivers the profile's declared `patch` output typed
 * `text/x-diff`.
 *
 * The Task is built here rather than imported through `convertSweBenchRows` on purpose: C4's
 * P0-interop packet is changing the importer's sealed output, and this test must not be coupled
 * to a digest that is about to move.
 *
 * The EVALUATION leg is deliberately absent -- container grading is P3. This file proves the
 * solve leg only, which is exactly the dispatch boundary P1 claims.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRepositoryWorkProfile,
  REPOSITORY_WORK_PROFILE_URI,
  sealTaskProfile,
} from "@jinn-network/task-execution-profiles";
import { sealSubmission, sealTask, TASK_EXECUTION_PROTOCOL_URI } from "@jinn-network/task-execution-protocol";
import { createLocalVenue, SOLVE_HARNESS_PINS, VENUE_ISOLATION_POLICY } from "./venue.js";
import { sha256Hex } from "../workspace/sealed-store.js";

const NOW = () => "2026-01-01T00:00:00Z";
const FAR_FUTURE_DEADLINE = "2099-01-01T00:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

function makeUpstream(): { uri: string; oid: string } {
  const dir = mkdtempSync(join(tmpdir(), "repository-work-upstream-"));
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "upstream\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "--quiet", "-m", "initial");
  return { uri: `file://${dir}`, oid: git(dir, "rev-parse", "HEAD") };
}

function sealRepositoryWorkTask(upstream: { uri: string; oid: string }): { bytes: Uint8Array; sha256: string } {
  const profile = buildRepositoryWorkProfile();
  const profileDigest = sealTaskProfile(profile).digest;
  const bytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: { uri: REPOSITORY_WORK_PROFILE_URI, digest: { sha256: profileDigest.replace(/^sha256:/u, "") } },
    instructions: "Append the marker line to the repository's first file.",
    payload: {
      instance_id: "demo__demo-1",
      language: "python",
      provenance: { kind: "mined", source: upstream.uri, timestamp: "2026-01-01T00:00:00Z" },
    },
    inputs: [{ name: "repository-state", uri: upstream.uri, annotations: { ref: upstream.oid } }],
    outputs: profile.outputConventions.slots.map((slot) => ({
      name: slot.name, mediaType: slot.mediaType, required: slot.required,
    })),
  });
  return { bytes, sha256: sha256Hex(bytes) };
}

/** Mirrors `venue.integration.test.ts`'s `submissionFor`: a real sealed Submission, not raw JSON. */
function submissionFor(input: {
  readonly taskSha256: string;
  readonly requirements: Record<string, unknown>;
}): Uint8Array {
  return sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: `urn:uuid:${randomUUID()}`,
    task: { digest: { sha256: input.taskSha256 } },
    requester: `urn:uuid:${randomUUID()}`,
    idempotencyKey: randomUUID(),
    nonce: randomUUID(),
    deadline: FAR_FUTURE_DEADLINE,
    requirements: input.requirements,
  });
}

describe("repository-work solve leg on the local venue", () => {
  it(
    "dispatches, executes against the materialized worktree, and delivers a typed patch",
    async () => {
      const upstream = makeUpstream();
      const workspaceDir = mkdtempSync(join(tmpdir(), "repository-work-venue-"));
      mkdirSync(join(workspaceDir, "venue"), { recursive: true });
      const venue = createLocalVenue({ workspaceDir, now: NOW });

      try {
        await venue.preflightRun!();

        const task = sealRepositoryWorkTask(upstream);
        const submissionBytes = submissionFor({
          taskSha256: task.sha256,
          requirements: {
            harness: SOLVE_HARNESS_PINS["sample-repository-work"],
            isolationPolicy: VENUE_ISOLATION_POLICY,
          },
        });

        const ack = await venue.backend.submit(task.bytes, submissionBytes);
        expect(ack.accepted, JSON.stringify(ack)).toBe(true);
        if (!ack.accepted) throw new Error("unreachable");
        await venue.backend.drain();

        const snapshot = await venue.backend.observe(ack.submission);
        expect(snapshot.descriptor.derived, JSON.stringify(snapshot.observations)).toMatchObject({
          state: "delivered",
          terminal: true,
        });

        const deliveries = await venue.backend.deliveries(snapshot.descriptor.attempt);
        expect(deliveries).toHaveLength(1);

        const deliveryBytes = await venue.backend.fetchDelivery(deliveries[0]!);
        const delivery = JSON.parse(new TextDecoder().decode(deliveryBytes)) as {
          readonly outputs: readonly { readonly name?: string; readonly path?: string; readonly mediaType?: string }[];
        };

        // Exactly the profile's declared slots survive harvest, and `patch` carries its declared type.
        const paths = delivery.outputs.map((output) => output.path ?? output.name);
        expect(paths).toEqual(["patch"]);
        expect(delivery.outputs[0]!.mediaType).toBe("text/x-diff");
      } finally {
        await venue.shutdown();
      }
    },
    120_000,
  );
});
