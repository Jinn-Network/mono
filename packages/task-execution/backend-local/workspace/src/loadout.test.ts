// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canonicalLoadoutPath, canonicalLoadoutPin, LOADOUT_KINDS } from "./loadout.js";

const SKILL_HEX = "a".repeat(64);
const HARNESS_STATE_DIGEST = `sha256:${"b".repeat(64)}`;

describe("LOADOUT_KINDS", () => {
  it("names exactly the two ratified kinds", () => {
    expect([...LOADOUT_KINDS]).toEqual(["jinn.skill.v1", "jinn.harness-state.v1"]);
  });
});

describe("canonicalLoadoutPin — jinn.skill.v1 (unchanged)", () => {
  it("accepts a digest-map bare-hex pin", () => {
    expect(canonicalLoadoutPin({
      kind: "jinn.skill.v1",
      name: "review-skill",
      digest: { sha256: SKILL_HEX },
    })).toEqual({ kind: "jinn.skill.v1", name: "review-skill", digest: SKILL_HEX });
  });

  it("rejects a prefixed digest under the skill.v1 map convention", () => {
    expect(() => canonicalLoadoutPin({
      kind: "jinn.skill.v1",
      name: "review-skill",
      digest: { sha256: `sha256:${SKILL_HEX}` },
    })).toThrow(/unsupported or unpinned loadout/);
  });

  it("rejects a missing digest map", () => {
    expect(() => canonicalLoadoutPin({ kind: "jinn.skill.v1", name: "x" })).toThrow(TypeError);
  });
});

describe("canonicalLoadoutPin — jinn.harness-state.v1 (F9: sha256:-prefixed spelling)", () => {
  it("accepts a prefixed single-string digest", () => {
    expect(canonicalLoadoutPin({
      kind: "jinn.harness-state.v1",
      name: "learner-state",
      digest: HARNESS_STATE_DIGEST,
    })).toEqual({ kind: "jinn.harness-state.v1", name: "learner-state", digest: HARNESS_STATE_DIGEST });
  });

  it("rejects a bare-hex digest (the skill.v1 spelling) for this kind", () => {
    expect(() => canonicalLoadoutPin({
      kind: "jinn.harness-state.v1",
      name: "learner-state",
      digest: "b".repeat(64),
    })).toThrow(/unsupported or unpinned loadout/);
  });

  it("rejects the digest-map shape (the skill.v1 shape) for this kind", () => {
    expect(() => canonicalLoadoutPin({
      kind: "jinn.harness-state.v1",
      name: "learner-state",
      digest: { sha256: "b".repeat(64) },
    })).toThrow(/unsupported or unpinned loadout/);
  });

  it("rejects an uppercase or short hex payload", () => {
    expect(() => canonicalLoadoutPin({
      kind: "jinn.harness-state.v1",
      name: "learner-state",
      digest: `sha256:${"B".repeat(64)}`,
    })).toThrow(TypeError);
    expect(() => canonicalLoadoutPin({
      kind: "jinn.harness-state.v1",
      name: "learner-state",
      digest: "sha256:ab",
    })).toThrow(TypeError);
  });

  it.each(["../secrets/key", "/etc/passwd", "", ".", "..", "nested/loadout"])(
    "rejects an escaping or noncanonical name %j, same as jinn.skill.v1",
    (name) => {
      expect(() => canonicalLoadoutPin({ kind: "jinn.harness-state.v1", name, digest: HARNESS_STATE_DIGEST }))
        .toThrow(/loadout name must be one contained input path/);
    },
  );
});

describe("canonicalLoadoutPin — unknown kind", () => {
  it("fails closed on a kind outside the vocabulary", () => {
    expect(() => canonicalLoadoutPin({
      kind: "jinn.oci-image.v1",
      name: "x",
      digest: HARNESS_STATE_DIGEST,
    })).toThrow(/unsupported or unpinned loadout/);
  });
});

describe("canonicalLoadoutPath", () => {
  it("mounts a jinn.harness-state.v1 loadout at <inputDir>/<name>, same as jinn.skill.v1", () => {
    expect(canonicalLoadoutPath("/attempt/input", {
      kind: "jinn.harness-state.v1",
      name: "learner-state",
      digest: HARNESS_STATE_DIGEST,
    })).toBe("/attempt/input/learner-state");
  });
});
