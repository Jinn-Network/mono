import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pickAbiItems, normalizeAbiItem, type AbiItem } from "@jinn-network/contract-abis/pick";
import { MECH_MARKETPLACE_ABI, MECH_OPERATOR_ABI } from "./mech-marketplace.js";

function normalizedArtifactSlice(relativePath: string, names: readonly string[]): readonly AbiItem[] {
  const artifact = JSON.parse(readFileSync(resolve(
    process.cwd(),
    "../../../contracts/artifacts",
    relativePath,
  ), "utf8")) as { readonly abi: readonly AbiItem[] };
  return pickAbiItems(artifact.abi.map(normalizeAbiItem), names);
}

describe("Mech marketplace authorization reads", () => {
  it("exposes the deployed marketplace registration and Mech operator getters", () => {
    const [mapAgentMechFactories] = normalizedArtifactSlice(
      "src/vendor/mech/MechMarketplace.sol/MechMarketplace.json",
      ["mapAgentMechFactories"],
    );
    expect(MECH_MARKETPLACE_ABI).toContainEqual(mapAgentMechFactories);

    const [getOperator] = normalizedArtifactSlice(
      "src/vendor/mech/OlasMech.sol/OlasMech.json",
      ["getOperator"],
    );
    expect(MECH_OPERATOR_ABI).toEqual([getOperator]);
  });
});
