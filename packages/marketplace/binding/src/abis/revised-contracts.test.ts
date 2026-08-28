// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { JINN_ROUTER_V4_ABI } from "./revised-contracts.js";
import { pickAbiItems } from "@jinn-network/contract-abis/pick";

// Read the JSON through the package's exports map rather than importing it with
// an import attribute: this tsconfig sets `module: ES2022`, under which
// `with { type: "json" }` is a TS2823 typecheck error (#3121).
const jinnRouterV4Full: readonly unknown[] = JSON.parse(
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
    .filter((name): name is string => name !== undefined);
  expect([...JINN_ROUTER_V4_ABI].sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
  )).toEqual([...pickAbiItems(jinnRouterV4Full, names)].sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
  ));
});
