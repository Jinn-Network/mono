// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  HARNESS_STATE_LOADOUT_KIND,
  LEARNER_PUBLIC_V1_ALLOWED_DIRS,
  LEARNER_PUBLIC_V1_ALLOWED_FILES,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import {
  classifiedRoots,
  classifyPayload,
  isHostilePayloadClass,
  payloadClassRank,
} from "./payload-class.js";
import { HOSTILE_PAYLOAD_CLASSES, PAYLOAD_CLASSES } from "../tokens.js";
import { HOOK_BEARING_TREE, PARENT_TREE } from "../testing/admission-fixtures.js";

const kind = HARNESS_STATE_LOADOUT_KIND;

describe("the §7.4 gradient", () => {
  it("ranks in the design's stated order", () => {
    expect(PAYLOAD_CLASSES).toEqual(["prompt", "skill", "hook-or-tool-config", "harness-code"]);
    expect(payloadClassRank("prompt")).toBeLessThan(payloadClassRank("skill"));
    expect(payloadClassRank("skill")).toBeLessThan(payloadClassRank("hook-or-tool-config"));
    expect(payloadClassRank("hook-or-tool-config")).toBeLessThan(payloadClassRank("harness-code"));
  });

  it("marks the tail of the gradient hostile and nothing else", () => {
    expect(PAYLOAD_CLASSES.filter(isHostilePayloadClass)).toEqual([...HOSTILE_PAYLOAD_CLASSES]);
  });
});

describe("classifyPayload", () => {
  it("covers exactly the learner-public.v1 classification (drift tripwire, F-C7c-4)", () => {
    expect(classifiedRoots()).toEqual(
      [...LEARNER_PUBLIC_V1_ALLOWED_DIRS, ...LEARNER_PUBLIC_V1_ALLOWED_FILES].sort(),
    );
  });

  it("classifies a prompt-and-skill tree as skill, with nothing hostile", () => {
    const result = classifyPayload(PARENT_TREE, kind);
    expect(result.classes).toEqual(["prompt", "skill"]);
    expect(result.highest).toBe("skill");
    expect(result.hostile).toEqual([]);
    expect(result.hostilePaths).toEqual([]);
  });

  it("classifies a hook-bearing tree as hostile and names the path", () => {
    const result = classifyPayload(HOOK_BEARING_TREE, kind);
    expect(result.highest).toBe("hook-or-tool-config");
    expect(result.hostile).toEqual(["hook-or-tool-config"]);
    expect(result.hostilePaths).toEqual(["hooks/post-solve.sh"]);
  });

  it.each([
    ["policy.json", "prompt"],
    ["notes/a.md", "prompt"],
    ["plans/a.md", "prompt"],
    ["runs/a.md", "prompt"],
    [".archive/a.md", "prompt"],
    ["agents/a.md", "skill"],
    ["patterns/a.md", "skill"],
    ["skills/a/SKILL.md", "skill"],
    ["strategies/a.md", "skill"],
    ["configs/a.json", "hook-or-tool-config"],
    ["hooks/a.sh", "hook-or-tool-config"],
    ["tests/a.sh", "hook-or-tool-config"],
    ["tools/a.json", "hook-or-tool-config"],
    ["tunables/a.json", "hook-or-tool-config"],
  ])("classifies %s as %s", (path, expected) => {
    const entries: TreeEntry[] = [{ path, kind: "file", content: "" }];
    expect(classifyPayload(entries, kind).highest).toBe(expected);
  });

  it("classifies an unrecognized loadout kind as harness-code — the proposer brought a runtime", () => {
    const result = classifyPayload(PARENT_TREE, "someone.elses-harness.v1");
    expect(result.highest).toBe("harness-code");
    expect(result.hostilePaths).toContain("loadout.kind=someone.elses-harness.v1");
  });

  it("resolves an unknown root toward the hostile class, not toward prompt", () => {
    const entries: TreeEntry[] = [{ path: "unheard-of/x", kind: "file", content: "" }];
    expect(classifyPayload(entries, kind).highest).toBe("harness-code");
  });

  it("classifies an empty tree as prompt — 'nothing' must not train owners to click through", () => {
    expect(classifyPayload([], kind).highest).toBe("prompt");
  });
});
