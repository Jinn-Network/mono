// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  resolveWiringEntry,
  runPinningConstraint,
  wiringHonorsPinning,
} from "./execution-wiring.js";
import type { ExecutionWiringEntry } from "./types.js";

const WIRING: ExecutionWiringEntry = {
  workKind: "repo-fix",
  harness: "claude-code",
  model: "claude-haiku",
  plugins: ["git", "tests"],
  credentialRef: "cred-1",
  isolationPolicy: "workspace-snapshot",
};

describe("execution wiring", () => {
  test("resolves work-kind entries from the operator wiring table", () => {
    expect(resolveWiringEntry("repo-fix", [WIRING])).toEqual(WIRING);
    expect(resolveWiringEntry("missing", [WIRING])).toBeUndefined();
  });

  test("runPinningConstraint surfaces pinned harness/model/loadout/effort-floor fields", () => {
    expect(runPinningConstraint({})).toEqual({ pinned: false });
    expect(runPinningConstraint({
      runPinning: { harness: "claude-code", effortFloor: 2 },
    })).toEqual({
      pinned: true,
      harness: "claude-code",
      effortFloor: 2,
    });
  });

  test("wiringHonorsPinning declines mismatched harness or model pins", () => {
    expect(wiringHonorsPinning({ runPinning: { harness: "claude-code" } }, WIRING)).toBe(true);
    expect(wiringHonorsPinning({ runPinning: { harness: "codex" } }, WIRING)).toBe(false);
    expect(wiringHonorsPinning({ runPinning: { model: "gpt-4" } }, WIRING)).toBe(false);
    expect(wiringHonorsPinning({ runPinning: { loadout: "tests" } }, WIRING)).toBe(true);
    expect(wiringHonorsPinning({ runPinning: { loadout: "lint" } }, WIRING)).toBe(false);
  });

  test("treats the wiring isolation label as descriptive rather than authority", () => {
    expect(wiringHonorsPinning({
      runPinning: {
        harness: WIRING.harness,
        model: WIRING.model,
        loadout: "tests",
        isolationPolicy: "ephemeral-container",
      },
    }, WIRING)).toBe(true);
    expect(wiringHonorsPinning({
      runPinning: { isolationPolicy: "workspace-snapshot" },
    }, WIRING)).toBe(true);
  });
});
