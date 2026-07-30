import { describe, expect, test } from "vitest";
import { loadoutPath } from "./planning.js";
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
