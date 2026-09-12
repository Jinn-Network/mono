// SPDX-License-Identifier: MIT

// Compares the exported V4 slice against the *compiled Hardhat artifact*, not against
// `@jinn-network/contract-abis`' committed `generated/` tree. Comparing against `generated/` is
// tautological: both sides would derive from one committed input through the same `pickAbiItems`.
// Deriving the name list from the slice is tautological for the same reason -- the list is pinned
// literally so that dropping an item reddens this test. `contracts/artifacts/` is gitignored and
// absent locally; `marketplace-ci.yml` compiles contracts before this job, which is why the three
// sibling tests in this directory read it the same way.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pickAbiItems, normalizeAbiItem, type AbiItem } from "@jinn-network/contract-abis/pick";
import { JINN_ROUTER_V4_ABI } from "./revised-contracts.js";
import { expect, test } from "vitest";

function normalizedArtifactSlice(relativePath: string, names: readonly string[]): readonly AbiItem[] {
  const artifact = JSON.parse(readFileSync(resolve(
    process.cwd(),
    "../../../contracts/artifacts",
    relativePath,
  ), "utf8")) as { readonly abi: readonly AbiItem[] };
  return pickAbiItems(artifact.abi.map(normalizeAbiItem), names);
}

test("revised binding router functions exactly match the compiled V4 artifact", () => {
  expect(JINN_ROUTER_V4_ABI).toEqual(normalizedArtifactSlice(
    "src/staking/JinnRouterV4.sol/JinnRouterV4.json",
    [
      "claimTask",
      "claimEvaluation",
      "prepareSolutionDelivery",
      "prepareVerdictDelivery",
      "releaseAttempt",
      "releaseVerdict",
      "forfeitDeliveredReservation",
      "closeTask",
      "claimSolutionDelivery",
      "claimVerdictDelivery",
      "solutionReservations",
      "tokenPaymentType",
    ],
  ));
});
