import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pickAbiItems, normalizeAbiItem, type AbiItem } from "@jinn-network/contract-abis/pick";
import { JINN_ROUTER_V3_ABI } from "./jinn-router-v3.js";

function normalizedArtifactSlice(relativePath: string, names: readonly string[]): readonly AbiItem[] {
  const artifact = JSON.parse(readFileSync(resolve(
    process.cwd(),
    "../../../contracts/artifacts",
    relativePath,
  ), "utf8")) as { readonly abi: readonly AbiItem[] };
  return pickAbiItems(artifact.abi.map(normalizeAbiItem), names);
}

describe("JINN_ROUTER_V3_ABI canonical reads", () => {
  it("exposes the deployed taskPayments getter used to reconstitute exact posting terms", () => {
    const [taskPayments] = normalizedArtifactSlice(
      "src/staking/JinnRouterV3.sol/JinnRouterV3.json",
      ["taskPayments"],
    );
    expect(JINN_ROUTER_V3_ABI.find((entry) =>
      entry.type === "function" && entry.name === "taskPayments")).toEqual(taskPayments);
  });
});
