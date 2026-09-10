// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { JINN_ROUTER_V4_ABI } from "./revised-contracts.js";
import { pickAbiItems, type AbiItem } from "@jinn-network/contract-abis/pick";

// Read the JSON through the package's exports map rather than importing it with
// an import attribute: this tsconfig sets `module: ES2022`, under which
// `with { type: "json" }` is a TS2823 typecheck error (#3121).
const jinnRouterV4Full: readonly AbiItem[] = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve(
      "@jinn-network/contract-abis/generated/full/JinnRouterV4.json",
    ),
    "utf8",
  ),
);

test("revised binding router functions exactly match the compiled V4 artifact", () => {
  const names = JINN_ROUTER_V4_ABI
    .map((entry) => entry.name)
    // Not `(name): name is string` -- the ABI is `as const`, so `entry.name` is a
    // literal union and a `string` predicate is not assignable to it (TS2677).
    .filter((name) => name !== undefined);
  expect([...JINN_ROUTER_V4_ABI].sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
  )).toEqual([...pickAbiItems(jinnRouterV4Full, names)].sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
  ));
});
