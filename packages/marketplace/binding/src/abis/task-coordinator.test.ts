// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pickAbiItems, normalizeAbiItem, type AbiItem } from "@jinn-network/contract-abis/pick";
import { TASK_COORDINATOR_ABI } from "./task-coordinator.js";
import { expect, test } from "vitest";

function normalizedArtifactSlice(relativePath: string, names: readonly string[]): readonly AbiItem[] {
  const artifact = JSON.parse(readFileSync(resolve(
    process.cwd(),
    "../../../contracts/artifacts",
    relativePath,
  ), "utf8")) as { readonly abi: readonly AbiItem[] };
  return pickAbiItems(artifact.abi.map(normalizeAbiItem), names);
}

test("today TaskCoordinator ABI is the exact compiled artifact public slice", () => {
  expect(TASK_COORDINATOR_ABI).toEqual(normalizedArtifactSlice(
    "src/tasks/TaskCoordinator.sol/TaskCoordinator.json",
    ["TaskClaimed", "TaskCreated", "getAttempt", "getTask"],
  ));
});
