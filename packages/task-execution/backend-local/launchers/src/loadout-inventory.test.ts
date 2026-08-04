// SPDX-License-Identifier: Apache-2.0

/**
 * Program §1 C5 — launcher loadout-inventory support for `jinn.harness-state.v1`. Every
 * skill-bearing launcher (claude-code, codex, hermes, cursor) declares the new kind alongside
 * the existing `jinn.skill.v1`; `prediction-v1-baseline` has no `loadout` run-pinning key at all
 * and must stay that way (it never runs a harness with impl-state to share).
 */

import { describe, expect, it } from "vitest";
import { claudeCodeLauncher } from "./claude-code.js";
import { codexLauncher } from "./codex.js";
import { hermesLauncher } from "./hermes.js";
import { cursorLauncher } from "./cursor.js";
import { predictionV1BaselineLauncher } from "./prediction-v1-baseline.js";

function loadoutInventory(launcher: { capabilities(): { runPinning: { keys: readonly { key: string; inventory: readonly string[] }[] } } }) {
  return launcher.capabilities().runPinning.keys.find((entry) => entry.key === "loadout")?.inventory;
}

describe("jinn.harness-state.v1 loadout-inventory support", () => {
  it.each([
    ["claude-code", claudeCodeLauncher],
    ["codex", codexLauncher],
    ["hermes", hermesLauncher],
    ["cursor", cursorLauncher],
  ] as const)("%s declares jinn.harness-state.v1 alongside jinn.skill.v1", (_id, launcher) => {
    expect(loadoutInventory(launcher)).toEqual(["jinn.skill.v1", "jinn.harness-state.v1"]);
  });

  it("prediction-v1-baseline declares no loadout run-pinning key at all", () => {
    expect(predictionV1BaselineLauncher.capabilities().runPinning.keys.map((entry) => entry.key))
      .not.toContain("loadout");
    expect(loadoutInventory(predictionV1BaselineLauncher)).toBeUndefined();
  });
});
