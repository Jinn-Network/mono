import { describe, expect, test } from "vitest";
import { baseEnv, loadoutPath } from "./planning.js";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";

const paths = { input: "/attempt/input" } as WorkspacePaths;

function view(loadout: unknown): TaskView {
  return { effectiveRequirements: { loadout } } as unknown as TaskView;
}

describe("loadoutPath", () => {
  test("returns only the canonical contained path for a digest-pinned loadout", () => {
    expect(loadoutPath(view({
      kind: "jinn.skill.v1",
      name: "review-skill",
      digest: { sha256: "a".repeat(64) },
    }), paths)).toBe("/attempt/input/review-skill");
  });

  test.each(["../secrets/key", "/etc/passwd", "", ".", "nested/loadout"])(
    "rejects an escaping or noncanonical loadout name %j",
    (name) => {
      expect(() => loadoutPath(view({
        kind: "jinn.skill.v1", name, digest: { sha256: "a".repeat(64) },
      }), paths)).toThrow("contained");
    },
  );
});

describe("baseEnv", () => {
  // `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows, and Python's `tempfile` consults
  // all three everywhere. Pinning only the POSIX name sends a child that reads either of the other
  // two to the platform default, outside the attempt directory the backend collects and sweeps.
  test("pins all three temp names at the attempt tmp directory", () => {
    const env = baseEnv(
      { input: "/attempt/input", out: "/attempt/out", logs: "/attempt/logs", meta: "/attempt/meta", tmp: "/attempt/tmp" } as WorkspacePaths,
      { attemptUri: "urn:jinn:attempt:test", nonce: "n", attemptNumber: 1 } as unknown as AttemptIdentity,
    );
    expect(env.TMPDIR).toBe("/attempt/tmp");
    expect(env.TMP).toBe("/attempt/tmp");
    expect(env.TEMP).toBe("/attempt/tmp");
  });
});
