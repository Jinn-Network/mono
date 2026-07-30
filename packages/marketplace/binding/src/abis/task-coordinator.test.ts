// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TASK_COORDINATOR_ABI } from "./task-coordinator.js";
import { expect, test } from "vitest";

type AbiValue = {
  readonly type: string;
  readonly name?: string;
  readonly indexed?: boolean;
  readonly components?: readonly AbiValue[];
};
type AbiItem = AbiValue & {
  readonly inputs?: readonly AbiValue[];
  readonly outputs?: readonly AbiValue[];
  readonly stateMutability?: string;
};

function exactAbiValue(value: AbiValue): AbiValue {
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    type: value.type,
    ...(value.indexed === undefined ? {} : { indexed: value.indexed }),
    ...(value.components === undefined
      ? {}
      : { components: value.components.map(exactAbiValue) }),
  };
}

function exactAbiItem(item: AbiItem): AbiItem {
  return {
    type: item.type,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.inputs === undefined ? {} : { inputs: item.inputs.map(exactAbiValue) }),
    ...(item.outputs === undefined ? {} : { outputs: item.outputs.map(exactAbiValue) }),
    ...(item.stateMutability === undefined ? {} : { stateMutability: item.stateMutability }),
  };
}

function publicSlice(abi: readonly AbiItem[]): AbiItem[] {
  const names = new Set(["getTask", "getAttempt", "TaskCreated", "TaskClaimed"]);
  return abi
    .filter((entry) => entry.name !== undefined && names.has(entry.name))
    .map(exactAbiItem);
}

test("today TaskCoordinator ABI is the exact compiled artifact public slice", () => {
  const artifact = JSON.parse(readFileSync(resolve(
    process.cwd(),
    "../../../contracts/artifacts/src/tasks/TaskCoordinator.sol/TaskCoordinator.json",
  ), "utf8")) as { readonly abi: readonly AbiItem[] };
  expect(TASK_COORDINATOR_ABI).toEqual(publicSlice(artifact.abi));
});
