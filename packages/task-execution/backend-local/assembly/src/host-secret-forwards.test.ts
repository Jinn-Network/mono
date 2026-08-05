import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeHostSecretForwards } from "./host-secret-forwards.js";

const ATTEMPT = {
  attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000701",
  nonce: "host-secret",
  attemptNumber: 1,
} as const;
const TASK_DIGEST = `sha256:${"7".repeat(64)}` as const;

describe("materializeHostSecretForwards", () => {
  it("materializes host-owned evaluator authority without a Submission capability grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-secret-forward-"));
    const secrets = join(root, "secrets");
    await mkdir(root, { recursive: true });
    const resolved = new Uint8Array([11, 22, 33, 44]);

    await materializeHostSecretForwards({
      authorization: {
        attempt: ATTEMPT,
        launcherId: "evaluation-harness",
        taskDigest: TASK_DIGEST,
        submission: "urn:uuid:00000000-0000-4000-8000-000000000702",
        submissionDigest: `sha256:${"8".repeat(64)}`,
        taskProfile: "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
        deadline: "2026-08-02T12:00:00.000Z",
      },
      secrets,
      forwards: [{
        handle: "verdict-key",
        target: "verdict-key.pem",
        role: "evaluator",
        evaluator: "urn:jinn:evaluator:golden",
        registrationId: "prediction-golden",
        evaluationMethodDigest: `sha256:${"9".repeat(64)}`,
      }],
      resolver: {
        async resolve(input) {
          expect(input).toMatchObject({
            attempt: ATTEMPT,
            launcherId: "evaluation-harness",
            taskDigest: TASK_DIGEST,
            role: "evaluator",
            evaluator: "urn:jinn:evaluator:golden",
            handle: "verdict-key",
            registrationId: "prediction-golden",
            evaluationMethodDigest: `sha256:${"9".repeat(64)}`,
          });
          return resolved;
        },
      },
    });

    expect([...await readFile(join(secrets, "verdict-key.pem"))]).toEqual([11, 22, 33, 44]);
    expect((await stat(join(secrets, "verdict-key.pem"))).mode & 0o777).toBe(0o600);
    expect([...resolved]).toEqual([0, 0, 0, 0]);
  });

  it("does not resolve authority after cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-secret-cancel-"));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let resolved = false;

    await expect(materializeHostSecretForwards({
      authorization: {
        attempt: ATTEMPT,
        launcherId: "evaluation-harness",
        taskDigest: TASK_DIGEST,
        submission: "urn:uuid:00000000-0000-4000-8000-000000000702",
        submissionDigest: `sha256:${"8".repeat(64)}`,
        taskProfile: "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
        deadline: "2026-08-02T12:00:00.000Z",
      },
      secrets: join(root, "secrets"),
      forwards: [{
        handle: "verdict-key",
        target: "verdict-key.pem",
        role: "evaluator",
        evaluator: "urn:jinn:evaluator:golden",
        registrationId: "prediction-golden",
        evaluationMethodDigest: `sha256:${"9".repeat(64)}`,
      }],
      resolver: {
        async resolve() {
          resolved = true;
          return new Uint8Array([1]);
        },
      },
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/);
    expect(resolved).toBe(false);
  });

  it("removes every materialized file when a later host resolution fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-secret-partial-"));
    const secrets = join(root, "secrets");
    let calls = 0;
    await expect(materializeHostSecretForwards({
      authorization: {
        attempt: ATTEMPT,
        launcherId: "evaluation-harness",
        taskDigest: TASK_DIGEST,
        submission: "urn:uuid:00000000-0000-4000-8000-000000000702",
        submissionDigest: `sha256:${"8".repeat(64)}`,
        taskProfile: "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
        deadline: "2026-08-02T12:00:00.000Z",
      },
      secrets,
      forwards: ["first", "second"].map((handle) => ({
        handle,
        target: `${handle}.pem`,
        role: "evaluator" as const,
        evaluator: "urn:jinn:evaluator:golden",
        registrationId: `prediction-${handle}`,
        evaluationMethodDigest: `sha256:${"9".repeat(64)}` as const,
      })),
      resolver: {
        async resolve() {
          calls += 1;
          if (calls === 2) throw new Error("second resolution failed");
          return new Uint8Array([1, 2, 3]);
        },
      },
    })).rejects.toThrow("second resolution failed");
    await expect(stat(secrets)).rejects.toThrow();
  });
});
