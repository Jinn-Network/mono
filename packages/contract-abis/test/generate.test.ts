import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pickAbiItems, normalizeAbiItem } from "../src/pick.js";
import { JINN_ROUTER_V3_ABI } from "../src/binding.js";
import { JINN_ROUTER_ABI as INDEXER_JINN_ROUTER_ABI } from "../src/indexer.js";
import { JINN_ROUTER_ABI as OPERATOR_JINN_ROUTER_ABI } from "../src/operator.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("generated full ABIs", () => {
  it("includes JinnRouterV3 createTask from compiled artifacts", () => {
    const full = JSON.parse(
      readFileSync(join(packageRoot, "generated/full/JinnRouterV3.json"), "utf8"),
    );
    const createTask = full.find(
      (entry: { type?: string; name?: string }) =>
        entry.type === "function" && entry.name === "createTask",
    );
    expect(createTask).toBeDefined();
    expect(createTask.stateMutability).toBe("payable");
  });
});

describe("pickAbiItems", () => {
  it("preserves manifest item order, not artifact sort order", () => {
    const full = JSON.parse(
      readFileSync(join(packageRoot, "generated/full/JinnRouterV3.json"), "utf8"),
    );
    const picked = pickAbiItems(full, ["TaskCreated", "createTask", "claimed"]);
    expect(picked.map((item) => item.name)).toEqual(["TaskCreated", "createTask", "claimed"]);
  });
});

describe("consumer slices", () => {
  it("binding JINN_ROUTER_V3_ABI exposes taskPayments getter", () => {
    expect(
      JINN_ROUTER_V3_ABI.find((entry) => entry.type === "function" && entry.name === "taskPayments"),
    ).toMatchObject({
      type: "function",
      name: "taskPayments",
      stateMutability: "view",
    });
  });

  it("indexer and operator router slices are subsets of the compiled artifact", () => {
    const full = JSON.parse(
      readFileSync(join(packageRoot, "generated/full/JinnRouterV3.json"), "utf8"),
    ).map(normalizeAbiItem);
    for (const slice of [INDEXER_JINN_ROUTER_ABI, OPERATOR_JINN_ROUTER_ABI]) {
      for (const item of slice) {
        const artifactItem = full.find((entry) => entry.name === item.name);
        expect(artifactItem, `missing ${item.name}`).toEqual(item);
      }
    }
  });
});
