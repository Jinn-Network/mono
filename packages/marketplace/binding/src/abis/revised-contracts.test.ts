// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { JINN_ROUTER_V4_ABI } from "./revised-contracts.js";

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
    ...(item.stateMutability === undefined
      ? {}
      : { stateMutability: item.stateMutability }),
  };
}

function artifactAbi(path: string): readonly AbiItem[] {
  const artifact = JSON.parse(readFileSync(resolve(
    process.cwd(),
    `../../../contracts/artifacts/${path}`,
  ), "utf8")) as { readonly abi: readonly AbiItem[] };
  return artifact.abi;
}

function exactNamedSlice(
  abi: readonly AbiItem[],
  names: readonly string[],
): AbiItem[] {
  const selected = new Set(names);
  return abi
    .filter((entry) => entry.name !== undefined && selected.has(entry.name))
    .map(exactAbiItem)
    .sort((left, right) =>
      `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
    );
}

test("revised binding router functions exactly match the compiled V4 artifact", () => {
  const names = JINN_ROUTER_V4_ABI.map((entry) => entry.name);
  expect([...JINN_ROUTER_V4_ABI].sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
  )).toEqual(exactNamedSlice(
    artifactAbi("src/staking/JinnRouterV4.sol/JinnRouterV4.json"),
    names,
  ));
});
